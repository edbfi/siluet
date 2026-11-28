import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import pair from "../../../../../tests/fixtures/poyo-basis-pair.json";
import { toapisRates } from "../../../../../tests/fixtures/toapis-feed";
import { createDerivedDraft } from "../../../shared/image-studio/derived";
import { derivedWording } from "../../../shared/image-studio/derived-review";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { zImageDisclosure } from "../../../shared/image-studio/z-image";
import { d4Disclosure, type FilteringEvidence } from "../../../shared/media-catalog/filtering";
import type { QueueKey, QueueRow } from "../../../shared/media-catalog/queue-row";
import { pricingMaxAgeMs } from "../../../shared/pricing/feed";
import { type PricingFeeds, pricingSourceDate } from "../../../shared/pricing/feeds";
import { decodePoyoBasis } from "../../../shared/pricing/poyo-basis";
import {
	decodePoyoV2Feed,
	poyoConfirmationMs,
	poyoFeedExpiryMs,
} from "../../../shared/pricing/poyo-feed";
import { decodeToapisPricingFeed } from "../../../shared/pricing/toapis-feed";
import { type Installation, openInstallation } from "../../db/installation";
import { providerKeyFilename } from "../../db/provider-key";
import { providerStore } from "../../db/provider-store";
import { loadBundledPricing } from "../pricing/studio-feeds";
import { createProviderConnections } from "../providers/connections";
import { derivedRows, parseDerivedRequest } from "./derived";
import { parseQueueRequest } from "./request";
import { createSubmissionQueue } from "./submission";

let db: Installation;
let dir: string;
let posted: string[];
const referenceUrl =
	"https://photo-fixture.example.org/private%2Ffan?sig=private%2Bnz&v=1&v=2#layer-id";
const secondReferenceUrl = referenceUrl.replace("private%2Bnz", "alternate%2Bqy");
const prompt = "private prompt with a folded fan";

async function installationReviewDigest() {
	const row = await db.use((conn) =>
		conn.get<{ secret: string }>(sql`SELECT secret FROM image_review_key WHERE singleton=1`),
	);
	if (!row) throw new Error("Expected installation signing key.");
	return (...parts: unknown[]) =>
		createHmac("sha256", Buffer.from(row.secret, "hex"))
			.update(JSON.stringify(parts))
			.digest("hex");
}

function makeInput(provider: "poyo" | "toapis" = "poyo", ...urls: string[]) {
	const draft = createSeedreamDraft(provider, urls.length ? "edit" : "generate");
	draft.references = urls.map((url) => ({ kind: "url", url, hostname: "mock.example" }));
	const parsed = parseQueueRequest({
		draft: { ...draft, prompt },
		count: 1,
		retryLimit: 0,
		acceptUnknown: false,
	});
	if (!parsed) throw new Error("Invalid live request fixture");
	return parsed;
}
function queue() {
	return createSubmissionQueue(
		db,
		providerStore(db).credential,
		async (_id, _provider, key) => {
			posted.push(key);
		},
		async () => ({}),
	);
}
beforeEach(async () => {
	dir = await createOwnerDirectory();
	db = await openInstallation(dir);
	posted = [];
	for (const id of ["poyo", "toapis"] as const)
		await providerStore(db).save(id, `fixture-${id}`, 123, true, 0);
});
afterEach(async () => {
	await db.close();
	await rm(dir, { recursive: true, force: true });
});

test("a claimed Poyo.ai image job stores its recoverable contract; a ToAPIs job keeps the shipped path", async () => {
	const api = await queue();
	const contracts: Record<string, unknown> = {};
	for (const provider of ["poyo", "toapis"] as const) {
		const input = makeInput(provider);
		const reviewed = await api.review("owner", input);
		if (!("token" in reviewed)) throw new Error("Expected Review");
		const claimed = await api.submit("owner", {
			...input,
			token: reviewed.token,
			acceptUnknown: true,
		});
		if (!("jobId" in claimed)) throw new Error(`Expected a ${provider} claim`);
		const row = await db.use((conn) =>
			conn.get<{ contract: string | null }>(
				sql`SELECT contract FROM image_job WHERE id=${claimed.jobId}`,
			),
		);
		contracts[provider] = row?.contract === null ? null : JSON.parse(row?.contract ?? "");
	}
	expect(contracts.toapis).toBeNull();
	expect(contracts.poyo).toEqual({
		v: 1,
		operationKey: {
			provider: "poyo",
			model: "seedream-5.5",
			route: "POST /api/generate/submit",
			operation: "text-to-image",
		},
		revision: "ec7320720913a55f955e1bf6a651e9c38bd356c5",
		rowDigest: null,
		adapter: "poyo-image-v1",
		statusRoute: "GET /api/generate/status/{task_id}",
		result: { envelope: "poyo-image-v1", responseModel: "none" },
		formats: { sent: "png", expected: "image/png" },
	});
});

test("a legacy generation body with ignored fields can replay only an authenticated existing claim", async () => {
	const api = await queue();
	const input = makeInput();
	const reviewed = await api.review("owner", input);
	if (!("token" in reviewed)) throw new Error("Expected generation Review");
	const draft = createSeedreamDraft("poyo");
	const body = {
		draft: {
			...draft,
			prompt,
			displayName: "ignored",
			options: { ...draft.options, colorLabel: "ignored" },
		},
		count: 1,
		retryLimit: 0,
		acceptUnknown: true,
		token: reviewed.token,
	};
	expect(parseQueueRequest(body)).toBeNull();
	const replay = parseQueueRequest(body, "submit");
	if (!replay) throw new Error("Expected legacy replay normalization");
	expect(await api.submit("owner", replay)).toEqual({ error: "invalid" });
	expect(posted).toBeEmpty();
	const accepted = await api.submit("owner", {
		...input,
		token: reviewed.token,
		acceptUnknown: true,
	});
	expect(accepted).toHaveProperty("jobId");
	expect(await api.submit("other", replay)).toEqual({ error: "invalid" });
	expect(await api.submit("owner", replay)).toEqual(accepted);
	expect(posted).toHaveLength(1);
	expect(parseQueueRequest({ ...body, operationKey: input.entry.key }, "submit")).toBeNull();
});

