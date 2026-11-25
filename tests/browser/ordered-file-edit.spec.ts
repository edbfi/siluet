import { expect, type Page } from "@playwright/test";
import { cmykJpeg, localImageMarker, markedFile } from "../fixtures/local-image";
import {
	editedPng,
	referenceFragmentMarker,
	referencePathMarker,
	referenceQueryMarker,
	secondSignedReference,
	signedReference,
} from "../fixtures/reference-edit";
import { prompt, providerPayload, withEditStudio } from "./edit-studio-fixture";
import { test } from "./studio-test";

const providerName = { poyo: "Poyo.ai", toapis: "ToAPIs" } as const;

async function openEdit(page: Page, origin: string) {
	await page.goto(`${origin}/image`);
	await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	const review = page.getByRole("region", { name: "Review request", exact: true });
	return {
		review,
		file: (slot: number) => page.getByLabel(`Reference image ${slot}`, { exact: true }),
		inspect: review.getByRole("button", { name: "Review request", exact: true }),
		queue: review.getByRole("button", { name: "Queue 1 request" }),
		consent: review.getByRole("checkbox", { name: /unknown total cost/ }),
	};
}

async function chooseUrl(page: Page, slot: number, url: string) {
	await page
		.getByText("Use a URL", { exact: true })
		.nth(slot - 1)
		.press("Enter");
	const field = page.getByRole("textbox", {
		name: `HTTP or HTTPS URL for reference image ${slot}`,
	});
	await field.fill(url);
	await field.press("Enter");
}

const ready = (cleaning: boolean) =>
	cleaning ? /Cleaned copy ready\./ : /File checked · Not cleaned\./;

async function turnCleaningOff(page: Page, origin: string) {
	const off = await page.request.post(`${origin}/settings/files`, {
		headers: { origin, accept: "text/html" },
		form: { expectedRevision: "0" },
	});
	expect(off.ok()).toBe(true);
}

/** Count staging POSTs from this page from now on. */
function countStaging(page: Page) {
	const posts: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && /\/image\/files\/[^/]+$/.test(request.url()))
			posts.push(request.url());
	});
	return posts;
}

