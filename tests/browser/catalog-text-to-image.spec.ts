import { rm } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { poyoAccessNote } from "../../src/lib/shared/media-catalog/eligibility";
import { d4Disclosure } from "../../src/lib/shared/media-catalog/filtering";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

type Body = { model: string; input: Record<string, unknown> };

/**
 * A derived text-to-image row from Queue to a verified Save, then reopened from Gallery after a
 * restart with the provider offline. `compose` fills the row's own fields after the prompt.
 */
async function journey(page: Page, model: string, prompt: string, compose: () => Promise<void>) {
	const directory = await createOwnerDirectory();
	const submitted: Body[] = [];
	const respond = jobResponses();
	const fixtures = startProviderFixtures(async (request, path) => {
		if (path === "/poyo/submit" && request.method === "POST")
			submitted.push(await request.clone().json());
		return respond(request, path);
	});
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	let stopped = false;
	try {
		server = await startStudio(directory, "0", false, fixtures.env);
		const { origin } = server.origin;
		const outbound: string[] = [];
		await page.route(/^https?:/, (route) => {
			if (new URL(route.request().url()).origin === origin) return route.continue();
			outbound.push(new URL(route.request().url()).hostname);
			return route.abort();
		});
		await expect.poll(server.token).not.toBe("");
		await claimOwner(page, server, crypto.randomUUID());
		const connected = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider: "poyo", key: providerFixtureKeys.poyo },
		});
		expect(connected.ok()).toBe(true);

		await page.goto(`${origin}/image`);
		await page.getByLabel("Model", { exact: true }).selectOption(model);
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
		await compose();
		const review = page.getByRole("region", { name: "Review request" });
		await review.getByRole("button", { name: "Review request" }).click();
		const queue = review.getByRole("button", { name: "Queue 1 request" });
		await expect(queue).toBeDisabled();
		await review.getByLabel("I accept the unknown cost of this request.").check();
		await queue.click();
		await expect(page).toHaveURL(/\/jobs/);
		const open = page.getByRole("article").getByRole("link", { name: "Open saved image" });
		await expect(open).toBeVisible({ timeout: 20_000 });
		const path = (await open.getAttribute("href")) ?? "";
		expect(submitted).toHaveLength(1);

		// Restart with the provider offline: the saved original reopens from Gallery unchanged.
		const port = server.origin.port;
		await server.stop();
		server = undefined;
		const calls = fixtures.requests.length;
		await fixtures.stop();
		stopped = true;
		server = await startStudio(directory, port, false, fixtures.env);
		await page.goto(origin + path);
		await expect(page.getByText("PNG · ")).toBeVisible();
		const media = await ownerRequest(page).get(`${origin}${path}/media`);
		expect(media.headers()["content-type"]).toBe("image/png");
		expect(await media.body()).toEqual(referencePng);
		expect(fixtures.requests.length).toBe(calls);
		expect(outbound).toEqual([]);
		return submitted[0];
	} finally {
		await server?.stop();
		if (!stopped) await fixtures.stop();
		await rm(directory, { recursive: true, force: true });
	}
}

test("Qwen Image 2.1 queues once with its boolean and seed, saves the verified image and reopens offline", async ({
	page,
}) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(12_000);
	const prompt = "A glass lantern on a mossy stone, morning mist";
	const body = await journey(page, "qwen-image-2.1", prompt, async () => {
		const background = page.getByLabel("Background", { exact: true });
		const format = page.getByLabel("Output format", { exact: true });
		await expect(format.locator("option")).toHaveText(["PNG", "WEBP", "JPEG"]);
		// The combination rule disables jpeg while the background is transparent.
		await background.selectOption("transparent");
		await expect(format.locator('option[value="jpeg"]')).toBeDisabled();
		await background.selectOption("opaque");
		await expect(format.locator('option[value="jpeg"]')).toBeEnabled();
		const extend = page.getByRole("checkbox", { name: "Prompt extend" });
		await expect(extend).toBeChecked();
		await extend.uncheck();
		await page.getByLabel("Seed (optional)", { exact: true }).fill("42");
		// `auto` follows a reference image, so text-to-image never offers it.
		await expect(
			page.getByLabel("Size", { exact: true }).locator('option[value="auto"]'),
		).toHaveCount(0);
	});
	expect(body).toEqual({
		model: "qwen-image-2.1",
		input: {
			prompt,
			background: "opaque",
			output_format: "png",
			prompt_extend: false,
			resolution: "1K",
			seed: 42,
			size: "1:1",
			enable_safety_checker: false,
		},
	});
});

test("flux-dev queues once after its disclosure, access note and unknown-price consent, saves and reopens offline", async ({
	page,
}) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(12_000);
	const prompt = "A paper crane on a windowsill at dawn";
	const body = await journey(page, "flux-dev", prompt, async () => {
		const review = page.getByRole("region", { name: "Review request" });
		// Open-absent: Review binds the disclosure and says nothing about a declared field.
		await expect(review.getByRole("list", { name: "Provider disclosure" })).toHaveText(
			d4Disclosure("poyo"),
		);
		await expect(review.getByText(poyoAccessNote)).toBeVisible();
		await expect(review.getByText("declares")).toHaveCount(0);
		await expect(
			review.getByText("Unknown. No local rate is available for this request."),
		).toBeVisible();
	});
	expect(body).toEqual({
		model: "flux-dev",
		input: { prompt, output_format: "png", n: 1, enable_safety_checker: false },
	});
});