test.each(["poyo", "toapis"] as const)(
	"a %s Review permits exactly one accepted generation across concurrent clicks and restart",
	async (provider) => {
		const input = makeInput(provider);
		const api = await queue();
		const review = await api.review("owner", input);
		if ("error" in review) throw new Error("expected Review");
		expect(review).not.toHaveProperty("editDisclosure");
		expect(review.requiresConsent).toBe(true);
		const click = { ...input, token: review.token };
		expect(await api.submit("owner", click)).toEqual({ error: "invalid" });
		click.acceptUnknown = true;
		expect(await api.submit("other", click)).toEqual({ error: "invalid" });
		expect(await api.submit("owner", { ...click, token: `${review.token}0` })).toEqual({
			error: "invalid",
		});
		expect(posted).toHaveLength(0);
		const [one, two] = await Promise.all([api.submit("owner", click), api.submit("owner", click)]);
		expect(one).toEqual(two);
		expect(one).toHaveProperty("jobId");
		expect(posted).toEqual([`fixture-${provider}`]);
		await providerStore(db).remove(provider);
		await db.close();
		db = await openInstallation(dir);
		const reopened = await queue();
		expect(await reopened.submit("owner", click)).toEqual(one);
		expect(await reopened.submit("owner", { ...click, acceptUnknown: false })).toEqual({
			error: "invalid",
		});
		const changed = makeInput(provider === "poyo" ? "toapis" : "poyo");
		expect(
			await reopened.submit("owner", { ...changed, token: review.token, acceptUnknown: true }),
		).toEqual({ error: "invalid" });
		expect(posted).toHaveLength(1);
		const rows = await db.use((conn) => conn.all(sql`SELECT * FROM image_job`));
		expect(JSON.stringify(rows)).not.toContain(input.input.prompt);
	},
);

test("legacy generation Review tokens and accepted bindings remain compatible", async () => {
	const input = makeInput();
	const api = await queue();
	const review = await api.review("owner", input);
	if ("error" in review) throw new Error("Expected Review.");
	const digest = await installationReviewDigest();
	const id = review.token.split(".")[0];
	const terms = digest("review-terms-v1", 1, review.quote, true, null);
	const signature = digest("review-v1", id, terms, "owner", "poyo", input.request.body, 1, 0);
	expect(review.token).toBe(`${id}.${terms}.${signature}`);
	expect(await api.submit("owner", { ...input, token: review.token, acceptUnknown: true })).toEqual(
		{
			jobId: id,
		},
	);
	const job = await db.use((conn) =>
		conn.get<{ binding: string }>(sql`SELECT binding FROM image_job WHERE id=${id}`),
	);
	expect(job?.binding).toBe(digest("accepted-v1", signature, true));
});

test.each(["poyo", "toapis"] as const)(
	"a %s multi-reference edit binds the ordered provider payload and replays after restart",
	async (provider) => {
		const delivered: unknown[] = [];
		const openQueue = () =>
			createSubmissionQueue(
				db,
				providerStore(db).credential,
				async (_id, route, key, request) => {
					delivered.push({ route, key, request });
				},
				async () => ({}),
			);
		const input = makeInput(provider, referenceUrl, secondReferenceUrl);
		const api = await openQueue();
		const review = await api.review("owner", input);
		if ("error" in review) throw new Error("Expected Review.");
		const disclosure = "editDisclosure" in review ? review.editDisclosure : undefined;
		expect(disclosure).toBeArray();
		const text = Array.isArray(disclosure) ? disclosure.join(" ") : "";
		expect(text).toMatch(/every full reference URL/i);
		expect(text).toMatch(/path.*query.*fragment/i);
		expect(text).toMatch(/upstream/i);
		expect(text).toMatch(/signed link.*expir/i);
		expect(text).toMatch(/keep a copy/i);
		expect(text).toMatch(/reference image.*retention|retention.*reference image/i);
		expect(text).toMatch(
			provider === "poyo" ? /task history.*three months/i : /fallback.*90 days/i,
		);
		expect(JSON.stringify(review)).not.toContain(referenceUrl);
		expect(delivered).toBeEmpty();

		const click = { ...input, token: review.token, acceptUnknown: true };
		expect(await api.submit("other", click)).toEqual({ error: "invalid" });
		const changes = [
			makeInput(provider, secondReferenceUrl, referenceUrl),
			makeInput(provider, referenceUrl, secondReferenceUrl.replace("alternate", "other")),
			makeInput(provider, referenceUrl.replace("&v=1&v=2", "&v=2&v=1"), secondReferenceUrl),
			makeInput(provider, referenceUrl, secondReferenceUrl.replace("#layer-id", "#other-layer")),
			makeInput(provider, referenceUrl),
			makeInput(provider, referenceUrl, secondReferenceUrl, `${referenceUrl}-extra`),
			makeInput(provider),
		];
		for (const altered of changes) {
			expect(await api.submit("owner", { ...click, ...altered, token: review.token })).toEqual({
				error: "invalid",
			});
		}
		expect(delivered).toBeEmpty();
		expect(await db.use((conn) => conn.all(sql`SELECT id FROM image_job`))).toBeEmpty();

		const [first, second] = await Promise.all([
			api.submit("owner", click),
			api.submit("owner", click),
		]);
		expect(first).toHaveProperty("jobId");
		expect(second).toEqual(first);
		expect(delivered).toEqual([
			{ route: provider, key: `fixture-${provider}`, request: input.request },
		]);
		const persisted = JSON.stringify(
			await db.use((conn) => conn.all(sql`SELECT * FROM image_job`)),
		);
		for (const privateMarker of [
			prompt,
			"photo-fixture",
			"private%2Ffan",
			"private%2Bnz",
			"alternate%2Bqy",
			"layer-id",
		]) {
			expect(persisted).not.toContain(privateMarker);
		}
		await providerStore(db).remove(provider);
		await db.close();
		db = await openInstallation(dir);
		const reopened = await openQueue();
		expect(await reopened.submit("owner", click)).toEqual(first);
		for (const altered of changes) {
			expect(await reopened.submit("owner", { ...click, ...altered, token: review.token })).toEqual(
				{ error: "invalid" },
			);
		}
		expect(await reopened.submit("owner", { ...click, acceptUnknown: false })).toEqual({
			error: "invalid",
		});
		expect(delivered).toHaveLength(1);
	},
);

