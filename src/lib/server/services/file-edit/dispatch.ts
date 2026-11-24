import { fileUploadRoutes } from "../../../shared/image-studio/file-edit";
import { buildSeedreamRequest } from "../../../shared/image-studio/seedream";
import {
	type FileStop,
	fileAttemptStore,
	type StopFileJob,
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
import type { ClaimHandle } from "../media-staging/stages";
import { submitRetryAt } from "../queue/submit-gate";
import type { FileRequest } from "./request";
import { fileSendBoundary, recordEditCooldown } from "./send-boundary";
import { sendFileEdit, uploadFile } from "./transfer";

type SendStop = { reason: "interrupted" | "expired-link" } | { reason: "cooldown"; until: number };
type Hosted = { url: string; expiresAt?: number };

/**
 * Send one claimed file job: each file slot's upload in reference order, then one edit
 * with every hosted URL in its slot. Each send boundary checks shutdown, the provider
 * cooldown and, on Poyo.ai, the upload window. Any failure stops later uploads and the edit.
 */
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
	return async (
		id: string,
		key: string,
		live: FileRequest,
		held: ClaimHandle,
		closing: () => boolean = () => false,
	) => {
		const provider = live.input.provider;
		const finishWallet = async (job: ImageJob | undefined) => {
			if (!job?.wallet_open || job.state === "unknown") return;
			const readable = await jobs.canReadFileWallet(id, owner, now());
			const after = readable ? await balance(key).catch(() => null) : null;
			await jobs.finishWallet(id, after, now(), owner);
		};
		const stop = async (end: StopFileJob) => finishWallet(await phases.stop(id, end, now()));
		const interrupted = () => (closing() ? { reason: "interrupted" as const } : undefined);
		const hosted = new Map<number, Hosted>();
		// Every exact URL the edit will carry so far, by its 1-based position.
		const sent = new Map<string, number>();
		for (const [index, slot] of live.slots.entries())
			if (slot.kind === "url") sent.set(slot.url, index + 1);
		// A stop inside the upload loop records its phase there; its closing wallet read
		// waits until the buffer and the Poyo.ai upload slot are free.
		let stopped: { job: ImageJob | undefined } | undefined;
		const halt = async (end: StopFileJob) => {
			stopped = { job: await phases.stop(id, end, now()) };
		};
		const ready = await (async () => {
			try {
				if (!(await jobs.beginDispatch(id, provider, now(), owner))) return false;
				if (provider === "poyo")
					await jobs.recordBefore(id, await balance(key).catch(() => null), now());
				for (const [index, { position, stage }] of live.files.entries()) {
					if (closing()) return await halt({ stop: "interrupted", slot: position });
					const bytes = await held.next(index).catch(() => null);
					if (!bytes) return await halt({ stop: "stage-changed", slot: position });
					const read = await pin(fileUploadRoutes[provider], 60_000).catch(() => null);
					if (!read) return await halt({ stop: "destination", slot: position });
					// Shutdown is checked again at transport handoff, after the marker commits.
					const guard = guardFilePost(read, interrupted);
					let uploadStart: number | undefined;
					const handoff = await fileSendBoundary<Awaited<ReturnType<typeof upload>>, SendStop>(
						db,
						provider,
						"upload",
						now,
						async (tx, time) => {
							if (closing()) return { reason: "interrupted" };
							if (provider === "poyo") {
								const until = await nextPoyoUploadStart(tx, time);
								if (until > time) return { reason: "cooldown", until };
							}
							if (!(await startFileUpload(tx, id, owner, position, time)))
								return { reason: "interrupted" };
							if (provider === "poyo") uploadStart = await recordPoyoUploadStart(tx, time);
						},
						() => upload(provider, key, stage, bytes, guard.read),
						{
							check: guard.check,
							undo: async (tx, time) => {
								await undoFileUpload(tx, id, owner, position, time);
								if (uploadStart !== undefined) await undoPoyoUploadStart(tx, uploadStart, time);
							},
						},
					);
					if (handoff.stop) {
						const { reason } = handoff.stop;
						const until = reason === "cooldown" ? handoff.stop.until : null;
						return await halt({ stop: reason, slot: position, until });
					}
					const uploaded = await handoff.receipt.catch(() => ({ kind: "unknown" }) as const);
					if (uploaded.kind === "unknown") return await halt({ outcome: "unknown" });
					if (uploaded.kind === "rejected")
						return await halt({ outcome: "rejected", rejection: uploaded.reason });
					if (uploaded.kind === "stored") {
						const reason: FileStop =
							uploaded.reason === "expired-link" ? "expired-link" : "unusable";
						return await halt({ outcome: "unusable", stop: reason, slot: position });
					}
					// A hosted URL equal to a reviewed URL or an earlier receipt makes the edit impossible.
					const other = sent.get(uploaded.url);
					if (other !== undefined)
						return await halt({ outcome: "stored", stop: "duplicate", slot: position, other });
					sent.set(uploaded.url, position);
					hosted.set(position, uploaded);
					if (!(await phases.stored(id, position, now()))) return false;
				}
				return true;
			} finally {
				// Frees the buffer, the Poyo.ai upload slot and every copy not yet read.
				await held.release();
			}
		})();
		if (stopped) return finishWallet(stopped.job);
		if (!ready) return;
		const urls = live.slots.map((slot, index) =>
			slot.kind === "url" ? slot.url : (hosted.get(index + 1)?.url ?? ""),
		);
		const request = buildSeedreamRequest(live.input, (_reference, index) => urls[index]);
		const read = await pin(request.url, 30_000).catch(() => null);
		if (!read) return stop({ stop: "destination" });
		const expired = () =>
			[...hosted].find(([, link]) => link.expiresAt !== undefined && now() >= link.expiresAt)?.[0];
		const guard = guardFilePost(
			read,
			() =>
				interrupted() ??
				(expired() !== undefined ? { reason: "expired-link" as const } : undefined),
		);
		const handoff = await fileSendBoundary<Awaited<ReturnType<typeof edit>>, SendStop>(
			db,
			provider,
			"edit",
			now,
			async (tx, time) => {
				if (closing() || !(await startFileEdit(tx, id, owner, time)))
					return { reason: "interrupted" } as const;
			},
			() => edit(provider, key, request, guard.read),
			{
				check: guard.check,
				undo: (tx, time) => undoFileEdit(tx, id, owner, time),
			},
		);
		if (handoff.stop) {
			const { reason } = handoff.stop;
			return stop({
				stop: reason,
				slot: reason === "expired-link" ? expired() : null,
				until: reason === "cooldown" ? handoff.stop.until : null,
			});
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
