import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIResponse, expect, type Page, test } from "@playwright/test";
import poyoBundle from "../../pricing/v1/feed.json";
import toapisBundle from "../../pricing/v1/toapis.json";
import { pricingCachePath } from "../../src/lib/server/services/pricing/local-feed";
import {
	createSeedreamDraft,
	type SeedreamProvider,
} from "../../src/lib/shared/image-studio/seedream";
import { seedLegacyToapisReviews } from "../fixtures/legacy-reference-review";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys } from "../fixtures/provider-connections";
import {
	editedImagePath,
	editedImageSignature,
	editedPng,
	referenceEditFixtures,
	referenceHost,
	referenceMarkers,
	referenceQueryMarker,
	secondSignedReference,
	signedReference,
	tenSignedReferences,
} from "../fixtures/reference-edit";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { startStudio } from "./built-studio";

const promptMarker = "private-edit-prompt";
const promptUrlMarker = "private-prompt-url";
const prompt = `Move the sculpture beside ${promptMarker}. See <https://prompt.example.test/?sig=${promptUrlMarker}>.`;
const updatedSignature = "private-updated-signature";
const changedReference = signedReference.replace(referenceQueryMarker, updatedSignature);
const privateNames = ["fixture-handbag-private-name", "fixture-table-private-name"];
const bundledObservation = { poyo: poyoBundle.sourceDate, toapis: toapisBundle.observedAt };

function edit(provider: SeedreamProvider, urls: readonly string[] = [signedReference]) {
	return {
		draft: {
			...createSeedreamDraft(provider, "edit"),
			prompt,
			references: urls.map((url) => ({ kind: "url", url: `  ${url}  ` })),
		},
		count: 1,
		retryLimit: 0,
		acceptUnknown: false,
	};
}

function editOperationKey(provider: SeedreamProvider) {
	return {
		provider,
		model: provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5",
		route: provider === "poyo" ? "POST /api/generate/submit" : "POST /v1/images/generations",
		operation: "reference-image-edit",
	};
}

function providerPayload(provider: SeedreamProvider, urls = [signedReference], text = prompt) {
	const output = { background: "auto", output_format: "png" };
	return provider === "poyo"
		? {
				model: "seedream-5.5",
				input: {
					prompt: text,
					size: "auto",
					resolution: "2K",
					...output,
					enable_safety_checker: false,
					image_urls: urls,
				},
			}
		: {
				model: "doubao-seedream-5-5",
				prompt: text,
				size: "2K",
				disable_nsfw: false,
				metadata: { ...output, watermark: false },
				image_urls: urls,
			};
}

async function readReview(response: APIResponse) {
	expect(response.status()).toBe(200);
	const review = (await response.json()) as {
		token: string;
		requiresConsent: boolean;
		quote: unknown;
	};
	expect(review).toMatchObject({
		token: expect.any(String),
		requiresConsent: expect.any(Boolean),
	});
	return review;
}

type Outcome = NonNullable<Parameters<typeof referenceEditFixtures>[1]>;
type Studio = Awaited<ReturnType<typeof startStudio>>;