const previousEditDisclosure = {
	poyo: [
		"Queue sends Poyo.ai your prompt and full reference URL, including its path, query with any signature, and fragment. Poyo.ai and its upstream model services may process these inputs and fetch the image.",
		"Keep the image reachable through processing without cookies or extra headers. A signed link may grant access until expiry. A recipient can keep a copy it has already fetched, even after the link expires.",
		"Poyo.ai displays input parameters in task history and retains generation history for three months. The retention period for fetched reference images is unknown.",
	],
	toapis: [
		"Queue sends ToAPIs your prompt and full reference URL, including its path, query with any signature, and fragment. ToAPIs and its upstream model services may process these inputs and fetch the image, including through a fallback for eligible accounts and regions.",
		"Keep the image reachable through processing without cookies or extra headers. A signed link may grant access until expiry. A recipient can keep a copy it has already fetched, even after the link expires.",
		"ToAPIs keeps API call logs for 90 days by default. Retention of submitted URLs and fetched reference images is unspecified.",
	],
};

test.each(["poyo", "toapis"] as const)(
	"after the %s edit upgrade, a claimed single-reference Review replays and an unused one stales",
	async (provider) => {
		const input = makeInput(provider, referenceUrl);
		const previous = await createSubmissionQueue(
			db,
			providerStore(db).credential,
			async (_id, _route, key) => {
				posted.push(key);
			},
			async () => ({}),
			Date.now,
			(route) => previousEditDisclosure[route],
		);
		const acceptedReview = await previous.review("owner", input);
		const unusedReview = await previous.review("owner", input);
		if ("error" in acceptedReview || "error" in unusedReview) throw new Error("Expected Review.");
		const digest = await installationReviewDigest();
		// A ToAPIs Review also binds its access evidence: here the pre-snapshot exception.
		const access = { revision: 1, state: "exception", checkedAt: null, basis: "pre-snapshot" };
		const oldTerms = digest(
			"edit-review-terms-v1",
			1,
			acceptedReview.quote,
			true,
			null,
			...(provider === "toapis" ? [access] : []),
			previousEditDisclosure[provider],
		);
		const { method, url, body } = input.request;
		for (const { token } of [acceptedReview, unusedReview]) {
			const id = token.split(".")[0];
			const signature = digest(
				"edit-review-v1",
				id,
				oldTerms,
				"owner",
				provider,
				method,
				url,
				body,
				1,
				0,
			);
			expect(token).toBe(`${id}.${oldTerms}.${signature}`);
		}
		const acceptedClick = { ...input, token: acceptedReview.token, acceptUnknown: true };
		const accepted = await previous.submit("owner", acceptedClick);
		expect(accepted).toHaveProperty("jobId");

		await db.close();
		db = await openInstallation(dir);
		const upgraded = await queue();
		expect(await upgraded.submit("owner", acceptedClick)).toEqual(accepted);
		expect(
			await upgraded.submit("owner", {
				...makeInput(provider, secondReferenceUrl),
				token: acceptedReview.token,
				acceptUnknown: true,
			}),
		).toEqual({ error: "invalid" });
		expect(await upgraded.submit("owner", { ...acceptedClick, acceptUnknown: false })).toEqual({
			error: "invalid",
		});
		const unused = await upgraded.submit("owner", { ...acceptedClick, token: unusedReview.token });
		expect(unused).toMatchObject({
			error: "stale",
			review: { quote: unusedReview.quote, acceptUnknown: false },
		});
		expect(posted).toEqual([`fixture-${provider}`]);
		expect(await db.use((conn) => conn.all(sql`SELECT id FROM image_job`))).toHaveLength(1);
		if (!("review" in unused)) throw new Error("Expected updated Review.");
		expect(unused.review).toMatchObject({
			editDisclosure: expect.arrayContaining([expect.stringMatching(/every full reference URL/i)]),
		});
		expect(
			await upgraded.submit("owner", { ...acceptedClick, token: unused.review.token }),
		).toHaveProperty("jobId");
		expect(posted).toEqual([`fixture-${provider}`, `fixture-${provider}`]);
	},
);

test("changing only the edit disclosure content stales unused consent and preserves a claimed replay", async () => {
	const input = makeInput("poyo", referenceUrl, secondReferenceUrl);
	let disclosure = ["The reference is retained for three months."];
	const openQueue = () =>
		createSubmissionQueue(
			db,
			providerStore(db).credential,
			async () => {
				posted.push("accepted");
			},
			async () => ({}),
			Date.now,
			() => disclosure,
		);
	const api = await openQueue();
	const original = await api.review("owner", input);
	if ("error" in original) throw new Error("Expected Review.");
	expect(original).toMatchObject({ editDisclosure: disclosure });
	disclosure = ["The reference is retained for four months."];
	const result = await api.submit("owner", {
		...input,
		token: original.token,
		acceptUnknown: true,
	});
	expect(result).toMatchObject({
		error: "stale",
		review: { quote: original.quote, editDisclosure: disclosure, acceptUnknown: false },
	});
	expect(posted).toBeEmpty();
	expect(await db.use((conn) => conn.all(sql`SELECT id FROM image_job`))).toBeEmpty();
	if (!("review" in result)) throw new Error("Expected current Review terms.");
	const fresh = { ...input, token: result.review.token, acceptUnknown: true };
	const accepted = await api.submit("owner", fresh);
	expect(accepted).toHaveProperty("jobId");
	expect(posted).toEqual(["accepted"]);
	await db.close();
	db = await openInstallation(dir);
	disclosure = ["The reference is now retained for twelve months."];
	const reopened = await openQueue();
	expect(await reopened.submit("owner", fresh)).toEqual(accepted);
	expect(posted).toEqual(["accepted"]);
});

