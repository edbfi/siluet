import { fileUploadRoutes } from "../../../shared/image-studio/file-edit";
import { buildSeedreamRequest } from "../../../shared/image-studio/seedream";
import {
	fileAttemptStore,
	startFileEdit,
	startFileUpload,
	undoFileEdit,
	undoFileUpload,
} from "../../db/file-attempt";
import { type ImageJob, imageJobStore } from "../../db/image-job-store";
import type { Installation } from "../../db/installation";
import {
	nextPoyoUploadStart,
	recordPoyoUploadStart,
	undoPoyoUploadStart,
} from "../../db/poyo-upload-window";
import { guardFilePost, pinFilePost } from "../../providers/file-post";
import { createPoyoImage } from "../../providers/poyo/image";
import { submitRetryAt } from "../queue/submit-gate";
import type { FileRequest } from "./request";
import { fileSendBoundary, recordEditCooldown } from "./send-boundary";
import { sendFileEdit, uploadFile } from "./transfer";

type SendStop = { reason: "interrupted" | "expired-link" } | { reason: "cooldown"; until: number };
export type FileBuffer = { bytes: Uint8Array<ArrayBuffer>; release: () => void };
export function fileDispatcher(
	db: Installation,
	owner: string,
	schedule: (job: ImageJob) => void,
	{
		upload = uploadFile,
		edit = sendFileEdit,
		balance = createPoyoImage().balance,
		now = Date.now,
		random = Math.random,
		pin = pinFilePost,
	} = {},
) {
	const phases = fileAttemptStore(db, owner);
	const jobs = imageJobStore(db);
	return async (id: string, key: string, live: FileRequest, held: FileBuffer) => {
		const provider = live.input.provider;
		const finishWallet = async (job: ImageJob | undefined) => {
			if (!job?.wallet_open) return;
			const readable = await jobs.canReadFileWallet(id, owner, now());
			const after = readable ? await balance(key).catch(() => null) : null;
			await jobs.finishWallet(id, after, now(), owner);
		};
		let uploaded: Awaited<ReturnType<typeof uploadFile>>;
		try {
			if (!(await jobs.beginDispatch(id, provider, now(), owner))) return;
			if (provider === "poyo")
				await jobs.recordBefore(id, await balance(key).catch(() => null), now());
			const read = await pin(fileUploadRoutes[provider], 60_000).catch(() => null);
			if (!read) {
				await phases.stop(id, { stop: "destination", slot: 1 }, now());
				return;
			}
			const guard = guardFilePost(read);
			let uploadStart: number | undefined;
			const handoff = await fileSendBoundary<Awaited<ReturnType<typeof upload>>, SendStop>(
				db,
				provider,
				"upload",
				now,
				async (tx, time) => {
					if (provider === "poyo") {
						const until = await nextPoyoUploadStart(tx, time);
						if (until > time) return { reason: "cooldown", until };
					}
					if (!(await startFileUpload(tx, id, owner, 1, time))) return { reason: "interrupted" };
					if (provider === "poyo") uploadStart = await recordPoyoUploadStart(tx, time);
				},
				() => upload(provider, key, live.stage, held.bytes, guard.read),
				{
					check: guard.check,
					undo: async (tx, time) => {
						await undoFileUpload(tx, id, owner, 1, time);
						if (uploadStart !== undefined) await undoPoyoUploadStart(tx, uploadStart, time);
					},
				},
			);
			if (handoff.stop) {
				const { reason } = handoff.stop;
				const until = reason === "cooldown" ? handoff.stop.until : null;
				await phases.stop(id, { stop: reason, slot: 1, until }, now());
				return;
			}
			uploaded = await handoff.receipt.catch(() => ({ kind: "unknown" }) as const);
		} finally {
			held.release();
		}
		if (uploaded.kind !== "ready") {
			const job = await phases.stop(
				id,
				uploaded.kind === "unknown"
					? { outcome: "unknown" }
					: uploaded.kind === "stored"
						? { outcome: "unusable", stop: "unusable", slot: 1 }
						: { outcome: "rejected", rejection: uploaded.reason },
				now(),
			);
			if (job?.state !== "unknown") await finishWallet(job);
			return;
		}
		if (!(await phases.stored(id, 1, now()))) return;
		const request = buildSeedreamRequest(live.input, () => uploaded.url);
		const read = await pin(request.url, 30_000).catch(() => null);
		if (!read) {
			await finishWallet(await phases.stop(id, { stop: "destination" }, now()));
			return;
		}
		const guard = guardFilePost(read, () =>
			uploaded.expiresAt !== undefined && now() >= uploaded.expiresAt
				? { reason: "expired-link" as const }
				: undefined,
		);
		const handoff = await fileSendBoundary<Awaited<ReturnType<typeof edit>>, SendStop>(
			db,
			provider,
			"edit",
			now,
			async (tx, time) => {
				if (!(await startFileEdit(tx, id, owner, time))) return { reason: "interrupted" } as const;
			},
			() => edit(provider, key, request, guard.read),
			{
				check: guard.check,
				undo: (tx, time) => undoFileEdit(tx, id, owner, time),
			},
		);
		if (handoff.stop) {
			const { reason } = handoff.stop;
			const until = reason === "cooldown" ? handoff.stop.until : null;
			await finishWallet(
				await phases.stop(
					id,
					{ stop: reason, slot: reason === "expired-link" ? 1 : null, until },
					now(),
				),
			);
			return;
		}
		const result = await handoff.receipt.catch(() => ({ kind: "unknown" }) as const);
		const time = now();
		const until =
			result.kind === "throttled" ? submitRetryAt(result.retryAfter, time, 1, random) : 0;
		if (until) await recordEditCooldown(db, provider, until);
		const job = await jobs.recordSubmission(
			id,
			result,
			now(),
			provider === "poyo" ? 2000 : 5000,
			until,
			owner,
		);
		if (!job) return;
		if (job.state === "rejected") await finishWallet(job);
		schedule(job);
	};
}