async function withEditStudio(
	page: Page,
	provider: SeedreamProvider,
	outcome: Outcome,
	run: (context: {
		origin: string;
		cacheHome: string;
		rates: { observedAt: string; observedMs: number };
		fixtures: ReturnType<typeof referenceEditFixtures>;
		post: (path: string, data: unknown, from?: string) => ReturnType<Page["request"]["post"]>;
		restart: <T>(prepare?: (directory: string) => Promise<T>) => Promise<T | undefined>;
		assertRedacted: (value: string) => void;
		assertPrivate: (includePage?: boolean) => Promise<void>;
		assertOneSubmission: () => void;
	}) => Promise<void>,
	fixtureTime?: number,
) {
	const dir = await createOwnerDirectory();
	const fixtures = referenceEditFixtures(provider, outcome, prompt);
	const cacheHome = await mkdtemp(join(tmpdir(), "siluet-reference-pricing-"));
	const env = {
		...fixtures.env,
		XDG_CACHE_HOME: cacheHome,
		...(fixtureTime === undefined ? {} : { SILUET_TEST_PROVIDER_TIME: String(fixtureTime) }),
	};
	let studio: Studio | undefined;
	try {
		const observedAt = bundledObservation[provider];
		const rates =
			fixtureTime === undefined
				? await writeReviewPricing(cacheHome, 0)
				: { observedAt, observedMs: Date.parse(observedAt) };
		studio = await startStudio(dir, "0", false, env);
		const origin = studio.origin.origin;
		const port = studio.origin.port;
		const browserRequests: string[] = [];
		const browserMessages: string[] = [];
		page.on("console", (message) => browserMessages.push(message.text()));
		page.on("pageerror", (error) => browserMessages.push(error.message));
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (new URL(url).origin === origin) return route.continue();
			browserRequests.push(url);
			return route.abort();
		});
		await expect.poll(studio.token).not.toBe("");
		const setup = await page.request.post(`${origin}/setup`, {
			headers: { origin, accept: "text/html" },
			form: { token: studio.token(), username: "creator", password: crypto.randomUUID() },
			maxRedirects: 0,
		});
		expect(setup.status()).toBe(303);
		const connected = await page.request.post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider, key: providerFixtureKeys[provider] },
		});
		expect(connected.ok()).toBe(true);

		function assertRedacted(value: string) {
			for (const marker of [
				...referenceMarkers,
				...privateNames,
				updatedSignature,
				promptMarker,
				promptUrlMarker,
				editedImageSignature,
				providerFixtureKeys[provider],
			]) {
				expect(value).not.toContain(marker);
			}
		}
		const assertPrivate = async (includePage = true) => {
			assertRedacted(studio?.diagnostics() ?? "");
			assertRedacted(browserMessages.join("\n"));
			const { origins } = await page.context().storageState({ indexedDB: true });
			assertRedacted(JSON.stringify(origins));
			assertRedacted(
				await page.evaluate(async () =>
					JSON.stringify([
						sessionStorage,
						...(await Promise.all(
							(
								await caches.keys()
							).map(async (key) => {
								const cache = await caches.open(key);
								return Promise.all(
									(await cache.keys()).map(async (request) => [
										request.url,
										await (await cache.match(request))?.text(),
									]),
								);
							}),
						)),
					]),
				),
			);
			if (includePage) assertRedacted(await page.content());
			expect(browserRequests).toEqual([]);
			expect(fixtures.requests.filter(({ path }) => path === "/unexpected")).toEqual([]);
		};
		await run({
			origin,
			cacheHome,
			rates,
			fixtures,
			async post(path, data, from = origin) {
				const response = await page.request.post(origin + path, {
					data,
					headers: { origin: from },
				});
				assertRedacted(await response.text());
				return response;
			},
			async restart(prepare) {
				await studio?.stop(outcome !== "crash-after-acceptance");
				assertRedacted(studio?.diagnostics() ?? "");
				studio = undefined;
				const prepared = await prepare?.(dir);
				const paths = await readdir(dir, { recursive: true });
				expect(paths).toContain("studio.db");
				assertRedacted(paths.join("\n"));
				for (const file of paths.filter((file) => file.startsWith("studio.db"))) {
					assertRedacted((await readFile(join(dir, file))).toString("latin1"));
				}
				studio = await startStudio(dir, port, false, env);
				return prepared;
			},
			assertRedacted,
			assertPrivate,
			assertOneSubmission() {
				expect(fixtures.requests.filter(({ path }) => path.endsWith("/submit"))).toEqual([
					{ path: `/${provider}/submit`, method: "POST", key: providerFixtureKeys[provider] },
				]);
			},
		});
	} finally {
		await studio?.stop();
		await fixtures.stop();
		await rm(dir, { recursive: true, force: true });
		await rm(cacheHome, { recursive: true, force: true });
	}
}

async function chooseReference(page: Page, slot: number, url: string) {
	await page
		.getByText("Use a URL", { exact: true })
		.nth(slot - 1)
		.press("Enter");
	const field = page.getByRole("textbox", {
		name: `HTTP or HTTPS URL for reference image ${slot}`,
	});
	await field.fill(`  ${url}  `);
	const name = privateNames[slot - 1];
	if (name) {
		await page
			.getByRole("textbox", {
				name: `Private name for reference ${slot === 1 ? "A" : "B"}`,
			})
			.fill(name);
	}
	await field.press("Enter");
}

