import { rm } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import projection from "../../src/lib/shared/media-catalog/poyo-picker.json";
import { localFilenameMarker, markedFile } from "../fixtures/local-image";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { startStudio } from "./built-studio";
import { prompt, withEditStudio } from "./edit-studio-fixture";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

const rows = projection.rows as {
	model: string;
	media: string;
	reason: string;
	queue?: string[];
}[];
const expected = (media: string) =>
	rows
		.filter((row) => row.media === media && !row.queue)
		.map((row) => ({ value: row.model, text: `${row.model} (Review only: ${row.reason})` }));
// Derived image rows whose text-to-image operation can Queue get their own group.
const queueable = rows
	.filter((row) => row.media === "image" && row.queue?.includes("text-to-image"))
	.map((row) => ({ value: row.model, text: row.model, disabled: false }));

/** Each option in a family group, as the picker lists it. */
function listed(picker: Locator, family: string) {
	return picker.evaluate((select, label) => {
		const group = [...(select as HTMLSelectElement).querySelectorAll("optgroup")].find(
			(candidate) => candidate.label === label,
		);
		return [...(group?.querySelectorAll("option") ?? [])].map((option) => ({
			value: option.value,
			text: option.textContent?.trim().replace(/\s+/g, " "),
			disabled: option.disabled,
		}));
	}, family);
}

function watchPosts(page: Page) {
	const posts: string[] = [];
	page.on("request", (request) => {
		// Owner session renewals are the only other writes these pages make.
		const { pathname } = new URL(request.url());
		if (request.method() !== "GET" && !pathname.startsWith("/owner/")) posts.push(pathname);
	});
	return posts;
}

