import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import toapisBundle from "../../../../../pricing/v2/toapis.json";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import {
	d4Wording,
	type FilteringEvidence,
	filteringFields,
	queueEvidenceProblem,
} from "../../../shared/media-catalog/filtering";
import {
	h3MaxOperation,
	seedanceEditOperation,
	seedanceKeyframeOperations,
	seedanceOperation,
} from "../../../shared/media-catalog/registry";
import { parseVideo, type VideoRequest } from "../../../shared/video-studio/request";
import { videoDefaults } from "../../../shared/video-studio/seedance";
import { imageJobStore } from "../../db/image-job-store";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { checkVideoInventory } from "../../providers/toapis/connection";
import { createVideoAccess } from "../providers/video-access";
import { closedAbsentSendsField, createVideoQueue } from "./video";

let directory: string;
let db: Installation;
let now: number;
beforeEach(async () => {
	directory = await createOwnerDirectory();
	db = await openInstallation(directory);
	now = Date.parse(toapisBundle.observedAt) + 86_400_000;
});
afterEach(async () => {
	await db.close();
	await rm(directory, { recursive: true, force: true });
});

const frame = "https://frames.example.com/start.png";
const clip = "https://clips.example.com/source.mp4";
const shipped = [
	[seedanceOperation, videoDefaults],
	[
		seedanceKeyframeOperations[0],
		{
			duration: 5,
			resolution: "720p",
			generate_audio: true,
			frames: [{ role: "first_frame", url: frame }],
		},
	],
	[
		seedanceKeyframeOperations[1],
		{
			duration: 5,
			resolution: "720p",
			generate_audio: true,
			frames: [
				{ role: "first_frame", url: frame },
				{ role: "last_frame", url: `${frame}?end` },
			],
		},
	],
	[
		seedanceEditOperation,
		{ resolution: "720p", generate_audio: true, frames: [{ role: "reference_video", url: clip }] },
	],
	[h3MaxOperation, { duration: 5, resolution: "768p", aspect_ratio: "16:9" }],
] as const;

function parse(operation: (typeof shipped)[number][0], draft: object) {
	const parsed = parseVideo({
		operationKey: operation.key,
		count: 1,
		retryLimit: 0,
		acceptTerms: false,
		draft: { ...draft, prompt: "A slow pan" },
	});
	if (!parsed) throw new Error(`Invalid fixture for ${operation.key.operation}.`);
	return parsed;
}

async function eligibleQueue(posts: string[]) {
	const store = providerStore(db);
	const access = createVideoAccess(
		db,
		store,
		checkVideoInventory(async () =>
			Response.json({ success: true, object: "list", data: [{ id: "seedance-2-5" }] }),
		),
	);
	await store.save("toapis", "video-only", now, false, 0);
	await store.save("poyo", "balance-only", now, false, 0);
	await access.check();
	return createVideoQueue(
		db,
		access,
		async (id) => {
			posts.push(id);
		},
		undefined,
		() => now,
	);
}

const states: FilteringEvidence[] = [
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

test.each(shipped)(
	"%p keeps its declared behaviour and blocks every other D4 state",
	async (operation, draft) => {
		const posts: string[] = [];
		const queue = await eligibleQueue(posts);
		const live = parse(operation, draft);
		expect(live.operation.evidence).toEqual({ d4: "declared" });
		const sent = "input" in live.body ? live.body.input : live.body;
		expect(sent).toHaveProperty(filteringFields[operation.key.provider], false);
		const provider = operation.key.provider;
		for (const evidence of states) {
			const changed = { ...live, operation: { ...live.operation, evidence } } as VideoRequest;
			const review = await queue.review("owner", changed);
			expect(review.blockers).toContain(queueEvidenceProblem(evidence, provider) as string);
			expect(
				await queue.submit("owner", { ...changed, token: review.token, acceptTerms: true }),
			).toEqual({ error: "stale" });
			// With its wording bound into the reviewed disclosures, a queueing state has no D4
			// blocker; a blocking state still does.
			const wording = d4Wording(provider, evidence);
			const disclosed = { ...changed, disclosures: [...changed.disclosures, ...(wording ?? [])] };
			const blockers = (await queue.review("owner", disclosed)).blockers;
			const queueing =
				wording !== null && !["contradiction", "refused", "unknown"].includes(evidence.d4);
			expect(blockers.some((blocker) => blocker === queueEvidenceProblem(evidence, provider))).toBe(
				!queueing,
			);
			// Every shipped video body still sends the filtering field (G7 omits it), so a
			// closed-absent row stays blocked even with its acknowledgement bound.
			expect(blockers.includes(closedAbsentSendsField)).toBe(evidence.d4 === "closed-absent");
		}
		expect(posts).toEqual([]);
		expect(await imageJobStore(db).list()).toHaveLength(0);
		const review = await queue.review("owner", live);
		expect(review.blockers).toEqual([]);
		expect(
			await queue.submit("owner", { ...live, token: review.token, acceptTerms: true }),
		).toHaveProperty("jobId");
		expect(posts).toHaveLength(1);
	},
);

test("changed D4 wording makes an unclaimed video Review stale", async () => {
	const posts: string[] = [];
	const queue = await eligibleQueue(posts);
	const live = parse(h3MaxOperation, shipped[4][1]);
	const evidence = { d4: "open-absent" } as const;
	const wording = d4Wording("poyo", evidence) ?? [];
	const open = {
		...live,
		operation: { ...live.operation, evidence },
		disclosures: [...live.disclosures, ...wording],
	} as VideoRequest;
	const review = await queue.review("owner", open);
	expect(review.blockers).toEqual([]);
	const reworded = { ...open, disclosures: [...live.disclosures, `${wording[0]} Updated.`] };
	expect(
		await queue.submit("owner", { ...reworded, token: review.token, acceptTerms: true }),
	).toEqual({ error: "stale" });
	expect(posts).toEqual([]);
});