for (const provider of ["poyo", "toapis"] as const) {
	test(`${provider} validates direct edit limits and authorizes the exact ordered payload`, async ({
		page,
	}) => {
		await withEditStudio(
			page,
			provider,
			"completed",
			async ({ origin, rates, fixtures, post, assertPrivate }) => {
				const before = fixtures.requests.length;
				const pair = [secondSignedReference, signedReference];
				const selections = [[signedReference], pair, tenSignedReferences];
				const quotes = ["8.6", "10.2", "23"];
				const clicks = await Promise.all(
					selections.map(async (urls, index) => {
						const input = edit(provider, urls);
						const review = await readReview(await post("/image/review", input));
						const perRequest = provider === "poyo" ? quotes[index] : "5.6";
						expect(review).toMatchObject({
							requiresConsent: provider === "toapis",
							quote: {
								status: "known",
								sourceDate: rates.observedAt,
								perRequest,
								batch: perRequest,
								maxAttempts: 1,
								...(provider === "toapis" && { usd: { perRequest: "0.028", batch: "0.028" } }),
							},
						});
						return { ...input, token: review.token, acceptUnknown: review.requiresConsent };
					}),
				);
				const [single, two, ten] = clicks;
				const file = { kind: "file", file: { name: "fixture-local-only.png" } };
				const invalid = [
					{ ...single, draft: edit(provider, []).draft },
					{ ...ten, draft: edit(provider, [...tenSignedReferences, changedReference]).draft },
					{ ...single, draft: edit(provider, [signedReference, ` ${signedReference}\t`]).draft },
					{ ...single, draft: edit(provider, [signedReference, "not a URL"]).draft },
					{ ...single, draft: { ...single.draft, references: [file] } },
					{ ...single, draft: { ...single.draft, references: [...single.draft.references, file] } },
					{ ...two, count: 6 },
					{ ...two, retryLimit: 4 },
				];
				for (const route of ["/image/review", "/image/queue"]) {
					for (const input of invalid) {
						const response = await post(route, input);
						expect(response.status()).toBe(400);
						expect(await response.json()).toEqual({ error: "invalid" });
					}
				}
				for (const changed of [
					[signedReference, secondSignedReference],
					[secondSignedReference, changedReference],
				]) {
					const response = await post("/image/queue", {
						...two,
						draft: edit(provider, changed).draft,
					});
					expect(response.status()).toBe(400);
				}
				await page.goto(`${origin}/jobs`);
				await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
				expect(fixtures.requests.slice(before)).toEqual([]);

				const jobIds = new Set<string>();
				for (const click of clicks) {
					const queued = await post("/image/queue", click);
					expect(queued.status()).toBe(200);
					const result = (await queued.json()) as { jobId: string };
					expect(result.jobId).toEqual(expect.any(String));
					jobIds.add(result.jobId);
				}
				expect(jobIds.size).toBe(clicks.length);
				expect(fixtures.submissions).toEqual(
					selections.map((urls) => providerPayload(provider, urls)),
				);
				await page.reload();
				await expect(page.getByRole("article")).toHaveCount(clicks.length);
				await assertPrivate();
			},
			Date.parse(bundledObservation[provider]),
		);
	});

	test(`${provider} requires fresh consent when bundled edit rates have expired`, async ({
		page,
	}) => {
		await withEditStudio(
			page,
			provider,
			"completed",
			async ({ origin, fixtures, post }) => {
				const before = fixtures.requests.length;
				const input = edit(provider, [signedReference, secondSignedReference]);
				const review = await readReview(await post("/image/review", input));
				expect(review).toMatchObject({
					requiresConsent: true,
					quote: { status: "unknown", reason: "expired-feed" },
				});
				const click = { ...input, token: review.token };
				expect((await post("/image/queue", click)).status()).toBe(400);
				await page.goto(`${origin}/jobs`);
				await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
				expect(fixtures.requests.slice(before)).toEqual([]);
				expect((await post("/image/queue", { ...click, acceptUnknown: true })).status()).toBe(200);
				expect(fixtures.submissions).toEqual([
					providerPayload(provider, [signedReference, secondSignedReference]),
				]);
			},
			Date.parse(bundledObservation[provider]) + 30 * 86_400_000,
		);
	});

	test(`${provider} reviews reordered slots, queues once and saves distinct output for offline reopening`, async ({
		page,
	}) => {
		test.setTimeout(75_000);
		await withEditStudio(
			page,
			provider,
			"download-fails-once",
			async ({
				origin,
				rates,
				fixtures,
				restart,
				assertPrivate,
				assertRedacted,
				assertOneSubmission,
			}) => {
				const beforeReview = fixtures.requests.length;
				const reviewPosts: unknown[] = [];
				const queuePosts: unknown[] = [];
				page.on("request", (request) => {
					if (request.method() !== "POST") return;
					if (request.url() === `${origin}/image/review`) reviewPosts.push(request.postDataJSON());
					if (request.url() === `${origin}/image/queue`) queuePosts.push(request.postDataJSON());
				});
				await page.clock.setFixedTime(new Date(rates.observedMs + 60_000));
				await page.setViewportSize({ width: 320, height: 760 });
				await page.goto(`${origin}/image`);
				await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
				await page.getByLabel("Operation", { exact: true }).selectOption("edit");
				await chooseReference(page, 1, signedReference);
				await chooseReference(page, 2, secondSignedReference);
				const review = page.getByRole("region", { name: "Review request", exact: true });
				const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
				const inspect = review.getByRole("button", { name: "Review request", exact: true });
				const queue = review.getByRole("button", { name: "Queue 1 request", exact: true });
				const consent = review.getByRole("checkbox", { name: /unknown/i });
				const inspectDraft = async () => {
					const [response] = await Promise.all([
						page.waitForResponse(`${origin}/image/review`),
						inspect.press("Enter"),
					]);
					expect(response.status()).toBe(200);
					assertRedacted(await response.text());
					await expect(inspect).toHaveCount(0);
					return ((await response.json()) as { token: string }).token;
				};
				await inspectDraft();
				if (provider === "toapis") {
					await expect(consent).toHaveAccessibleName(/fallback/i);
					await expect(queue).toBeDisabled();
					await consent.press("Space");
					await expect(consent).toBeChecked();
				}
				const request = page.getByRole("region", { name: "Request", exact: true });
				for (const area of [request, facts]) {
					if (provider === "poyo") {
						await expect(area).toContainText(/“image 1” and “image 2”/);
						await expect(area).toContainText(/Poyo.ai determines framing/);
					} else {
						await expect(area).toContainText(/Numbered prompt references are unspecified/);
					}
				}
				await request.getByRole("button", { name: "Move up reference image 2" }).press("Enter");
				await expect(
					request.getByRole("button", { name: "Move down reference image 1" }),
				).toBeFocused();
				await expect(
					request.getByRole("status").filter({ hasText: "Reference B moved to position 1 of 2." }),
				).toBeVisible();
				await expect(inspect).toBeEnabled();
				await expect(queue).toBeDisabled();
				await chooseReference(page, 3, tenSignedReferences[2]);
				await page.getByRole("button", { name: "Remove reference image 3" }).press("Enter");
				const menu = page.getByRole("button", { name: "Menu", exact: true });
				const navigation = page.getByRole("dialog");
				const openMenu = async () => {
					await menu.press("Enter");
					await expect(navigation.getByRole("button", { name: "Close menu" })).toBeFocused();
				};
				await openMenu();
				await navigation.getByRole("link", { name: "Settings", exact: true }).press("Enter");
				await expect(navigation).toHaveCount(0);
				await expect(page.getByRole("heading", { name: "Provider connections" })).toBeVisible();
				await openMenu();
				await navigation.getByRole("link", { name: "Image Studio", exact: true }).press("Enter");
				await expect(page).toHaveURL(`${origin}/image`);
				for (const [index, label] of ["A", "B"].entries()) {
					await expect(
						page.getByRole("textbox", { name: `Private name for reference ${label}`, exact: true }),
					).toHaveValue(privateNames[index]);
				}
				await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(
					prompt,
				);
				const token = await inspectDraft();
				if (provider === "toapis") {
					await expect(consent).not.toBeChecked();
					await expect(queue).toBeDisabled();
					await consent.press("Space");
				}
				await expect(
					facts.getByRole("list").filter({ hasText: referenceHost }).getByRole("listitem"),
				).toHaveText([
					`1. Reference B · ${referenceHost} (URL reference)`,
					`2. Reference A · ${referenceHost} (URL reference)`,
				]);
				for (const name of privateNames) await expect(facts).not.toContainText(name);
				const disclosure = facts.getByRole("list", { name: "Provider disclosure" });
				for (const text of [
					/every full (reference )?URL/i,
					/path/i,
					/quer(?:y|ies) with any signature/i,
					/fragment/i,
					/upstream model services/i,
					/copy.*after the link expires/i,
				])
					await expect(disclosure).toContainText(text);
				await expect(disclosure).toContainText(
					provider === "poyo" ? /three months|3 months/i : /90 days/i,
				);
				await expect(disclosure).toContainText(
					/fetched reference images is (unknown|unspecified)/i,
				);
				if (provider === "toapis") await expect(disclosure).toContainText(/through a fallback/i);
				await expect(facts.locator("[data-studio-price]")).toContainText(
					provider === "poyo" ? "10.2 Poyo.ai credits" : "5.6 ToAPIs credits",
				);
				if (provider === "toapis")
					await expect(facts.locator("[data-studio-price]")).toContainText("$0.028 USD");
				await expect(facts.locator("[data-studio-price]")).toContainText(
					rates.observedAt.slice(0, 10),
				);

				await review.getByRole("tab", { name: "Outgoing request" }).press("Enter");
				const outgoing = review.getByRole("tabpanel", { name: "Outgoing request" });
				expect(JSON.parse((await outgoing.locator("pre code").textContent()) ?? "")).toEqual(
					providerPayload(
						provider,
						["[remote URL hidden]", "[remote URL hidden]"],
						prompt.replace(/<.*>/, "<[URL hidden]>"),
					),
				);
				await assertPrivate(false);
				expect(fixtures.requests.slice(beforeReview)).toEqual([]);

				await review.getByRole("tab", { name: "Review", exact: true }).press("Enter");
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					320,
				);
				const [queued] = await Promise.all([
					page.waitForResponse(`${origin}/image/queue`),
					queue.press("Enter"),
				]);
				expect(queued.status()).toBe(200);
				assertRedacted(await queued.text());
				const original = [signedReference, secondSignedReference];
				const reordered = [secondSignedReference, signedReference];
				const browserDraft = (urls: string[]) => ({
					...edit(provider, urls),
					operationKey: editOperationKey(provider),
					draft: {
						...createSeedreamDraft(provider, "edit"),
						prompt,
						references: urls.map((url) => ({ kind: "url", url, hostname: referenceHost })),
					},
				});
				expect(reviewPosts).toEqual([browserDraft(original), browserDraft(reordered)]);
				expect(queuePosts).toEqual([
					{ ...browserDraft(reordered), token, acceptUnknown: provider === "toapis" },
				]);
				await expect(page).toHaveURL(/\/jobs/);
				const job = page.getByRole("article");
				await expect(job).toHaveCount(1);
				await expect(job.getByText("Completed", { exact: true })).toBeVisible({ timeout: 20_000 });
				expect(fixtures.submissions).toEqual([providerPayload(provider, reordered)]);
				assertOneSubmission();
				await assertPrivate();
				expect(fixtures.requests.filter(({ path }) => path === editedImagePath)).toEqual([]);
				const save = job.getByRole("button", { name: "Save to Gallery" });
				await expect(save).toBeEnabled({ timeout: 20_000 });
				const [failedSave] = await Promise.all([
					page.waitForResponse(`${origin}/jobs?/save`),
					save.press("Enter"),
				]);
				assertRedacted(await failedSave.text());
				const open = job.getByRole("link", { name: "Open saved image" });
				await expect(job.getByText(/retry Save on this job/)).toBeVisible();
				await expect(job.getByText("Completed", { exact: true })).toBeVisible();
				await expect(open).toHaveCount(0);
				await assertPrivate();
				await expect(save).toBeEnabled({ timeout: 20_000 });
				await save.press("Enter");
				await expect(open).toBeVisible();
				const path = await open.getAttribute("href");
				if (!path) throw new Error("Missing Gallery link.");
				const downloads = 2;
				expect(fixtures.requests.filter(({ path }) => path === editedImagePath)).toEqual(
					Array.from({ length: downloads }, () => ({
						path: editedImagePath,
						method: "GET",
						key: null,
					})),
				);
				const statusRequests = fixtures.requests.filter(({ path }) => path.includes("/status/"));
				expect(statusRequests.map(({ path }) => path)).toEqual(
					Array.from({ length: downloads + 1 }, () => fixtures.statusPaths[0]),
				);
				await assertPrivate();
				assertOneSubmission();

				await restart();
				const before = fixtures.requests.length;
				const removed = await page.request.post(`${origin}/settings/providers?/remove`, {
					headers: { origin, accept: "text/html" },
					form: { provider, jobWarning: "seen" },
				});
				expect(removed.ok()).toBe(true);
				await page.goto(`${origin}/settings/providers?provider=${provider}`);
				await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
				await page.goto(`${origin}/gallery`);
				await assertPrivate();
				await page.goto(origin + path);
				await expect(page.getByRole("img", { name: /image from job/i })).toBeVisible();
				const media = await page.request.get(`${origin}${path}/media`);
				expect(media.status()).toBe(200);
				expect(media.headers()).toMatchObject({
					"content-type": "image/png",
					"cache-control": "private, no-store",
				});
				expect(await media.body()).toEqual(editedPng);
				expect(fixtures.requests.slice(before)).toEqual([]);
				await assertPrivate();
			},
		);
	});
}