test("the picker lists every derived Poyo.ai row as Review-only with its reason, and choosing one never reaches Queue", async ({
	page,
}) => {
	test.setTimeout(90_000);
	const directory = await createOwnerDirectory();
	const fixture = startProviderFixtures();
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", false, fixture.env);
		const { origin } = server.origin;
		await expect.poll(server.token).not.toBe("");
		await claimOwner(page, server, crypto.randomUUID());
		const connected = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider: "poyo", key: providerFixtureKeys.poyo },
		});
		expect(connected.ok()).toBe(true);
		const providerCalls = fixture.requests.length;
		const posts = watchPosts(page);

		// Image Studio: the shipped models stay first and selectable; the derived rows follow.
		await page.goto(`${origin}/image`);
		const model = page.getByLabel("Model", { exact: true });
		const imageRows = await listed(model, "Poyo.ai image");
		expect(imageRows).toEqual(expected("image").map((row) => ({ ...row, disabled: false })));
		expect(imageRows.length).toBeGreaterThan(55);
		expect(await listed(model, "Poyo.ai image · Queue")).toEqual(queueable);
		expect(queueable.length).toBeGreaterThan(10);
		await expect(model.locator("option").first()).toHaveText("Seedream 5.5");
		await expect(model).toHaveValue("seedream-5.5");
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("Fog over a quiet harbour");
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toBeVisible();

		await model.selectOption("flux-2-pro");
		const review = page.getByRole("region", { name: "Review request" });
		await expect(review.getByRole("status")).toHaveText(
			"Review only. Poyo.ai does not document that it returns one image. Siluet sends nothing for this model.",
		);
		await expect(page.getByText("Poyo.ai image", { exact: true })).toBeVisible();
		await expect(review.getByRole("definition")).toHaveText([
			"Poyo.ai",
			"flux-2-pro",
			"Text to image",
		]);
		await expect(page.getByRole("button", { name: /^Queue/ })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Review request" })).toHaveCount(0);
		await expect(prompt).toHaveCount(0);
		await model.selectOption("gpt-image-2.6-fixed");
		await expect(review.getByRole("status")).toContainText("(G6)");
		// Format names keep their capitals.
		await model.selectOption("ideogram-vector-1.0/text-to-vector");
		await expect(review.getByRole("definition").last()).toHaveText(
			"Text to SVG, Reference guided text to SVG",
		);

		await model.selectOption("seedream-5.5");
		await expect(prompt).toHaveValue("Fog over a quiet harbour");
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toBeVisible();

		// Video Studio: Poyo.ai Seedance 2.5 is now a derived row with its reason.
		await page.goto(`${origin}/video`);
		const picker = page.getByLabel("Video model and provider");
		const videoRows = await listed(picker, "Poyo.ai video");
		expect(videoRows).toEqual(expected("video").map((row) => ({ ...row, disabled: false })));
		await expect(picker.locator('option[value="seedance-2.5"]')).toHaveCount(1);
		await expect(picker.locator('option[value="seedance-2-5"]')).toBeEnabled();
		await expect(picker.locator('option[value="h3-max"]')).toBeEnabled();
		const videoPrompt = page.getByRole("textbox", { name: "Prompt" });
		await videoPrompt.fill("A lantern drifts down a canal");
		// The ToAPIs note agrees with the Poyo.ai row's own reason.
		await expect(
			page.getByText(
				"Poyo.ai Seedance 2.5 is Review only: Poyo.ai text-to-video is not verified yet (G7).",
			),
		).toBeVisible();
		await expect(page.getByText(/fixed filtering setting/)).toHaveCount(0);

		// A Review-only round trip keeps a non-default operation, its frames and its settings.
		await page.getByRole("radio", { name: "First and last frame" }).check();
		const start = page.getByRole("textbox", { name: "Starting frame" });
		const end = page.getByRole("textbox", { name: "Ending frame" });
		await start.fill("https://frames.example.test/start.png");
		await end.fill("https://frames.example.test/end.png");
		await page.getByLabel("Duration (seconds)").selectOption("7");
		await picker.selectOption("seedance-2.5");
		await expect(start).toBeHidden();
		await picker.selectOption("seedance-2-5");
		await expect(page.getByRole("radio", { name: "First and last frame" })).toBeChecked();
		await expect(start).toHaveValue("https://frames.example.test/start.png");
		await expect(end).toHaveValue("https://frames.example.test/end.png");
		await expect(page.getByLabel("Duration (seconds)")).toHaveValue("7");
		await expect(videoPrompt).toHaveValue("A lantern drifts down a canal");
		await page.getByRole("radio", { name: "Create video" }).check();
		await picker.selectOption("seedance-2.5");
		const videoReview = page.getByRole("region", { name: "Review", exact: true });
		await expect(videoReview.getByRole("status")).toHaveText(
			"Review only. Poyo.ai text-to-video is not verified yet (G7). Siluet sends nothing for this model.",
		);
		await expect(page.getByRole("heading", { name: "seedance-2.5 · Poyo.ai" })).toBeVisible();
		await expect(page.getByRole("button", { name: /^(Queue|Review request)/ })).toHaveCount(0);
		await picker.selectOption("h3-max");
		await expect(page.getByRole("heading", { name: "H3 Max · Poyo.ai" })).toBeVisible();
		await expect(videoPrompt).toHaveValue("A lantern drifts down a canal");
		await expect(page.getByRole("button", { name: "Review request" })).toBeVisible();

		expect(posts).toEqual([]);
		expect(fixture.requests.slice(providerCalls)).toEqual([]);
	} finally {
		await server?.stop();
		await fixture.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

async function openEdit(page: Page, origin: string) {
	await page.goto(`${origin}/image`);
	await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	const review = page.getByRole("region", { name: "Review request", exact: true });
	return {
		model: page.getByLabel("Model", { exact: true }),
		file: page.getByLabel("Reference image 1", { exact: true }),
		review,
		inspect: review.getByRole("button", { name: "Review request", exact: true }),
		queue: review.getByRole("button", { name: "Queue 1 request" }),
		consent: review.getByRole("checkbox", { name: /unknown total cost/ }),
	};
}

test("a lost Queue keeps its Retry across a Review-only row, and the Model picker waits for the Queue", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { model, file, review, inspect, consent, queue } = await openEdit(page, origin);
		await file.setInputFiles(await markedFile("png"));
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await inspect.press("Enter");
		await consent.press("Space");
		const bodies: string[] = [];
		const answer = Promise.withResolvers<void>();
		let lost = true;
		await page.route("**/image/file-queue", async (route) => {
			bodies.push(route.request().postData() ?? "");
			const response = await route.fetch();
			if (!lost) return route.fulfill({ response });
			lost = false;
			await answer.promise;
			return route.abort();
		});
		await queue.press("Enter");
		await expect.poll(() => bodies.length).toBe(1);
		await expect(model).toBeDisabled();
		answer.resolve();
		const status = review.getByRole("status");
		await expect(status).toContainText("Queue confirmation is unavailable");
		await expect(model).toBeEnabled();

		await model.selectOption("flux-2-pro");
		await expect(review.getByRole("status")).toContainText("Review only.");
		await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
		await model.selectOption("seedream-5.5");
		await expect(status).toContainText("Queue confirmation is unavailable");
		await review.getByRole("button", { name: "Retry", exact: true }).press("Enter");
		await expect(page).toHaveURL(/\/jobs/);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		await expect.poll(() => fixtures.uploads.length, { timeout: 20_000 }).toBe(1);
	});
});

test("a local reference file survives a Review-only round trip, even while Siluet is still checking it", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		const { model, file, review, inspect } = await openEdit(page, origin);
		// Hold the slot's own decode check until the round trip is done.
		await page.evaluate(() => {
			const decode = window.createImageBitmap.bind(window);
			const gate = Promise.withResolvers<void>();
			Object.assign(window, { releaseDecode: gate.resolve });
			window.createImageBitmap = (async (...args: Parameters<typeof decode>) => {
				await gate.promise;
				return decode(...args);
			}) as typeof window.createImageBitmap;
		});
		await file.setInputFiles(await markedFile("png"));
		await expect(file).toHaveAccessibleDescription(/Checking file…/);
		await model.selectOption("flux-2-pro");
		await expect(file).toBeHidden();
		await model.selectOption("seedream-5.5");
		await page.evaluate(() => (window as unknown as { releaseDecode: () => void }).releaseDecode());
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await expect(file).toHaveAccessibleDescription(new RegExp(`${localFilenameMarker}\\.png`));

		// Once checked, the file stays attached across another round trip.
		await model.selectOption("flux-2-pro");
		await model.selectOption("seedream-5.5");
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await inspect.press("Enter");
		await expect(review.getByRole("button", { name: "Queue 1 request" })).toBeVisible();
	});
});