test.each(["poyo", "toapis"] as const)(
	"a %s edit quotes one, two, and ten references from its dated bundled rates",
	async (provider) => {
		const feed = await loadBundledPricing(provider);
		if (!feed) throw new Error("Invalid bundled feed.");
		const sourceDate = pricingSourceDate(feed);
		const api = await createSubmissionQueue(
			db,
			providerStore(db).credential,
			async () => {},
			async () => (feed.provider === "poyo" ? { poyo: feed } : { toapis: feed }),
			() => (feed.provider === "poyo" ? poyoConfirmationMs(feed) : Date.parse(sourceDate)) + 100,
		);
		// ToAPIs charges $0.0064 (1.28 credits) per reference on top of the 2K tier.
		for (const [count, poyoTotal, toapisTotal, toapisUsd] of [
			[1, "8.6", "6.88", "0.0344"],
			[2, "10.2", "8.16", "0.0408"],
			[10, "23", "18.4", "0.092"],
		] as const) {
			const urls = Array.from({ length: count }, (_, index) => `${referenceUrl}-${index}`);
			expect(await api.review("owner", makeInput(provider, ...urls))).toMatchObject({
				quote: {
					status: "known",
					perRequest: provider === "poyo" ? poyoTotal : toapisTotal,
					maxAttempts: 1,
					sourceDate,
					...(provider === "toapis" && {
						usd: { perRequest: toapisUsd, batch: toapisUsd },
						referenceImages: { count, usdEach: "0.0064", approximateCreditsEach: "1.28" },
					}),
				},
				requiresConsent: provider === "toapis",
			});
		}
	},
);

test("removing the reviewed credential before first claim requires a fresh review and sends nothing", async () => {
	const input = makeInput();
	const api = await queue();
	const review = await api.review("owner", input);
	if ("error" in review) throw new Error("expected Review");
	await providerStore(db).remove("poyo");
	expect(await api.submit("owner", { ...input, token: review.token, acceptUnknown: true })).toEqual(
		{ error: "stale" },
	);
	expect(posted).toHaveLength(0);
});

test.each(["remove", "replace"] as const)(
	"a competing %s that commits before claim invalidates already decrypted key material",
	async (change) => {
		const store = providerStore(db);
		const input = makeInput();
		const start = await queue();
		const review = await start.review("owner", input);
		if ("error" in review) throw new Error("Expected Review.");
		const api = await createSubmissionQueue(
			db,
			async (id) => {
				const snapshot = await store.credential(id);
				if (change === "remove") await store.remove(id);
				else await store.save(id, "replacement-key", 124, true, 1);
				return snapshot;
			},
			async () => {
				posted.push("unexpected");
			},
			async () => ({}),
		);
		expect(
			await api.submit("owner", { ...input, token: review.token, acceptUnknown: true }),
		).toMatchObject({ error: "stale" });
		expect(posted).toEqual([]);
	},
);

test.each(["remove", "replace"] as const)(
	"a claim that commits before %s uses only its reviewed key",
	async (change) => {
		const store = providerStore(db);
		const api = await createSubmissionQueue(
			db,
			store.credential,
			async (_id, provider, key) => {
				if (change === "remove") await store.remove(provider);
				else await store.save(provider, "replacement", 124, true, 1);
				posted.push(key);
			},
			async () => ({}),
		);
		const input = makeInput();
		const review = await api.review("owner", input);
		if ("error" in review) throw new Error("Expected Review.");
		const click = { ...input, token: review.token, acceptUnknown: true };
		const claimed = await api.submit("owner", click);
		expect(claimed).toHaveProperty("jobId");
		expect(await api.submit("owner", click)).toEqual(claimed);
		expect(posted).toEqual(["fixture-poyo"]);
	},
);

test("a queued job during replacement validation requires a warning before changing the key", async () => {
	const store = providerStore(db);
	const validating = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const connections = createProviderConnections(store, {
		poyo: async () => {
			validating.resolve();
			await release.promise;
			return { outcome: "accepted", seedream: true };
		},
		toapis: async () => ({ outcome: "unavailable" }),
	});
	const replacement = connections.connect("poyo", "replacement-key");
	await validating.promise;
	const api = await queue();
	const input = makeInput();
	const reviewed = await api.review("owner", input);
	if ("error" in reviewed) throw new Error("Expected Review.");
	await api.submit("owner", { ...input, token: reviewed.token, acceptUnknown: true });
	release.resolve();
	expect(await replacement).toBe("job-warning");
	expect(await connections.remove("poyo")).toBe("job-warning");
	expect(await store.credential("poyo")).toMatchObject({ revision: 1, key: "fixture-poyo" });
	expect(await connections.connect("poyo", "replacement-key", true)).toBe("connected");
});

test("a ToAPIs edit reviewed against an older reference rate is stale at Queue and sends nothing", async () => {
	const reviewed = decodeToapisPricingFeed(toapisRates);
	const changed = decodeToapisPricingFeed({
		...toapisRates,
		rates: toapisRates.rates.map((rate) =>
			rate.unit === "reference-image" ? { ...rate, usd: "0.008", approximateCredits: "1.6" } : rate,
		),
	});
	if (!reviewed || !changed) throw new Error("Invalid fixture rate.");
	let feed = reviewed;
	const input = makeInput("toapis", referenceUrl, secondReferenceUrl);
	const api = await createSubmissionQueue(
		db,
		providerStore(db).credential,
		async () => {
			posted.push("accepted");
		},
		async () => ({ toapis: feed }),
		() => Date.parse(reviewed.observedAt) + 100,
	);
	const terms = await api.review("owner", input);
	if ("error" in terms) throw new Error("Expected Review");
	expect(terms.quote).toMatchObject({ perRequest: "8.16" });
	feed = changed;
	expect(
		await api.submit("owner", { ...input, token: terms.token, acceptUnknown: true }),
	).toMatchObject({
		error: "stale",
		review: { quote: { perRequest: "8.8" }, acceptUnknown: false },
	});
	expect(posted).toBeEmpty();
});