test("direct edit guards reject invalid scope and stale authorization before any attempt", async ({
	page,
	browser,
}) => {
	await withEditStudio(
		page,
		"toapis",
		"completed",
		async ({ origin, fixtures, post, cacheHome }) => {
			const before = fixtures.requests.length;
			const pair = [secondSignedReference, signedReference];
			const input = edit("toapis", pair);
			const other = await browser.newContext();
			try {
				for (const route of ["/image/review", "/image/queue"]) {
					const response = await other.request.post(origin + route, {
						headers: { origin },
						data: input,
					});
					expect(response.status()).toBe(401);
				}
			} finally {
				await other.close();
			}
			const review = await readReview(await post("/image/review", input));
			expect(review).toMatchObject({
				requiresConsent: true,
				quote: { status: "known", perRequest: "5.6" },
			});
			const click = { ...input, token: review.token, acceptUnknown: true };
			const key = editOperationKey("toapis");
			const invalidScopes = [
				{ ...click, operationKey: { ...key, operation: "text-to-image" } },
				{ ...click, operationKey: { ...key, operation: "image-layer-decomposition" } },
				{
					...click,
					operationKey: { ...key, route: "POST https://toapis.cn/v1/images/generations" },
				},
				{ ...click, layer_decomposition: true },
				...[
					"https://images.example.test/reference.png",
					"https://ipv4only.arpa/reference.png",
					"https://resolver.arpa/reference.png",
					"https://printer.service.arpa/reference.png",
					"https://localhost/reference.png",
					"https://user@example.test/reference.png",
				].map((url) => ({ ...click, draft: edit("toapis", [secondSignedReference, url]).draft })),
			];
			for (const route of ["/image/review", "/image/queue"]) {
				expect((await post(route, click, "https://elsewhere.example.test")).status()).toBe(403);
				for (const invalid of invalidScopes) {
					expect((await post(route, invalid)).status()).toBe(400);
				}
			}
			expect((await post("/image/queue", { ...click, acceptUnknown: false })).status()).toBe(400);

			// Change the active price evidence while keeping the same draft and credential.
			const cachePath = pricingCachePath(cacheHome, "toapis");
			const cached = await Bun.file(cachePath).json();
			cached.feed.conversionCacheAgeSeconds = 1;
			await Bun.write(cachePath, JSON.stringify(cached));
			const stalePrice = await post("/image/queue", click);
			expect(stalePrice.status()).toBe(409);
			expect(await stalePrice.json()).toMatchObject({
				error: "stale",
				review: { acceptUnknown: false },
			});
			expect(fixtures.requests.slice(before)).toEqual([]);

			const current = await readReview(await post("/image/review", input));
			const disconnected = await page.request.post(`${origin}/settings/providers?/remove`, {
				headers: { origin, accept: "text/html" },
				form: { provider: "toapis" },
			});
			expect(disconnected.ok()).toBe(true);
			const staleCredential = await post("/image/queue", { ...click, token: current.token });
			expect(staleCredential.status()).toBe(409);
			const jobs = await page.goto(`${origin}/jobs`);
			expect(jobs?.ok()).toBe(true);
			await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
			expect(fixtures.requests.slice(before)).toEqual([]);
		},
	);
});

