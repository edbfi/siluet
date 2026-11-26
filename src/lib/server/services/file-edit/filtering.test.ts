import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import type { FilteringEvidence } from "../../../shared/media-catalog/filtering";
import { imageJobStore } from "../../db/image-job-store";
import { claimOwner } from "../../db/owner-session.fixture";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { createFileQueue } from "./queue";
import { clickFor, orderedBody, parsedRequest } from "./request.fixture";
import { openTestStages } from "./stages.fixture";

// File Reviews bind no D4 wording yet, so every state but declared blocks a local-file edit,
// before any stage is read or transferred.
const undeclared: FilteringEvidence[] = [
	{ d4: "closed-absent", closedBy: "api" },
	{ d4: "closed-absent", closedBy: "catalog" },
	{ d4: "closed-absent", closedBy: "both" },
	{ d4: "open-absent" },
	{ d4: "open-absent-fixed" },
	{ d4: "declared", catalogOnly: true },
	{ d4: "contradiction" },
	{ d4: "refused" },
	{ d4: "unknown" },
];

test.each(["poyo", "toapis"] as const)(
	"a %s local-file edit keeps its declared Queue and refuses every other D4 state with nothing sent",
	async (provider) => {
		const root = await createOwnerDirectory();
		const db = await openRuntimeInstallation(root);
		const stages = await openTestStages(db);
		const scope = { owner: "creator", session: "session-digest", draft: crypto.randomUUID() };
		const sent: string[] = [];
		try {
			const credentials = providerStore(db);
			await claimOwner(db, scope.owner, scope.session, Date.now());
			await credentials.save(provider, "reviewed-credential", Date.now(), true, 0);
			const bytes = new Uint8Array([4, 2]);
			const stage = await stages.put(scope, {
				bytes,
				digest: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
				mime: "image/png",
				transform: "none",
				revision: 0,
				rotated: false,
			});
			const draft = { ...createSeedreamDraft(provider, "edit"), prompt: "Draw a quiet meadow" };
			const request = parsedRequest(orderedBody(draft, [stage], { acceptUnknown: true }));
			expect(request.entry.evidence).toEqual({ d4: "declared" });
			const api = await createFileQueue(
				db,
				"runtime",
				stages,
				credentials.credential,
				async (id, _key, _live, held) => {
					sent.push(id);
					await held.release();
				},
				{ loadFeeds: async () => ({}) },
			);
			const review = await api.review(scope, request);
			if (!("token" in review)) throw new Error("Expected a file Review.");
			for (const evidence of undeclared) {
				const blocked = { ...request, entry: { ...request.entry, evidence } };
				expect(await api.review(scope, blocked)).toEqual({ error: "invalid" });
				expect(
					await api.submit(scope, { ...clickFor(request, review), entry: blocked.entry }),
				).toEqual({
					error: "invalid",
				});
			}
			expect(sent).toEqual([]);
			expect(await imageJobStore(db).list()).toEqual([]);
			expect(await stages.preview(scope, stage.handle)).toBeTruthy();
			expect(await api.submit(scope, clickFor(request, review))).toHaveProperty("jobId");
			await api.close();
			expect(sent).toHaveLength(1);
		} finally {
			await db.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
