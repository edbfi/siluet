import { rm } from "node:fs/promises";
import { expect, type Locator } from "@playwright/test";
import sharp from "sharp";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

const prompt = "A lacquered tea tray under morning light.";
// Seedream 5.5 previews PNG by default; this journey chooses its other offered format.
const result = await sharp({
	create: { width: 6, height: 4, channels: 3, background: { r: 40, g: 120, b: 200 } },
})
	.jpeg()
	.toBuffer();

test("Seedream 5.5 offers its row's formats, sends the chosen one verbatim and Save records the verified type", async ({
	page,
}) => {
	test.setTimeout(75_000);
	page.setDefaultTimeout(12_000);
	const dir = await createOwnerDirectory();
	const cacheHome = await createOwnerDirectory();
	const submitted: unknown[] = [];
	const respond = jobResponses();
	const fixtures = startProviderFixtures(async (request, path) => {
		if (path === "/poyo/submit") submitted.push(await request.clone().json());
		// The provider reports nothing about the type; Save sniffs and verifies the bytes.
		if (path === "/media/image")
			return new Response(result, { headers: { "content-type": "application/octet-stream" } });
		return respond(request, path);
	});
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(dir, "0", false, { ...fixtures.env, XDG_CACHE_HOME: cacheHome });
		await writeReviewPricing(cacheHome);
		const origin = server.origin.origin;
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
		const review = page.getByRole("region", { name: "Review request" });
		const expected = review.locator("[data-studio-expected-type]");
		await expect(expected).toContainText("Complete the request to see the expected type.");
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
		await page.getByText("Advanced options", { exact: true }).click();
		const format = page.getByLabel("Output format", { exact: true });
		// The derived row's values, in schema order; gif is never offered.
		await expect(format.locator("option")).toHaveText(["PNG", "JPEG"]);
		await expect(format).toHaveValue("png");
		await expect(expected).toContainText("PNG, requested as png");
		await format.selectOption("jpeg");
		await expect(expected).toContainText("JPEG, requested as jpeg");
		await expect(expected).toContainText(
			"Save records the type Gallery verifies: PNG, JPEG or still WebP.",
		);
		// The new fact takes the Review list's Panda styles: its term, layout and note match the
		// Price fact's on the built page.
		const computed = (locator: Locator) =>
			locator.evaluate((node) => {
				const { color, fontSize, display, gridTemplateColumns } = getComputedStyle(node);
				return { color, fontSize, display, gridTemplateColumns };
			});
		const fact = (name: string) =>
			review.locator("dl > div").filter({ has: page.getByRole("term").getByText(name) });
		const [typeFact, priceFact] = [fact("Expected type"), fact("Price")];
		expect(await computed(typeFact)).toEqual(await computed(priceFact));
		expect(await computed(typeFact.getByRole("term"))).toEqual(
			await computed(priceFact.getByRole("term")),
		);
		// The note is muted like a term and smaller than the detail it follows.
		const [term, detail, note] = await Promise.all(
			[typeFact.getByRole("term"), expected.locator("p").first(), expected.locator("p").last()].map(
				computed,
			),
		);
		expect(note.color).toBe(term.color);
		expect(note.color).not.toBe(detail.color);
		expect(Number.parseFloat(note.fontSize)).toBeLessThan(Number.parseFloat(detail.fontSize));

		await review.getByRole("tab", { name: "Outgoing request" }).click();
		const body = review.getByRole("region", { name: "JSON request body" });
		expect(JSON.parse((await body.textContent()) ?? "")).toMatchObject({
			model: "seedream-5.5",
			input: { output_format: "jpeg" },
		});
		await review.getByRole("tab", { name: "Review", exact: true }).click();

		const inspect = review.getByRole("button", { name: /^(Review request|Reviewing…)$/ });
		await inspect.click();
		await expect(inspect).toHaveCount(0);
		const consent = review.getByRole("checkbox", { name: /unknown/i });
		if (await consent.count()) await consent.check();
		const queue = review.getByRole("button", { name: "Queue 1 request" });
		await expect(queue).toBeEnabled();
		await queue.click();
		await expect(page).toHaveURL(/\/jobs/);

		expect(submitted).toEqual([
			{
				model: "seedream-5.5",
				input: {
					prompt,
					size: "1:1",
					resolution: "2K",
					background: "auto",
					output_format: "jpeg",
					enable_safety_checker: false,
				},
			},
		]);
		const article = page.getByRole("article");
		const open = article.getByRole("link", { name: "Open saved image" });
		await expect(open).toBeVisible({ timeout: 20_000 });
		const path = await open.getAttribute("href");
		const media = await ownerRequest(page).get(`${origin}${path}/media`);
		expect(media.headers()["content-type"]).toBe("image/jpeg");
		expect(await media.body()).toEqual(result);
		await open.click();
		await expect(page.getByText("JPEG · 6 × 4")).toBeVisible();

		// Z-Image's row has no format option, so Review leaves the type to the provider.
		await page.goto(`${origin}/image`);
		await page.getByLabel("Model", { exact: true }).selectOption("z-image");
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
		await expect(expected).toContainText(
			"The provider's choice. This model has no output format option.",
		);
		expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toHaveLength(1);
		expect(outbound).toEqual([]);
	} finally {
		await server?.stop();
		fixtures.stop();
		await rm(cacheHome, { recursive: true, force: true });
		await rm(dir, { recursive: true, force: true });
	}
});