test("the built app replays a legacy single-reference claim and refreshes unused legacy terms", async ({
	page,
}) => {
	await withEditStudio(
		page,
		"toapis",
		"rejected",
		async ({ origin, cacheHome, fixtures, post, restart, assertPrivate, assertOneSubmission }) => {
			const before = fixtures.requests.length;
			const input = edit("toapis");
			const review = await readReview(await post("/image/review", input));
			const legacy = await restart((directory) =>
				seedLegacyToapisReviews(directory, cacheHome, review.quote, providerPayload("toapis")),
			);
			if (!legacy) throw new Error("Missing legacy Review fixtures.");
			const accepted = { ...input, token: legacy.acceptedToken, acceptUnknown: true };
			const replay = await post("/image/queue", accepted);
			expect(replay.status()).toBe(200);
			expect(await replay.json()).toEqual({ jobId: legacy.acceptedId });
			expect((await post("/image/queue", { ...accepted, acceptUnknown: false })).status()).toBe(
				400,
			);
			const stale = await post("/image/queue", { ...accepted, token: legacy.unusedToken });
			expect(stale.status()).toBe(409);
			const updated = ((await stale.json()) as { review: { token: string } }).review;
			expect(updated).toMatchObject({
				quote: review.quote,
				acceptUnknown: false,
				editDisclosure: expect.arrayContaining([
					expect.stringMatching(/every full reference URL/i),
				]),
			});
			const refreshed = { ...input, token: updated.token };
			expect((await post("/image/queue", refreshed)).status()).toBe(400);
			await page.goto(`${origin}/jobs`);
			await expect(page.getByRole("article")).toHaveCount(1);
			await expect(
				page.getByText("The provider could not read one or more reference images."),
			).toBeVisible();
			expect(fixtures.requests.slice(before)).toEqual([]);
			const click = { ...refreshed, acceptUnknown: true };
			const queued = await post("/image/queue", click);
			expect(queued.status()).toBe(200);
			const result = await queued.json();
			expect(result).not.toEqual({ jobId: legacy.acceptedId });
			expect(fixtures.submissions).toEqual([providerPayload("toapis")]);
			await restart();
			expect(await (await post("/image/queue", accepted)).json()).toEqual({
				jobId: legacy.acceptedId,
			});
			expect(await (await post("/image/queue", click)).json()).toEqual(result);
			await page.reload();
			await expect(page.getByRole("article")).toHaveCount(2);
			await assertPrivate();
			assertOneSubmission();
		},
	);
});

