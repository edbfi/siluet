import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { toapisRates } from "../../../../../tests/fixtures/toapis-feed";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { pricingMaxAgeMs } from "../../../shared/pricing/feed";
import { decodeToapisPricingFeed } from "../../../shared/pricing/toapis-feed";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { createProviderConnections } from "../providers/connections";
import { parseQueueRequest } from "./request";
import { createSubmissionQueue } from "./submission";

let db: Installation;
let dir: string;
let posted: string[];
function makeInput(provider: "poyo" | "toapis" = "poyo") {
	const parsed = parseQueueRequest({
		draft: { ...createSeedreamDraft(provider), prompt: "private prompt with a folded fan" },
		count: 1,
		retryLimit: 0,
		acceptUnknown: false,
	});
	if (!parsed) throw new Error("Invalid generation fixture");
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

test.each(["poyo", "toapis"] as const)(
	"a %s Review permits exactly one accepted generation across concurrent clicks and restart",
	async (provider) => {
		const input = makeInput(provider);
		const api = await queue();
		const review = await api.review("owner", input);
		if ("error" in review) throw new Error("expected Review");
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

test("a known ToAPIs standard rate requires fallback consent, and changing or expiring its rate invalidates the review", async () => {
	const feed = decodeToapisPricingFeed(toapisRates);
	if (!feed) throw new Error("Invalid fixture rate.");
	let time = Date.parse(feed.observedAt) + 100;
	let available = true;
	const input = makeInput("toapis");
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
	expect(terms.quote.status).toBe("known");
	expect(terms.requiresConsent).toBe(true);
	expect(await api.submit("owner", { ...input, token: terms.token })).toEqual({ error: "invalid" });
	available = false;
	expect(
		await api.submit("owner", { ...input, token: terms.token, acceptUnknown: true }),
	).toMatchObject({
		error: "stale",
	});
	available = true;
	time += pricingMaxAgeMs;
	const changed = await api.submit("owner", { ...input, token: terms.token, acceptUnknown: true });
	expect(changed).toMatchObject({ error: "stale", review: { acceptUnknown: false } });
	expect(posted).toBeEmpty();
	if (!("review" in changed)) throw new Error("Expected updated review terms.");
	const expired = changed.review;
	expect(expired.quote).toMatchObject({ status: "unknown", reason: "expired-feed" });
	expect(
		await api.submit("owner", { ...input, token: expired.token, acceptUnknown: true }),
	).toHaveProperty("jobId");
	expect(posted).toHaveLength(1);
});