for (const provider of ["poyo", "toapis"] as const) {
	for (const cleaning of [true, false]) {
		test(`${provider} queues file, URL, file ${cleaning ? "cleaned" : "unchanged"} in order and keeps the result offline`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			await withEditStudio(
				page,
				provider,
				"completed",
				async ({ origin, fixtures, restart, assertPrivate, assertOneSubmission }) => {
					if (!cleaning) await turnCleaningOff(page, origin);
					const first = await markedFile("png");
					const last = await markedFile("jpeg", 1);
					const before = fixtures.requests.length;
					const { review, file, inspect, queue, consent } = await openEdit(page, origin);
					await file(1).setInputFiles(first);
					await expect(file(1)).toHaveAccessibleDescription(ready(cleaning));
					await chooseUrl(page, 2, signedReference);
					await file(3).setInputFiles(last);
					await expect(file(3)).toHaveAccessibleDescription(ready(cleaning));
					await expect(
						review.getByRole("region", { name: "Local copy · reference 3", exact: true }),
					).toBeVisible();
					await inspect.press("Enter");
					const disclosure = review.getByRole("list", { name: "Provider disclosure" });
					await expect(disclosure).toContainText(
						"Queue first uploads 2 files one at a time in reference order",
					);
					await expect(disclosure).toContainText("up to 3 potentially billable requests");
					await expect(disclosure.getByText(/ten uploads per account/)).toHaveCount(
						Number(provider === "poyo"),
					);
					if (cleaning)
						await expect(disclosure).toContainText("Siluet sends only cleaned private copies.");
					else
						await expect(disclosure.getByText(/^Not cleaned\./)).toHaveText(
							`Not cleaned. Metadata removal is off in Settings, so Siluet sends references 1 and 3 to ${providerName[provider]} unchanged, including any location, camera, authorship or AI-source metadata.`,
						);
					await expect(review.getByText(/Up to 3 potentially billable requests/)).toHaveText(
						"Up to 3 potentially billable requests: 2 uploads and one edit.",
					);
					await review.getByRole("tab", { name: "Outgoing request" }).press("Enter");
					await expect(review.getByText(/Multipart file/)).toHaveCount(2);
					await expect(review.getByText(/\[hosted upload URL for reference 1\]/)).toBeVisible();
					await expect(review.getByText(/\[hosted upload URL for reference 3\]/)).toBeVisible();
					// The user's signed URL stays redacted; only the provider receives it.
					const outgoing = review.locator("pre code");
					const shown = JSON.parse((await outgoing.textContent()) ?? "");
					expect((shown.input ?? shown).image_urls).toEqual([
						"[hosted upload URL for reference 1]",
						"[remote URL hidden]",
						"[hosted upload URL for reference 3]",
					]);
					for (const marker of [referencePathMarker, referenceQueryMarker, referenceFragmentMarker])
						await expect(outgoing).not.toContainText(marker);
					await review.getByRole("tab", { name: "Review", exact: true }).press("Enter");
					if (provider === "toapis") {
						// Files and URLs are billed alike: the 2K tier plus three references.
						const price = review.locator("[data-studio-price]");
						await expect(price).toContainText("Estimated 9.44 ToAPIs credits per request");
						await expect(price).toContainText("$0.0472 USD");
						await expect(price).toContainText(
							"Includes 3 reference images at $0.0064 (≈1.28 credits) each.",
						);
					}
					await expect(consent).toHaveAccessibleName(
						"I accept the unknown total cost of the uploads and edit, the provider access and retention terms above, and that uploaded copies may stay accessible even if the edit never runs.",
					);
					await consent.press("Space");
					// Preparation and Review make no provider calls.
					expect(fixtures.requests.length).toBe(before);
					await queue.press("Enter");
					await expect(page).toHaveURL(/\/jobs/);
					const job = page.getByRole("article");
					await expect(job.getByRole("link", { name: "Open saved image" })).toBeVisible({
						timeout: 30_000,
					});
					await expect(job.getByText("3 references · 2 files")).toBeVisible();
					await expect(
						job.getByRole("list", { name: "File uploads" }).getByRole("listitem"),
					).toHaveText(["Reference 1 · File uploaded", "Reference 3 · File uploaded"]);
					expect(fixtures.uploads.map(({ file }) => file.type)).toEqual([
						"image/png",
						"image/jpeg",
					]);
					for (const [index, attached] of [first, last].entries()) {
						const sent = Buffer.from(await fixtures.uploads[index].file.arrayBuffer());
						if (cleaning) expect(sent.includes(Buffer.from(localImageMarker))).toBe(false);
						else expect(sent.equals(attached.buffer)).toBe(true);
					}
					expect(fixtures.submissions).toEqual([
						providerPayload(provider, [
							fixtures.hostedFor(1),
							signedReference,
							fixtures.hostedFor(2),
						]),
					]);
					assertOneSubmission();
					await assertPrivate();
					const gallery = await job
						.getByRole("link", { name: "Open saved image" })
						.getAttribute("href");
					if (!gallery) throw new Error("Missing Gallery entry");
					await restart();
					const removed = await page.request.post(`${origin}/settings/providers?/remove`, {
						headers: { origin, accept: "text/html" },
						form: { provider },
					});
					expect(removed.ok()).toBe(true);
					const after = fixtures.requests.length;
					expect(await (await page.request.get(`${origin + gallery}/media`)).body()).toEqual(
						editedPng,
					);
					expect(fixtures.requests.length).toBe(after);
				},
			);
		});
	}

	test(`${provider} keeps URL, file, URL in order and a move clears consent`, async ({ page }) => {
		await withEditStudio(page, provider, "completed", async ({ origin, fixtures }) => {
			const { review, file, inspect, queue, consent } = await openEdit(page, origin);
			await chooseUrl(page, 1, signedReference);
			await file(2).setInputFiles(await markedFile("png"));
			await expect(file(2)).toHaveAccessibleDescription(ready(true));
			await chooseUrl(page, 3, secondSignedReference);
			await inspect.press("Enter");
			await consent.press("Space");
			await expect(queue).toBeEnabled();
			// A move changes the reviewed order: consent and the Review go.
			await page.getByRole("button", { name: "Move up reference image 2" }).press("Enter");
			await expect(consent).toHaveCount(0);
			await expect(queue).toBeDisabled();
			await inspect.press("Enter");
			await review.getByRole("tab", { name: "Outgoing request" }).press("Enter");
			await expect(review.getByText(/\[hosted upload URL\]/)).toBeVisible();
			await review.getByRole("tab", { name: "Review", exact: true }).press("Enter");
			await consent.press("Space");
			await queue.press("Enter");
			await expect(page).toHaveURL(/\/jobs/);
			await expect.poll(() => fixtures.submissions.length, { timeout: 20_000 }).toBe(1);
			expect(fixtures.submissions).toEqual([
				providerPayload(provider, [fixtures.hostedFor(1), signedReference, secondSignedReference]),
			]);
			expect(fixtures.uploads).toHaveLength(1);
		});
	});

	test(`${provider} uploads ten files in order before one edit`, async ({ page }) => {
		test.setTimeout(120_000);
		await withEditStudio(page, provider, "completed", async ({ origin, fixtures }) => {
			const { file, inspect, queue, consent, review } = await openEdit(page, origin);
			for (let slot = 1; slot <= 10; slot++) {
				await file(slot).setInputFiles(await markedFile("png", slot));
				await expect(file(slot)).toHaveAccessibleDescription(ready(true), { timeout: 20_000 });
			}
			await inspect.press("Enter");
			await expect(review.getByText(/Up to 11 potentially billable requests/)).toBeVisible();
			await consent.press("Space");
			await queue.press("Enter");
			await expect(page).toHaveURL(/\/jobs/);
			await expect.poll(() => fixtures.submissions.length, { timeout: 30_000 }).toBe(1);
			expect(fixtures.uploads).toHaveLength(10);
			// Each upload carries its own slot's copy: 41 to 50 pixels wide, in order.
			const widths = [];
			for (const { file: sent } of fixtures.uploads)
				widths.push(Buffer.from(await sent.arrayBuffer()).readUInt32BE(16));
			expect(widths).toEqual(Array.from({ length: 10 }, (_, i) => 41 + i));
			expect(fixtures.submissions).toEqual([
				providerPayload(
					provider,
					Array.from({ length: 10 }, (_, i) => fixtures.hostedFor(i + 1)),
				),
			]);
		});
	});
}