for (const [provider, outcome, state, message] of [
	["poyo", "rejected", "Submission rejected", /rejected the request parameters/],
	["toapis", "rejected", "Submission rejected", /rejected the request parameters/],
	["poyo", "failed", "Job failed", /provider reported that the job failed/i],
	["toapis", "failed", "Job failed", /provider could not read one or more reference images/i],
	["poyo", "timeout", "May have been submitted", /Check provider history/],
	["toapis", "timeout", "May have been submitted", /Check provider history/],
] as const) {
	test(`${provider} ${outcome} keeps one edit attempt and safe details across restart`, async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await withEditStudio(
			page,
			provider,
			outcome,
			async ({ origin, fixtures, post, restart, assertPrivate, assertOneSubmission }) => {
				const urls = [secondSignedReference, signedReference];
				const input = edit(provider, urls);
				const review = await readReview(await post("/image/review", input));
				const click = { ...input, token: review.token, acceptUnknown: review.requiresConsent };
				const [first, second] = await Promise.all([
					post("/image/queue", click),
					post("/image/queue", click),
				]);
				expect(first.status()).toBe(200);
				expect(second.status()).toBe(200);
				const accepted = await first.json();
				expect(accepted).toHaveProperty("jobId");
				expect(await second.json()).toEqual(accepted);
				expect(fixtures.submissions).toEqual([providerPayload(provider, urls)]);
				const verifyJob = async () => {
					await page.goto(`${origin}/jobs`);
					const article = page.getByRole("article");
					await expect(article).toHaveCount(1);
					await expect(article.getByText(state, { exact: true })).toBeVisible({ timeout: 20_000 });
					await expect(article.getByText(message)).toBeVisible();
					await expect(article.getByRole("button", { name: "Save to Gallery" })).toHaveCount(0);
					await assertPrivate();
					assertOneSubmission();
				};
				await verifyJob();
				const statusPaths = () =>
					fixtures.requests.filter(({ path }) => path.includes("/status/")).map(({ path }) => path);
				expect(statusPaths()).toEqual(outcome === "failed" ? fixtures.statusPaths : []);
				await page.goto(`${origin}/gallery`);
				await expect(page.getByText(/No saved images yet/)).toBeVisible();
				await assertPrivate();
				await restart();
				const replay = await post("/image/queue", click);
				expect(replay.status()).toBe(200);
				expect(await replay.json()).toEqual(accepted);
				for (const changed of [
					{ ...click, acceptUnknown: !click.acceptUnknown },
					{ ...click, draft: edit(provider, [...urls].reverse()).draft },
					{ ...click, draft: edit(provider, [secondSignedReference, changedReference]).draft },
				]) {
					expect((await post("/image/queue", changed)).status()).toBe(400);
				}
				await verifyJob();
				expect(statusPaths()).toEqual(outcome === "failed" ? fixtures.statusPaths : []);
				expect(fixtures.requests.filter(({ path }) => path === editedImagePath)).toEqual([]);
			},
		);
	});
}

