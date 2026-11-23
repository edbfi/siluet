import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { openInstallation } from "../../db/installation";
import { guardFilePost, pinFilePost } from "../../providers/file-post";
import { createSubmitGate } from "../queue/submit-gate";
import { fileSendBoundary, recordEditCooldown } from "./send-boundary";

test.each(["poyo", "toapis"] as const)(
	"%s shares cooldown across media while upload starts leave generation capacity intact",
	async (provider) => {
		const root = await createOwnerDirectory(),
			db = await openInstallation(root);
		const events: string[] = [];
		const waiting = Promise.withResolvers<string>();
		const time = 1000;
		try {
			const started = await fileSendBoundary(
				db,
				provider,
				"upload",
				() => time,
				async (tx) => {
					await tx.run(sql`CREATE TABLE fixture_start (value TEXT)`);
					await tx.run(sql`INSERT INTO fixture_start VALUES ('upload')`);
					events.push("start");
				},
				() => {
					events.push("handoff");
					return waiting.promise;
				},
			);
			expect(events).toEqual(["start", "handoff"]);
			expect(await db.use((tx) => tx.get(sql`SELECT * FROM fixture_start`))).toEqual({
				value: "upload",
			});
			await recordEditCooldown(db, provider, time + 3000);
			for (const kind of ["upload", "edit"] as const) {
				const blocked = await fileSendBoundary(
					db,
					provider,
					kind,
					() => time,
					async () => {
						events.push("unexpected start");
					},
					async () => "unexpected send",
				);
				expect(blocked.stop).toEqual({ reason: "cooldown", until: time + 3000 });
			}
			waiting.resolve("receipt");
			expect(await started.receipt).toBe("receipt");
			const now = time + 3001;
			const changed = await fileSendBoundary(
				db,
				provider,
				"edit",
				() => now,
				async () => ({ reason: "audio-changed", slot: 2 }) as const,
				async () => "unexpected",
			);
			if (changed.stop?.reason !== "audio-changed") throw new Error("missing caller refusal");
			expect(changed.stop.slot).toBe(2);
			const limit = provider === "poyo" ? 20 : 5;
			await db.use((conn) =>
				conn.transaction(async (tx) => {
					for (let i = 0; i < limit; i++)
						await tx.run(sql`INSERT INTO provider_start VALUES(${provider},'submit',${now})`);
				}),
			);
			const upload = await fileSendBoundary(
				db,
				provider,
				"upload",
				() => now,
				async () => {},
				async () => ({ kind: "uploaded" }) as const,
			);
			expect(await upload.receipt).toEqual({ kind: "uploaded" });
			const edit = await fileSendBoundary(
				db,
				provider,
				"edit",
				() => now,
				async () => {},
				async () => "unexpected",
			);
			expect(edit.stop).toEqual({
				reason: "cooldown",
				until: now + (provider === "poyo" ? 10000 : 1000),
			});
			expect(
				await db.use((tx) =>
					tx.get(sql`SELECT count(*) n FROM provider_start WHERE kind='submit'`),
				),
			).toEqual({ n: limit });
			expect(events).toEqual(["start", "handoff"]);
		} finally {
			waiting.resolve("released");
			await db.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

test.each(["poyo", "toapis"] as const)(
	"%s publishes an observed file throttle ahead of an already queued ordinary generation",
	async (provider) => {
		const root = await createOwnerDirectory(),
			db = await openInstallation(root);
		const firstPost = Promise.withResolvers<void>(),
			finish = Promise.withResolvers<void>();
		const now = 1000,
			until = 2743;
		const gate = createSubmitGate(
			db,
			() => now,
			() => 0.743,
		);
		const reservation = { allowed: async () => true, blocked: async () => {} };
		let starts = 0;
		try {
			const editResponse = Promise.withResolvers<number>();
			const file = await fileSendBoundary(
				db,
				provider,
				"edit",
				() => now,
				async () => {},
				() => editResponse.promise,
			);
			const first = gate(
				provider,
				9999,
				1,
				async () => {
					starts++;
					firstPost.resolve();
					await finish.promise;
					return { kind: "accepted", taskId: "already-sent" };
				},
				reservation,
			);
			await firstPost.promise;
			const queued = gate(
				provider,
				9999,
				1,
				async () => {
					starts++;
					return { kind: "accepted", taskId: "unexpected" };
				},
				reservation,
			);
			editResponse.resolve(until);
			if (!file.receipt) throw new Error("Missing file handoff");
			const recorded = recordEditCooldown(db, provider, await file.receipt);
			finish.resolve();
			await Promise.all([first, recorded]);
			expect(await queued).toEqual({ blocked: "cooldown", until });
			expect(starts).toBe(1);
			expect(await db.use((tx) => tx.get(sql`SELECT count(*) n FROM provider_start`))).toEqual({
				n: 2,
			});
		} finally {
			finish.resolve();
			await db.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

for (const provider of ["poyo", "toapis"] as const) {
	test.each(["queued", "marking", "handoff", "sent"] as const)(
		`${provider} qualifies a pin at %s against the actual POST and committed ledger`,
		async (moment) => {
			const root = await createOwnerDirectory(),
				db = await openInstallation(root);
			const holding = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			const endpoint = "https://api.example.org/edit";
			let now = 1000,
				posts = 0,
				undos = 0;
			try {
				await db.use((tx) => tx.run(sql`CREATE TABLE marker (time INTEGER)`));
				const pin = await pinFilePost(
					endpoint,
					500,
					async () => "8.8.8.8",
					async () => {
						posts++;
						now += 1000;
						throw new Error("lost response after POST");
					},
					() => now,
				);
				const guard = guardFilePost(pin);
				const gate = createSubmitGate(
					db,
					() => now,
					() => 0,
				);
				const pending = gate(
					provider,
					9999,
					1,
					async () => {
						holding.resolve();
						await release.promise;
						return { kind: "accepted", taskId: "prior" };
					},
					{ allowed: async () => true, blocked: async () => {} },
				);
				await holding.promise;
				const boundary = fileSendBoundary(
					db,
					provider,
					"edit",
					() => now,
					async (tx, time) => {
						await tx.run(sql`INSERT INTO marker VALUES(${time})`);
						if (moment === "marking") now += 1000;
					},
					() => {
						if (moment === "handoff") now += 1000;
						return guard.read(endpoint, { method: "POST" });
					},
					{
						check: guard.check,
						undo: async (tx) => {
							undos++;
							await tx.run(sql`DELETE FROM marker`);
						},
					},
				);
				if (moment === "queued") now += 1000;
				release.resolve();
				await pending;
				const result = await boundary;
				if (moment === "sent") {
					expect(result.stop).toBeUndefined();
					expect(await result.receipt?.catch(() => "lost")).toBe("lost");
				} else expect(result.stop).toEqual({ reason: "destination" });
				expect(posts).toBe(Number(moment === "sent"));
				expect(undos).toBe(Number(moment === "handoff"));
				expect(await db.use((tx) => tx.get(sql`SELECT COUNT(*) n FROM marker`))).toEqual({
					n: posts,
				});
				expect(await db.use((tx) => tx.get(sql`SELECT COUNT(*) n FROM provider_start`))).toEqual({
					n: 1 + posts,
				});
			} finally {
				release.resolve();
				await db.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}