test("a file the cleaner refuses blocks Queue with its slot and sends nothing", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, review, inspect } = await openEdit(page, origin);
		await file(1).setInputFiles(await markedFile("png"));
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await file(2).setInputFiles({
			name: "cmyk.jpg",
			mimeType: "image/jpeg",
			buffer: await cmykJpeg(),
		});
		await expect(file(2)).toHaveAccessibleDescription(/unsupported image coding/);
		await expect(review.getByRole("status")).toHaveText(/^Reference 2: .*unsupported image coding/);
		await expect(inspect).toHaveCount(0);
		expect(fixtures.uploads).toHaveLength(0);
	});
});

test("the same file twice, or two files with equal bytes, stay visible but cannot queue", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		const { file, review, inspect } = await openEdit(page, origin);
		const attached = await markedFile("png");
		await file(1).setInputFiles(attached);
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await file(2).setInputFiles({ ...attached, name: "copy.png" });
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		await expect(review.getByRole("status")).toHaveText(
			"Reference images 1 and 2 are the same file.",
		);
		await expect(inspect).toHaveCount(0);
	});
});

test("stale positions prepare only those slots again; stale terms keep every copy", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, review, inspect, queue, consent } = await openEdit(page, origin);
		await file(1).setInputFiles(await markedFile("png"));
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await file(2).setInputFiles(await markedFile("png", 1));
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		const staging = countStaging(page);
		const answers = [{ error: "stale", positions: [2] }, { error: "stale" }];
		await page.route("**/image/file-queue", (route) =>
			route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify(answers.shift()),
			}),
		);
		await inspect.press("Enter");
		await consent.press("Space");
		await queue.press("Enter");
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		await expect.poll(() => staging.length).toBe(1);
		expect(staging[0]).not.toContain("undefined");
		await expect(consent).toHaveCount(0);
		// Without positions only the terms changed: nothing is prepared again.
		await inspect.press("Enter");
		await consent.press("Space");
		await queue.press("Enter");
		await expect(review.getByRole("status")).toHaveText(
			"The terms changed. Review again before queuing.",
		);
		expect(staging).toHaveLength(1);
		await expect(inspect).toBeVisible();
		expect(fixtures.uploads).toHaveLength(0);
	});
});

test("a stale Review answer whose body arrives after a reorder prepares nothing again", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, review, inspect } = await openEdit(page, origin);
		await file(1).setInputFiles(await markedFile("png"));
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await file(2).setInputFiles(await markedFile("png", 1));
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		const staging = countStaging(page);
		// The stale answer's headers arrive at once; its body waits for the reorder.
		await page.evaluate(() => {
			const send = window.fetch.bind(window);
			const body = Promise.withResolvers<void>();
			Object.assign(window, { releaseStaleBody: body.resolve });
			const answer = (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) !== "/image/file-review") return send(input, init);
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						await body.promise;
						controller.enqueue(new TextEncoder().encode('{"error":"stale","positions":[2]}'));
						controller.close();
					},
				});
				return Promise.resolve(
					new Response(stream, { status: 409, headers: { "content-type": "application/json" } }),
				);
			};
			window.fetch = Object.assign(answer, { preconnect: window.fetch.preconnect });
		});
		await inspect.press("Enter");
		await expect(review.getByRole("button", { name: "Reviewing…" })).toBeVisible();
		await page.getByRole("button", { name: "Move up reference image 2" }).press("Enter");
		await page.evaluate(() =>
			(window as unknown as { releaseStaleBody: () => void }).releaseStaleBody(),
		);
		await expect(inspect).toBeEnabled();
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		expect(staging).toHaveLength(0);
		expect(fixtures.uploads).toHaveLength(0);
	});
});