test.each(["generate", "edit"] as const)(
	"a known ToAPIs %s rate requires fallback consent and stale rates refresh the Review",
	async (operation) => {
		const feed = decodeToapisPricingFeed(toapisRates);
		if (!feed) throw new Error("Invalid fixture rate.");
		let time = Date.parse(feed.observedAt) + 100;
		let available = true;
		const input =
			operation === "edit"
				? makeInput("toapis", referenceUrl, secondReferenceUrl)
				: makeInput("toapis");
		const api = await createSubmissionQueue(
			db,
			providerStore(db).credential,
			async () => {
				posted.push("accepted");
			},
			async () => (available ? { toapis: feed } : {}),
			() => time,
		);
		const terms = await api.review("owner", input);
		if ("error" in terms) throw new Error("Expected Review");
		expect(terms.quote).toMatchObject({
			status: "known",
			perRequest: operation === "edit" ? "8.16" : "5.6",
			maxAttempts: 1,
		});
		expect(terms.requiresConsent).toBe(true);
		expect(await api.submit("owner", { ...input, token: terms.token })).toEqual({
			error: "invalid",
		});
		available = false;
		expect(
			await api.submit("owner", { ...input, token: terms.token, acceptUnknown: true }),
		).toMatchObject({
			error: "stale",
		});
		available = true;
		time += pricingMaxAgeMs;
		const changed = await api.submit("owner", {
			...input,
			token: terms.token,
			acceptUnknown: true,
		});
		expect(changed).toMatchObject({ error: "stale", review: { acceptUnknown: false } });
		expect(posted).toBeEmpty();
		if (!("review" in changed)) throw new Error("Expected updated review terms.");
		const expired = changed.review;
		expect(expired.quote).toMatchObject({ status: "unknown", reason: "expired-feed" });
		expect(
			await api.submit("owner", { ...input, token: expired.token, acceptUnknown: true }),
		).toHaveProperty("jobId");
		expect(posted).toHaveLength(1);
	},
);

test("the ordered-edit release's encrypted keys, unused token and durable claim survive the registry upgrade", async () => {
	// Captured with synthetic keys, empty pricing feeds and a local dispatch stub at 3a2432b.
	const terms = "069d582975eb60730f949c8373ebb2469a906e95dac320cf7e0768addcdfb0d8";
	const claimed = "8ae41568-2837-4ec9-b983-dc1a71635208";
	const unused = "f9e639ec-76c7-4ccb-8d22-3ca07d84fd22";
	const originalToken = `${claimed}.${terms}.27509e9726bcdc42f292b3e1af72c9ca5341b0c6916ce27e3ebdd81609680606`;
	const unusedToken = `${unused}.${terms}.0b8a9de8ca4dab2ac90e4c06b9e949d9102399e6b01de93c6736745af59f9dc5`;
	await writeFile(join(dir, providerKeyFilename), Buffer.alloc(32, 24));
	await db.use(async (conn) => {
		await conn.run(sql`UPDATE image_review_key SET secret=${"15".repeat(32)}`);
		await conn.run(sql`UPDATE provider_credential SET revision=1, verified_at=456, seedream=1,
			ciphertext='Nb+iQW0snBXH0Uop0LL+AborL1XtMX4aZE8vvLd1VWlN643LFkuWMfv++qo=' WHERE provider='poyo'`);
		await conn.run(sql`UPDATE provider_credential SET revision=1, verified_at=123, seedream=1,
			ciphertext='3h6COr+RkzokBPV9MXpLCyBRHHTmR5AaDtk7xClcsEDy5lX8iYmydXb6zNeabBhumT8syQ==' WHERE provider='toapis'`);
		await conn.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,poll_deadline)
			VALUES(${claimed},'fc00a5c1397eb184f9aa09aaa345b0e771ae75e46a99deef3aa84429b5f0e873','toapis',1,'{"status":"unknown","reason":"missing-feed","maxAttempts":1}',1,'submitting',1000,'doubao-seedream-5-5',121000)`);
	});
	await db.close();
	db = await openInstallation(dir);
	expect(await providerStore(db).credential("poyo")).toEqual({
		key: "fixture-poyo-key",
		revision: 1,
	});
	const draft = createSeedreamDraft("toapis", "edit");
	draft.prompt = "Make a study in red";
	draft.references = ["second", "first"].map((name) => ({
		kind: "url",
		url: `https://images.example.org/${name}.png`,
		hostname: "images.example.org",
	}));
	const live = parseQueueRequest({ draft, count: 1, retryLimit: 0, acceptUnknown: true });
	if (!live) throw new Error("Expected the pre-registry draft to resolve.");
	const api = await queue();
	// G9 binds a ToAPIs Review's access evidence, so the unused token is stale and sends nothing;
	// its fresh Review queues under the pre-snapshot exception.
	const refused = await api.submit("owner", { ...live, token: unusedToken });
	expect(refused).toMatchObject({ error: "stale", review: { access: { state: "exception" } } });
	expect(posted).toEqual([]);
	if (!("review" in refused)) throw new Error("Expected a fresh Review.");
	expect(await api.submit("owner", { ...live, token: refused.review.token })).toHaveProperty(
		"jobId",
	);
	expect(posted).toEqual(["fixture-global-image-key"]);
	await providerStore(db).remove("toapis");
	expect(await api.submit("owner", { ...live, token: originalToken })).toEqual({ jobId: claimed });
	expect(posted).toEqual(["fixture-global-image-key"]);
});

// Every D4 state but declared. Image Reviews bind no D4 wording yet, so each blocks here,
// including the queueing states, until a slice binds their acknowledgement or disclosure.
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

test.each([
	["poyo", []],
	["poyo", [referenceUrl]],
	["toapis", []],
	["toapis", [referenceUrl]],
] as const)(
	"a readable %s credential cannot override filtering evidence other than declared (%p)",
	async (provider, urls) => {
		const api = await queue();
		const input = makeInput(provider, ...urls);
		expect(input.entry.evidence).toEqual({ d4: "declared" });
		const approved = await api.review("owner", input);
		if (!("token" in approved)) throw new Error("Expected a compatible contract");
		for (const evidence of undeclared) {
			const blocked = { ...input, entry: { ...input.entry, evidence } };
			expect(await api.review("owner", blocked)).toEqual({ error: "invalid" });
			expect(
				await api.submit("owner", { ...blocked, token: approved.token, acceptUnknown: true }),
			).toEqual({ error: "invalid" });
		}
		expect(posted).toBeEmpty();
		expect(
			await api.submit("owner", { ...input, token: approved.token, acceptUnknown: true }),
		).toHaveProperty("jobId");
		expect(posted).toHaveLength(1);
	},
);

