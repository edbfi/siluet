import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { privateMediaResponse } from "../media/private-response";
import { createScratchPool } from "./scratch";
import { createStages } from "./stages";

test("scoped JPEG and PNG previews read a verified file identity and revoke every active range", async () => {
	const root = await createOwnerDirectory();
	const installation = await openRuntimeInstallation(root);
	let time = 1;
	const pool = createScratchPool(installation);
	await pool.reclaim();
	const scratch = await pool.scope("image");
	const stages = createStages(scratch, { now: () => time });
	const scope = { owner: "owner", session: "session", draft: crypto.randomUUID() };
	const bytes = new Uint8Array(768 * 1024).fill(37);
	const common = {
		bytes,
		size: bytes.length,
		digest: createHash("sha256").update(bytes).digest("hex"),
	};
	const jpeg = {
		...common,
		mime: "image/jpeg" as const,
		transform: "reencoded-rotation" as const,
		revision: 0,
		rotated: false,
	};
	const png = {
		...common,
		mime: "image/png" as const,
		transform: "none" as const,
		revision: 0,
		rotated: false,
	};
	const url = "http://127.0.0.1/stage";
	try {
		for (const media of [jpeg, png]) {
			const descriptor = await stages.put(scope, media);
			expect(descriptor.transform).toBe(media.transform);
			const request = async (method: string, range?: string) => {
				const lease = await stages.openPreview(scope, descriptor.handle);
				if (!lease) throw new Error("missing stage");
				return privateMediaResponse(
					new Request(url, { method, headers: range ? { range } : undefined }),
					lease,
				);
			};
			expect(
				await stages.openPreview({ ...scope, session: "other" }, descriptor.handle),
			).toBeNull();
			expect(
				await stages.openPreview({ ...scope, draft: crypto.randomUUID() }, descriptor.handle),
			).toBeNull();
			const head = await request("HEAD");
			expect(head.headers.get("Content-Length")).toBe(String(bytes.length));
			expect(Object.fromEntries(head.headers)).toMatchObject({
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
				"cross-origin-resource-policy": "same-origin",
				"content-type": media.mime,
			});
			expect((await request("GET", "bytes=9999999-")).status).toBe(416);
			const tail = await request("GET", "bytes=-1");
			expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([37]);
			const range = await request("GET", "bytes=9-");
			expect(range.status).toBe(206);
			if (!range.body) throw new Error("missing body");
			const reader = range.body.getReader();
			expect((await reader.read()).value?.length).toBe(65536);
			time = descriptor.deadline;
			expect(await stages.openPreview(scope, descriptor.handle)).toBeNull();
			await expect(reader.read()).rejects.toThrow();
			await stages.revoke(scope.session);
			expect(await readdir(scratch.directory)).toEqual([]);
			time = 1;
		}
		const descriptor = await stages.put(scope, png);
		const path = join(scratch.directory, descriptor.handle);
		await rename(path, `${path}.old`);
		await writeFile(path, bytes);
		await expect(stages.openPreview(scope, descriptor.handle)).rejects.toThrow("changed");
		expect(await stages.review(scope, descriptor.handle)).toBeNull();
	} finally {
		await stages.close();
		await installation.close();
		await rm(root, { recursive: true, force: true });
	}
});