test("stale copies at several positions are prepared again after one settings read", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		const { file, inspect, queue, consent } = await openEdit(page, origin);
		await file(1).setInputFiles(await markedFile("png"));
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await file(2).setInputFiles(await markedFile("png", 1));
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		await inspect.press("Enter");
		await consent.press("Space");
		const staging = countStaging(page);
		const reads: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/settings/files/state")) reads.push(request.url());
		});
		await page.route("**/image/file-queue", (route) =>
			route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ error: "stale", positions: [1, 2] }),
			}),
		);
		await queue.press("Enter");
		await expect.poll(() => staging.length).toBe(2);
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		expect(reads).toHaveLength(1);
	});
});

test("a lost three-file Queue answer after the edit, a restart and Retry: one job, three uploads, one edit", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await withEditStudio(page, "poyo", "completed", async ({ origin, fixtures, restart }) => {
		const { file, review, inspect, queue, consent } = await openEdit(page, origin);
		for (let slot = 1; slot <= 3; slot++) {
			await file(slot).setInputFiles(await markedFile("jpeg", slot));
			await expect(file(slot)).toHaveAccessibleDescription(ready(true));
		}
		await inspect.press("Enter");
		await consent.press("Space");
		let lose = true;
		await page.route("**/image/file-queue", async (route) => {
			if (!lose) return route.fallback();
			lose = false;
			// The server claims and dispatches; only its answer is lost.
			await route.fetch();
			await route.abort();
		});
		await queue.press("Enter");
		await expect(review.getByRole("status")).toContainText("Queue confirmation is unavailable");
		await expect.poll(() => fixtures.submissions.length, { timeout: 20_000 }).toBe(1);
		await restart();
		await review.getByRole("button", { name: "Retry", exact: true }).press("Enter");
		await expect(page).toHaveURL(/\/jobs#job-/);
		await expect(page.getByRole("article")).toHaveCount(1);
		expect(fixtures.uploads).toHaveLength(3);
		expect(fixtures.submissions).toHaveLength(1);
	});
});

test("a setting change elsewhere prepares every attached file again and clears consent", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, inspect, consent } = await openEdit(page, origin);
		await file(1).setInputFiles(await markedFile("png"));
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await chooseUrl(page, 2, signedReference);
		await file(3).setInputFiles(await markedFile("jpeg", 1));
		await expect(file(3)).toHaveAccessibleDescription(ready(true));
		await inspect.press("Enter");
		await consent.press("Space");
		const staging = countStaging(page);
		await turnCleaningOff(page, origin);
		await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
		await expect(file(1)).toHaveAccessibleDescription(ready(false));
		await expect(file(3)).toHaveAccessibleDescription(ready(false));
		await expect(consent).toHaveCount(0);
		expect(staging).toHaveLength(2);
		expect(fixtures.uploads).toHaveLength(0);
	});
});

test("a provider cooldown at Queue keeps the Review and its consent", async ({ page }) => {
	await withEditStudio(page, "poyo", "completed", async ({ origin, fixtures }) => {
		const { file, review, inspect, queue, consent } = await openEdit(page, origin);
		await file(1).setInputFiles(await markedFile("png"));
		await expect(file(1)).toHaveAccessibleDescription(ready(true));
		await file(2).setInputFiles(await markedFile("png", 1));
		await expect(file(2)).toHaveAccessibleDescription(ready(true));
		await inspect.press("Enter");
		await consent.press("Space");
		// A time within a second rounds up; one no date can hold reads as "shortly".
		const cooldowns = [Date.parse("2026-11-24T09:59:59.200Z"), 1e300];
		await page.route("**/image/file-queue", (route) =>
			cooldowns.length
				? route.fulfill({
						status: 409,
						contentType: "application/json",
						body: JSON.stringify({ error: "cooldown", until: cooldowns.shift() }),
					})
				: route.fallback(),
		);
		await queue.press("Enter");
		await expect(review.getByRole("status")).toHaveText(
			"The provider is cooling down. Nothing was sent. Queue again after 2026-11-24 10:00:00 UTC.",
		);
		await expect(consent).toBeChecked();
		await queue.press("Enter");
		await expect(review.getByRole("status")).toHaveText(
			"The provider is cooling down. Nothing was sent. Queue again shortly.",
		);
		await expect(consent).toBeChecked();
		await queue.press("Enter");
		await expect(page).toHaveURL(/\/jobs/);
		await expect.poll(() => fixtures.uploads.length, { timeout: 20_000 }).toBe(2);
	});
});
