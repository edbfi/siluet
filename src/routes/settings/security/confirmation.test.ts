import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { TOTP } from "otpauth";
import { openInstallation } from "#lib/server/db/installation.ts";
import { createOwnerAccess } from "#lib/server/services/owner/access.ts";
import { recoveryDigest } from "#lib/server/services/owner/factors.ts";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { actions } from "./+page.server";

test.each(["publication", "throttling", "expiry during publication"] as const)(
	"replacement confirmation after spending the final code handles %s",
	async (failure) => {
		const directory = await createOwnerDirectory();
		const install = await openInstallation(directory);
		let elapsed = 0;
		const monotonic = spyOn(performance, "now").mockImplementation(() => elapsed);
		try {
			const password = crypto.randomUUID();
			const origin = new URL("http://127.0.0.1");
			const access = createOwnerAccess(install, Date.now, origin.origin);
			const session = await access.claim(access.rotate(), "owner", password);
			const initial = await access.security.authorize("enable", session, password, "");
			if (initial.kind !== "candidate") throw new Error("Expected enrollment.");
			const enabled = await access.security.activate(
				"enable",
				session,
				initial.proof,
				new TOTP({ secret: initial.manual }).generate(),
			);
			const { factor } = await access.security.snapshot();
			if (!factor) throw new Error("Expected active factor.");
			const last = enabled.codes[9];
			await install.use(async (db) => {
				await db.run(
					sql`DELETE FROM recovery_code WHERE digest != ${recoveryDigest(install.id, factor.set_id, last)}`,
				);
				await db.run(sql`UPDATE owner_factor SET remaining=1`);
			});
			if (failure === "throttling") {
				// Four recent failures leave one attempt available when replacement starts.
				await install.use(async (db) => {
					for (let i = 0; i < 4; i++)
						await db.run(sql`INSERT INTO factor_attempt VALUES (${crypto.randomUUID()}, 0)`);
					await db.run(sql`UPDATE factor_budget SET failures=4`);
				});
				elapsed = 290000;
			}
			const replacement = await access.security.authorize(
				"replace",
				enabled.session,
				password,
				last,
			);
			if (replacement.kind !== "candidate") throw new Error("Expected replacement.");
			expect((await access.security.snapshot()).factor?.remaining).toBe(0);
			const totp = new TOTP({ secret: replacement.manual });
			// The action uses only these fields of the framework request event.
			const confirm = (proof: string, code = totp.generate(), sessionToken = enabled.session) =>
				actions.default({
					locals: { studio: { access, origin, cookieName: "session" } },
					cookies: { get: () => sessionToken, set: () => {}, delete: () => {} },
					request: new Request(origin, {
						method: "POST",
						body: new URLSearchParams({ change: "replace", code, proof }),
					}),
				} as unknown as Parameters<typeof actions.default>[0]);
			if (failure === "throttling") {
				const mismatch = await confirm(replacement.proof, "invalid");
				if (!("status" in mismatch)) throw new Error("Expected an invalid code.");
				expect(mismatch.status).toBe(403);
				expect(mismatch.data.proof === replacement.proof).toBe(true);
			}
			const collision =
				failure === "throttling"
					? undefined
					: spyOn(crypto, "randomUUID")
							.mockImplementationOnce(() => randomUUID()) // attempt reservation
							.mockImplementationOnce(() => {
								if (failure === "expiry during publication") elapsed += 300000;
								return factor.id as ReturnType<typeof crypto.randomUUID>;
							});
			const failed = await confirm(replacement.proof).finally(() => collision?.mockRestore());
			if (!("status" in failed)) throw new Error("Expected failed confirmation.");
			if (failure === "expiry during publication") {
				expect(failed.status).toBe(403);
				expect(failed.data.proof === "").toBe(true);
				return;
			}
			expect(failed.status).toBe(failure === "publication" ? 503 : 429);
			expect(failed.data.proof === replacement.proof).toBe(true);
			expect(failed.data.action).toBe("replace");
			if (failure === "throttling") elapsed += 10000;
			const changed = await confirm(failed.data.proof);
			if (!("codes" in changed)) throw new Error("Expected the original candidate to commit.");
			expect(changed.codes).toHaveLength(10);
			const rotated = await access.signIn("owner", password);
			const newSession = await access.security.complete(rotated.token, changed.codes[0]);
			const consumed = await confirm(replacement.proof, totp.generate(), newSession);
			if (!("status" in consumed)) throw new Error("Expected consumed proof to be refused.");
			expect(consumed.data.proof === "").toBe(true);
		} finally {
			monotonic.mockRestore();
			await install.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	30000,
);
