import { rm } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import projection from "../../src/lib/shared/media-catalog/poyo-picker.json";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

const expected = (media: string) =>
	projection.rows
		.filter((row) => row.media === media)
		.map((row) => ({ value: row.model, text: `${row.model} (Review only: ${row.reason})` }));

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
		expect(imageRows.length).toBeGreaterThan(70);
		await expect(model.locator("option").first()).toHaveText("Seedream 5.5");
		await expect(model).toHaveValue("seedream-5.5");
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("Fog over a quiet harbour");
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toBeVisible();

		await model.selectOption("flux-dev");
		const review = page.getByRole("region", { name: "Review request" });
		await expect(review.getByRole("status")).toHaveText(
			"Review only. Poyo.ai text-to-image is not verified yet (G4). Siluet sends nothing for this model.",
		);
		await expect(page.getByText("Poyo.ai image", { exact: true })).toBeVisible();
		await expect(review.getByRole("definition")).toHaveText([
			"Poyo.ai",
			"flux-dev",
			"Text to image, Reference image edit",
		]);
		await expect(page.getByRole("button", { name: /^Queue/ })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Review request" })).toHaveCount(0);
		await expect(prompt).toHaveCount(0);
		await model.selectOption("gpt-image-2.6-fixed");
		await expect(review.getByRole("status")).toContainText("(G6)");

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