for (const provider of ["poyo", "toapis"] as const) {
	test(`built ${provider} batch queues five ordered edits and saves a successful sibling`, async ({
		page,
	}) => {
		test.setTimeout(110_000);
		await withEditStudio(
			page,
			provider,
			"mixed-batch",
			async ({ origin, fixtures, restart, assertPrivate, rates }) => {
				const initial = fixtures.requests.length;
				await page.setViewportSize({ width: 320, height: 760 });
				await page.clock.setFixedTime(new Date(rates.observedMs + 60_000));
				await page.goto(`${origin}/image`);
				await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
				await page.getByLabel("Operation", { exact: true }).selectOption("edit");
				await chooseReference(page, 1, secondSignedReference);
				await chooseReference(page, 2, signedReference);
				const review = page.getByRole("region", { name: "Review request", exact: true });
				await review.getByRole("tab", { name: "Batch", exact: true }).press("Enter");
				await review.getByLabel("Batch count").selectOption("5");
				await review.getByLabel("Additional attempts per request").selectOption("3");
				await review.getByRole("button", { name: "Review request", exact: true }).press("Enter");
				const queue = review.getByRole("button", { name: "Queue 5 requests" });
				await expect(review).toContainText("3 extra attempts per request");
				await expect(review).toContainText(
					provider === "poyo" ? "204 Poyo.ai credits" : "112 ToAPIs credits",
				);
				if (provider === "toapis") {
					await expect(queue).toBeDisabled();
					await review.getByRole("checkbox", { name: /unknown costs/ }).press("Space");
				}
				await expect(queue).toBeEnabled();
				expect(fixtures.requests.slice(initial)).toEqual([]);
				await queue.press("Enter");
				await expect(page).toHaveURL(/\/jobs#job-/);
				const batch = page.getByRole("region", { name: "Image batch", exact: true });
				await expect(batch).toContainText("4 successful · 1 failed", { timeout: 35_000 });
				expect(fixtures.submissions).toEqual(
					Array(5).fill(providerPayload(provider, [secondSignedReference, signedReference])),
				);
				const second = batch.getByRole("region", { name: "Request 2", exact: true });
				await expect(second.getByRole("heading", { level: 3 })).toHaveText(
					"Request 2 · Successful",
				);
				await expect(second.getByRole("heading", { level: 4 })).toHaveText("Attempt 1");
				if (provider === "toapis")
					await expect(batch).toContainText(
						"Total unknown · known subtotal · 22.4 credits · $0.112 USD",
					);
				const save = second.getByRole("button", { name: "Save to Gallery" });
				await expect(save).toBeEnabled({ timeout: 20_000 });
				await save.press("Enter");
				await expect(second).toContainText("You can retry Save");
				await expect(save).toBeEnabled({ timeout: 20_000 });
				await save.press("Enter");
				const open = second.getByRole("link", { name: "Open saved image" });
				await expect(open).toBeVisible();
				const path = await open.getAttribute("href");
				await assertPrivate();
				await restart();
				const before = fixtures.requests.length;
				await page.request.post(`${origin}/settings/providers?/remove`, {
					headers: { origin, accept: "text/html" },
					form: { provider, jobWarning: "seen" },
				});
				expect(await (await page.request.get(`${origin + path}/media`)).body()).toEqual(editedPng);
				expect(fixtures.requests.length).toBe(before);
				expect(fixtures.submissions).toHaveLength(5);
			},
		);
	});
}

test("an interrupted built batch recovers only its acknowledged task and never resends the lost POST", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await withEditStudio(
		page,
		"toapis",
		"crash-after-acceptance",
		async ({ origin, post, fixtures, restart, assertPrivate }) => {
			const draft = {
				...edit("toapis", [signedReference, secondSignedReference]),
				count: 3,
				retryLimit: 3,
			};
			const terms = await readReview(await post("/image/review", draft));
			const click = { ...draft, token: terms.token, acceptUnknown: true };
			const response = await post("/image/queue", click);
			const claim = await response.json();
			await expect.poll(() => fixtures.submissions.length).toBe(2);
			await restart();
			expect(await (await post("/image/queue", click)).json()).toEqual(claim);
			await page.goto(`${origin}/jobs`);
			const batch = page.getByRole("region", { name: "Image batch", exact: true });
			await expect(batch).toContainText(
				"1 successful · 0 failed · 0 rejected · 1 uncertain · 1 unsent",
				{ timeout: 20_000 },
			);
			await expect(batch.getByRole("region", { name: "Request 2" })).toContainText(
				"May have been submitted",
			);
			await expect(batch.getByRole("region", { name: "Request 3" })).toContainText(
				"0 of 4 attempts used",
			);
			expect(fixtures.submissions).toHaveLength(2);
			expect(
				fixtures.requests
					.filter((r) => r.path.includes("/status/"))
					.every((r) => r.path === fixtures.statusPaths[0]),
			).toBe(true);
			await assertPrivate();
		},
	);
});