test.each(["poyo", "toapis"] as const)(
	"a %s credential losing access blocks new claims independently of the other route",
	async (provider) => {
		const api = await queue();
		const input = makeInput(provider, referenceUrl);
		const terms = await api.review("owner", input);
		if (!("token" in terms)) throw new Error("Expected eligible credential.");
		if (provider === "toapis") {
			// The replacement key was accepted, but the global image list omitted this model.
			await providerStore(db).save("toapis", "restricted-fixture-key", 124, false, 1);
		} else {
			await db.use((conn) =>
				conn.run(sql`UPDATE provider_credential SET ciphertext='unreadable' WHERE provider='poyo'`),
			);
		}
		if (provider === "toapis") {
			// Any readable ToAPIs key reviews; with no snapshot and no flag it cannot queue.
			expect(await api.review("owner", input)).toMatchObject({
				blockers: ["Check ToAPIs model access."],
			});
			expect(
				await api.submit("owner", { ...input, token: terms.token, acceptUnknown: true }),
			).toMatchObject({ error: "stale", review: { blockers: ["Check ToAPIs model access."] } });
		} else {
			expect(await api.review("owner", input)).toEqual({ error: "stale" });
			expect(
				await api.submit("owner", { ...input, token: terms.token, acceptUnknown: true }),
			).toEqual({ error: "stale" });
		}
		expect(
			await api.review("owner", makeInput(provider === "poyo" ? "toapis" : "poyo")),
		).toHaveProperty("token");
		expect(posted).toBeEmpty();
	},
);

test.each(["generate", "edit"] as const)(
	"Z-Image %s binds one accepted balance-only revision and replays after restart",
	async (operation) => {
		await providerStore(db).save("poyo", "balance-only", 234, false, 1);
		const edit = operation === "edit";
		const operationKey = {
			provider: "poyo",
			model: "z-image",
			route: "POST /api/generate/submit",
			operation: edit ? "reference-image-edit" : "text-to-image",
		};
		const draft = {
			provider: "poyo",
			operation,
			prompt,
			options: edit ? {} : { size: "9:16" },
			references: edit ? [{ kind: "url", url: referenceUrl }] : [],
		};
		const raw = { operationKey, draft, count: 1, retryLimit: 0, acceptUnknown: false };
		const live = parseQueueRequest(raw);
		if (!live) throw new Error("Expected registered Z-Image request");
		for (const change of [
			{ count: 2 },
			{ retryLimit: 1 },
			{ operationKey: undefined },
			{
				operationKey: {
					...operationKey,
					operation: edit ? "text-to-image" : "reference-image-edit",
				},
			},
			{ draft: { ...draft, references: [{ kind: "file", file: {} }] } },
			{ draft: { ...draft, options: { ...draft.options, watermark: false } } },
		])
			expect(parseQueueRequest({ ...raw, ...change })).toBeNull();
		const bundled = await loadBundledPricing("poyo");
		if (bundled?.provider !== "poyo") throw new Error("Expected bundled Poyo rates");
		let now = poyoConfirmationMs(bundled);
		let disclosure = zImageDisclosure(operation);
		const api = await createSubmissionQueue(
			db,
			providerStore(db).credential,
			async (_id, _provider, key) => {
				posted.push(key);
			},
			async () => ({ poyo: bundled }),
			() => now,
			undefined,
			() => disclosure,
		);
		const original = await api.review("owner", live);
		if ("error" in original) throw new Error("Expected known price");
		expect(original.quote).toMatchObject({ status: "known", perRequest: "2" });
		for (const evidence of undeclared) {
			const blocked = { ...live, entry: { ...live.entry, evidence } };
			expect(await api.review("owner", blocked)).toEqual({ error: "invalid" });
			expect(await api.submit("owner", { ...blocked, token: original.token })).toEqual({
				error: "invalid",
			});
		}
		disclosure = [...disclosure, "Updated fixture terms"];
		expect(await api.submit("owner", { ...live, token: original.token })).toMatchObject({
			error: "stale",
		});
		disclosure = zImageDisclosure(operation);
		now = poyoFeedExpiryMs(bundled);
		expect(await api.submit("owner", { ...live, token: original.token })).toMatchObject({
			error: "stale",
			review: { quote: { reason: "expired-feed" }, requiresConsent: true },
		});
		const beforeRotation = await api.review("owner", live);
		if ("error" in beforeRotation) throw new Error("Expected expired Review");
		await providerStore(db).save("poyo", "renewed-balance-only", 235, false, 2);
		expect(
			await api.submit("owner", { ...live, token: beforeRotation.token, acceptUnknown: true }),
		).toMatchObject({ error: "stale" });
		expect(posted).toBeEmpty();
		const review = await api.review("owner", live);
		if ("error" in review) throw new Error("Expected balance-accepted key");
		expect(review).toMatchObject({
			requiresConsent: true,
			disclosure: zImageDisclosure(operation),
		});
		const click = { ...live, token: review.token };
		expect(await api.submit("owner", click)).toEqual({ error: "invalid" });
		click.acceptUnknown = true;
		for (const change of [
			{ options: { size: "16:9" } },
			...(edit ? [{ references: [{ kind: "url", url: secondReferenceUrl }] }] : []),
		]) {
			const changed = parseQueueRequest({ ...raw, draft: { ...draft, ...change } });
			if (!changed) throw new Error("Expected valid changed request");
			expect(
				await api.submit("owner", { ...changed, token: review.token, acceptUnknown: true }),
			).toEqual({ error: "invalid" });
		}
		const results = await Promise.all([api.submit("owner", click), api.submit("owner", click)]);
		expect(results[0]).toHaveProperty("jobId");
		expect(results[1]).toEqual(results[0]);
		expect(posted).toEqual(["renewed-balance-only"]);
		const row = await db.use((conn) => conn.get(sql`SELECT * FROM image_job`));
		expect(row).toMatchObject({ revision: 3, model: "z-image", operation: operationKey.operation });
		for (const privateValue of [prompt, referenceUrl, "balance-only"])
			expect(JSON.stringify(row)).not.toContain(privateValue);
		await providerStore(db).remove("poyo");
		await db.close();
		db = await openInstallation(dir);
		expect(await (await queue()).submit("owner", click)).toEqual(results[0]);
		expect(posted).toHaveLength(1);
	},
);