for (const provider of ["toapis", "poyo"] as const) {
	test(`built ${provider} queues five text generations with zero extra attempts`, async ({
		page,
	}) => {
		await withEditStudio(
			page,
			provider,
			"completed",
			async ({ post, fixtures, origin, assertPrivate }) => {
				const draft = {
					draft: { ...createSeedreamDraft(provider), prompt },
					count: 5,
					retryLimit: 0,
					acceptUnknown: false,
				};
				const traffic = fixtures.requests.length;
				const terms = await readReview(await post("/image/review", draft));
				expect(fixtures.requests.length).toBe(traffic);
				const click = { ...draft, token: terms.token, acceptUnknown: terms.requiresConsent };
				for (const tamper of [{ count: 4 }, { retryLimit: 1 }])
					expect((await post("/image/queue", { ...click, ...tamper })).status()).toBe(400);
				const responses = await Promise.all([
					post("/image/queue", click),
					post("/image/queue", click),
				]);
				expect(await responses[0].json()).toEqual(await responses[1].json());
				await page.goto(`${origin}/jobs`);
				await expect(page.getByRole("region", { name: "Image batch" })).toContainText(
					"5 successful",
					{ timeout: 22_000 },
				);
				expect(fixtures.submissions).toHaveLength(5);
				for (const payload of fixtures.submissions)
					expect(payload).toMatchObject(provider === "poyo" ? { input: { prompt } } : { prompt });
				expect(JSON.stringify(fixtures.submissions)).not.toContain("image_urls");
				await assertPrivate();
			},
		);
	});
}