describe("derived text-to-image rows", () => {
	const derivedPrompt = "A paper crane on a windowsill";
	const rowOf = (model: string) => {
		const found = derivedRows.row({
			provider: "poyo",
			model,
			route: "POST /api/generate/submit",
			operation: "text-to-image",
		});
		if (!found) throw new Error(`${model} is not a queue row.`);
		return found;
	};
	const derivedInput = (model: string, prompt = derivedPrompt) => {
		const row = rowOf(model);
		const parsed = parseDerivedRequest(
			{
				draft: { ...createDerivedDraft(row), prompt },
				operationKey: row.key,
				count: 1,
				retryLimit: 0,
				acceptUnknown: false,
			},
			"review",
		);
		if (!parsed) throw new Error(`Invalid ${model} request fixture.`);
		return parsed;
	};
	// What a submit click carries: the same body, parsed structurally.
	const click = (input: ReturnType<typeof derivedInput>, token: string, accept = true) => {
		const parsed = parseDerivedRequest(
			{
				draft: input.draft,
				operationKey: input.key,
				count: 1,
				retryLimit: 0,
				acceptUnknown: accept,
				token,
			},
			"submit",
		);
		if (!parsed) throw new Error("Invalid click fixture.");
		return parsed;
	};
	const sent: { key: string; request: unknown }[] = [];
	const derivedQueue = (
		options: Parameters<typeof createSubmissionQueue>[7] = {},
		feeds: () => PricingFeeds = () => ({}),
		now = Date.now,
	) =>
		createSubmissionQueue(
			db,
			providerStore(db).credential,
			async (_id, _provider, key, request) => {
				sent.push({ key, request });
			},
			async () => feeds(),
			now,
			undefined,
			undefined,
			options,
		);
	const withRow = (model: string, change: (row: QueueRow) => QueueRow | undefined) => ({
		row: (key: QueueKey) => (key.model === model ? change(rowOf(model)) : derivedRows.row(key)),
		schemas: derivedRows.schemas,
	});
	beforeEach(() => {
		sent.length = 0;
	});

	test("a declared row queues one POST on a balance-verified key and stores its contract", async () => {
		expect(await providerStore(db).save("poyo", "fixture-poyo", 124, false, 1)).toBe(true);
		const api = await derivedQueue();
		const input = derivedInput("seedream-4.5");
		const review = await api.review("owner", input);
		if (!("token" in review)) throw new Error(`Expected Review, got ${JSON.stringify(review)}`);
		expect(review.requiresConsent).toBe(true);
		expect(review.quote).toMatchObject({ status: "unknown" });
		expect(review.wording).toEqual(derivedWording(rowOf("seedream-4.5")));
		expect(review.wording.d4).toEqual([]);
		expect(await api.submit("owner", click(input, review.token, false))).toEqual({
			error: "invalid",
		});
		const claimed = await api.submit("owner", click(input, review.token));
		if (!("jobId" in claimed)) throw new Error(`Expected a claim, got ${JSON.stringify(claimed)}`);
		expect(sent).toEqual([{ key: "fixture-poyo", request: input.request }]);
		const job = await db.use((conn) =>
			conn.get<{ model: string; operation: string; contract: string }>(
				sql`SELECT model, operation, contract FROM image_job WHERE id=${claimed.jobId}`,
			),
		);
		expect(job).toMatchObject({ model: "seedream-4.5", operation: "text-to-image" });
		expect(JSON.parse(job?.contract ?? "")).toMatchObject({
			operationKey: rowOf("seedream-4.5").key,
			rowDigest: rowOf("seedream-4.5").contract,
			formats: { sent: null, expected: null },
		});
		// Shipped Seedream 5.5 still needs the key's Seedream check.
		const seedream = await api.review("owner", makeInput("poyo"));
		expect(seedream).toEqual({ error: "stale" });
	});

	test("an open-absent row queues only with its bound disclosure and sends the D4 field as false", async () => {
		const input = derivedInput("flux-dev");
		const api = await derivedQueue();
		const review = await api.review("owner", input);
		if (!("token" in review)) throw new Error("Expected Review.");
		expect(review.wording.d4).toEqual([d4Disclosure("poyo")]);
		const withoutDisclosure = await derivedQueue({
			wording: (row) => ({ ...derivedWording(row), d4: [] }),
		});
		expect(await withoutDisclosure.review("owner", input)).toEqual({ error: "invalid" });
		expect(await withoutDisclosure.submit("owner", click(input, review.token))).toEqual({
			error: "invalid",
		});
		expect(sent).toEqual([]);
		expect(await api.submit("owner", click(input, review.token))).toHaveProperty("jobId");
		expect(sent).toHaveLength(1);
		expect(
			(sent[0].request as { body: { input: Record<string, unknown> } }).body.input,
		).toMatchObject({
			n: 1,
			enable_safety_checker: false,
		});
	});

	test("a derived Review and a new claim refuse every D4 state but declared and open-absent", async () => {
		const input = derivedInput("flux-dev");
		const review = await (await derivedQueue()).review("owner", input);
		if (!("token" in review)) throw new Error("Expected Review.");
		const states: FilteringEvidence[] = [
			{ d4: "closed-absent", closedBy: "api" },
			{ d4: "open-absent-fixed" },
			{ d4: "contradiction" },
			{ d4: "refused" },
			{ d4: "unknown" },
		];
		for (const d4 of states) {
			// The default wording binds each state's own acknowledgement or disclosure.
			const api = await derivedQueue({ rows: withRow("flux-dev", (row) => ({ ...row, d4 })) });
			expect([d4.d4, await api.review("owner", input)]).toEqual([d4.d4, { error: "invalid" }]);
			expect([d4.d4, await api.submit("owner", click(input, review.token))]).toEqual([
				d4.d4,
				{ error: "invalid" },
			]);
		}
		expect(sent).toEqual([]);
	});

	test("a changed body, wording, Gallery statement, contract digest or credential revision is stale", async () => {
		const input = derivedInput("flux-dev");
		const review = await (await derivedQueue()).review("owner", input);
		if (!("token" in review)) throw new Error("Expected Review.");
		const variants: Parameters<typeof createSubmissionQueue>[7][] = [
			{ rows: withRow("flux-dev", (row) => ({ ...row, count: null })) },
			{ rows: withRow("flux-dev", (row) => ({ ...row, contract: "0".repeat(64) })) },
			{ wording: (row) => ({ ...derivedWording(row), samePath: "Another sentence." }) },
			{ wording: (row) => ({ ...derivedWording(row), gallery: "Gallery saves anything." }) },
			{ wording: (row) => ({ ...derivedWording(row), access: "Another access note." }) },
			{
				wording: (row) => ({
					...derivedWording(row),
					d4: [d4Disclosure("poyo"), "Another bound sentence."],
				}),
			},
		];
		for (const options of variants) {
			const result = await (await derivedQueue(options)).submit(
				"owner",
				click(input, review.token),
			);
			expect(result).toMatchObject({ error: "stale" });
		}
		expect(await providerStore(db).save("poyo", "fixture-poyo", 125, true, 1)).toBe(true);
		expect(await (await derivedQueue()).submit("owner", click(input, review.token))).toMatchObject({
			error: "stale",
		});
		expect(sent).toEqual([]);
		expect(await db.use((conn) => conn.all(sql`SELECT id FROM image_job`))).toEqual([]);
	});

	test("a claimed Review replays after a re-pin removes or narrows its row; an unclaimed one is stale", async () => {
		const api = await derivedQueue();
		const claimedInput = derivedInput("flux-dev");
		const waitingInput = derivedInput("flux-dev", "A second paper crane");
		const [claimedReview, waitingReview] = await Promise.all([
			api.review("owner", claimedInput),
			api.review("owner", waitingInput),
		]);
		if (!("token" in claimedReview) || !("token" in waitingReview))
			throw new Error("Expected Reviews.");
		const claimed = await api.submit("owner", click(claimedInput, claimedReview.token));
		if (!("jobId" in claimed)) throw new Error("Expected a claim.");
		expect(sent).toHaveLength(1);
		const removed = await derivedQueue({ rows: withRow("flux-dev", () => undefined) });
		const narrowed = await derivedQueue({
			rows: withRow("flux-dev", (row) => ({
				...row,
				fields: row.fields.map((field) =>
					field.wire === "output_format"
						? { ...field, values: ["jpeg"], preselect: "jpeg" }
						: field,
				),
			})),
		});
		for (const repinned of [removed, narrowed]) {
			expect(await repinned.submit("owner", click(claimedInput, claimedReview.token))).toEqual(
				claimed,
			);
			expect(
				await repinned.submit("owner", click(waitingInput, waitingReview.token)),
			).toMatchObject({ error: "stale" });
		}
		expect(sent).toHaveLength(1);
	});

	test("a derived row with a paired rate shows its estimate in place of consent", async () => {
		const feed = decodePoyoV2Feed(pair.feed);
		const basis = decodePoyoBasis(pair.basis);
		if (!feed || !basis) throw new Error("The basis fixture does not decode.");
		const time = Date.parse(feed.confirmedAt) + 1000;
		let feeds: PricingFeeds = { poyo: feed, poyoBasis: basis };
		const api = await derivedQueue(
			{},
			() => feeds,
			() => time,
		);
		const input = derivedInput("gpt-4o-image");
		const review = await api.review("owner", input);
		if (!("token" in review)) throw new Error("Expected Review.");
		expect(review.quote).toMatchObject({ status: "known", perRequest: "4", maxAttempts: 1 });
		expect(review.requiresConsent).toBe(false);
		// The same Review without the basis is unknown-price again, so the claim is stale.
		feeds = { poyo: feed };
		const unpaired = await api.submit("owner", click(input, review.token, false));
		expect(unpaired).toMatchObject({
			error: "stale",
			review: { requiresConsent: true, quote: { status: "unknown", reason: "rate-unavailable" } },
		});
		feeds = { poyo: feed, poyoBasis: basis };
		expect(await api.submit("owner", click(input, review.token, false))).toHaveProperty("jobId");
		expect(sent).toHaveLength(1);
	});

	test("a derived quote that expires between Review and Queue goes stale with zero POSTs", async () => {
		const feed = decodePoyoV2Feed(pair.feed);
		const basis = decodePoyoBasis(pair.basis);
		if (!feed || !basis) throw new Error("The basis fixture does not decode.");
		let time = poyoFeedExpiryMs(feed) - 1000;
		const api = await derivedQueue(
			{},
			() => ({ poyo: feed, poyoBasis: basis }),
			() => time,
		);
		const input = derivedInput("kling-o3-image");
		const review = await api.review("owner", input);
		if (!("token" in review)) throw new Error("Expected Review.");
		expect(review.quote).toMatchObject({ status: "known", perRequest: "3.5" });
		time += 1000;
		const expired = await api.submit("owner", click(input, review.token, false));
		expect(expired).toMatchObject({
			error: "stale",
			review: { requiresConsent: true, quote: { status: "unknown", reason: "expired-feed" } },
		});
		expect(sent).toEqual([]);
	});

	test("a tampered draft, another owner and a bad signature are refused before the lookup", async () => {
		const api = await derivedQueue();
		const input = derivedInput("flux-dev");
		const review = await api.review("owner", input);
		if (!("token" in review)) throw new Error("Expected Review.");
		const claimed = await api.submit("owner", click(input, review.token));
		expect(claimed).toHaveProperty("jobId");
		const tampered = click(input, review.token);
		tampered.draft = { ...tampered.draft, prompt: `${derivedPrompt} at night` };
		const [id, terms, signed] = review.token.split(".");
		for (const [owner, value] of [
			["owner", tampered],
			["other", click(input, review.token)],
			[
				"owner",
				click(input, `${id}.${terms}.${signed.slice(0, -1)}${signed.endsWith("0") ? "1" : "0"}`),
			],
		] as const)
			expect(await api.submit(owner, value)).toEqual({ error: "invalid" });
		expect(sent).toHaveLength(1);
	});
});
