import { rm } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { d4Disclosure } from "../../src/lib/shared/media-catalog/filtering";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

const samePath =
	"Same request path as verified Seedream 5.5 on Poyo.ai. Options from Poyo.ai's schema dated 2026-11-26 (ec73207). This model was not tested individually.";
const access =
	"Poyo.ai does not publish per-key model access. Siluet has checked only that this key works.";
const gallery =
	"Gallery saves images up to 20 megapixels. A completed billable image over that stays with the provider.";

test("a Queue-eligible derived row composes from its row and Review states what it binds", async ({
	page,
}) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(12_000);
	const directory = await createOwnerDirectory();
	const submitted: { model: string; input: Record<string, unknown> }[] = [];
	const respond = jobResponses();
	const fixture = startProviderFixtures(async (request, path) => {
		if (path === "/poyo/submit" && request.method === "POST") {
			const body = await request.clone().json();
			submitted.push(body);
			// Poyo.ai refuses this model for this key: one job, and the key stays.
			if (body.model === "flux-schnell")
				return Response.json(
					{ code: 403, error: { type: "permission_denied_error", message: "not enabled" } },
					{ status: 403 },
				);
		}
		return respond(request, path);
	});
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", false, fixture.env);
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
		const model = page.getByLabel("Model", { exact: true });
		await model.selectOption("flux-dev");
		await expect(page.getByText("Poyo.ai image", { exact: true })).toBeVisible();
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("A paper crane on a windowsill");
		// Fields come from the row: its offered formats in schema order, preselected on its default.
		const format = page.getByLabel("Output format", { exact: true });
		await expect(format.locator("option")).toHaveText(["JPEG", "PNG"]);
		await expect(format).toHaveValue("png");
		await expect(page.getByText(/keeps its own\s+5,000-character limit/)).toBeVisible();

		// Review states what it binds, before any Review request and with no network.
		const review = page.getByRole("region", { name: "Review request" });
		const fact = (name: string) =>
			review.locator("dl > div").filter({ has: page.getByRole("term").getByText(name) });
		await expect(fact("Contract")).toContainText(samePath);
		await expect(fact("Route evidence")).toContainText(access);
		await expect(fact("Route evidence")).not.toContainText("declares");
		await expect(fact("Expected type")).toContainText("PNG, requested as png");
		await expect(fact("Expected type")).toContainText(gallery);
		await expect(fact("Price")).toContainText(
			"Unknown. No local rate is available for this request.",
		);
		await expect(review.getByRole("list", { name: "Provider disclosure" })).toHaveText(
			d4Disclosure("poyo"),
		);
		// The new facts take the Review list's Panda styles on the built page.
		const computed = (locator: Locator) =>
			locator.evaluate((node) => {
				const { color, fontSize, display, gridTemplateColumns } = getComputedStyle(node);
				return { color, fontSize, display, gridTemplateColumns };
			});
		expect(await computed(fact("Contract"))).toEqual(await computed(fact("Price")));
		expect(await computed(fact("Contract").getByRole("term"))).toEqual(
			await computed(fact("Price").getByRole("term")),
		);

		// One request with zero retries: the Batch tab's choices are locked.
		const batchTab = review.getByRole("tab", { name: "Batch" });
		await batchTab.click();
		await expect(batchTab).toHaveAttribute("aria-selected", "true");
		await expect(batchTab).toHaveAttribute("data-selected", "");
		await expect(review.getByLabel("Batch count")).toBeDisabled();
		await expect(review.getByLabel("Additional attempts per request")).toBeDisabled();
		await expect(
			review.getByText("This model queues one request with zero additional attempts."),
		).toBeVisible();
		await review.getByRole("tab", { name: "Outgoing request" }).click();
		const json = JSON.parse((await review.getByLabel("JSON request body").textContent()) ?? "");
		expect(json).toEqual({
			model: "flux-dev",
			input: {
				prompt: "A paper crane on a windowsill",
				output_format: "png",
				n: 1,
				enable_safety_checker: false,
			},
		});
		await review.getByRole("tab", { name: "Review" }).click();

		// A declared row says the contract declares the field and binds no disclosure.
		await model.selectOption("seedream-4.5");
		await expect(prompt).toHaveValue("A paper crane on a windowsill");
		await expect(fact("Route evidence")).toContainText(
			"The model contract declares input.enable_safety_checker: false.",
		);
		await expect(review.getByRole("list", { name: "Provider disclosure" })).toHaveCount(0);
		// G13 offers its 4K tier within Gallery's 20 MP, and never a custom size.
		await expect(page.getByLabel("Size", { exact: true }).locator("option")).toHaveText([
			"2K",
			"4K",
			"1:1",
			"4:3",
			"3:4",
			"16:9",
			"9:16",
			"3:2",
			"2:3",
			"21:9",
		]);
		await expect(fact("Expected type")).toContainText("The provider's choice.");

		// A Poyo.ai permission refusal refuses one job, keeps the key, and Review shows it.
		await model.selectOption("flux-schnell");
		await review.getByRole("button", { name: "Review request" }).click();
		const consent = review.getByLabel("I accept the unknown cost of this request.");
		await expect(review.getByRole("button", { name: "Queue 1 request" })).toBeDisabled();
		await consent.check();
		await review.getByRole("button", { name: "Queue 1 request" }).click();
		await page.waitForURL(/\/jobs/);
		await expect(
			page.getByText("Poyo.ai refused this model for this key. The saved key is unchanged."),
		).toBeVisible();
		expect(submitted).toEqual([
			{
				model: "flux-schnell",
				input: {
					prompt: "A paper crane on a windowsill",
					output_format: "png",
					n: 1,
					enable_safety_checker: false,
				},
			},
		]);
		await page.goto(`${origin}/image`);
		await model.selectOption("flux-schnell");
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Another crane");
		await expect(fact("Route evidence")).toContainText(
			`Poyo.ai refused this model for this key on ${new Date().toISOString().slice(0, 10)}.`,
		);
		await expect(review.getByRole("button", { name: "Review request" })).toBeEnabled();
		expect(outbound).toEqual([]);
	} finally {
		await server?.stop();
		await fixture.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

/** A built studio with Poyo.ai connected through the fixtures, on the Image Studio page. */
async function withConnectedStudio(
	page: Page,
	run: (
		origin: string,
		submitted: { model: string; input: Record<string, unknown> }[],
	) => Promise<void>,
	refuse: (model: string) => boolean = () => false,
) {
	const directory = await createOwnerDirectory();
	const submitted: { model: string; input: Record<string, unknown> }[] = [];
	const respond = jobResponses();
	const fixture = startProviderFixtures(async (request, path) => {
		if (path === "/poyo/submit" && request.method === "POST") {
			const body = await request.clone().json();
			submitted.push(body);
			if (refuse(body.model))
				return Response.json(
					{ code: 403, error: { type: "permission_denied_error", message: "not enabled" } },
					{ status: 403 },
				);
		}
		return respond(request, path);
	});
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", false, fixture.env);
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
		await run(origin, submitted);
		expect(outbound).toEqual([]);
	} finally {
		await server?.stop();
		await fixture.stop();
		await rm(directory, { recursive: true, force: true });
	}
}

test("a Seedream batch does not follow the creator to a derived row, whose Review queues one request", async ({
	page,
}) => {
	test.setTimeout(60_000);
	page.setDefaultTimeout(12_000);
	await withConnectedStudio(page, async () => {
		const review = page.getByRole("region", { name: "Review request" });
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("A paper crane");
		await review.getByRole("tab", { name: "Batch" }).click();
		await review.getByLabel("Batch count").selectOption("2");
		await review.getByLabel("Additional attempts per request").selectOption("1");
		await expect(review.getByRole("button", { name: "Queue 2 requests" })).toBeVisible();
		await review.getByRole("tab", { name: "Review" }).click();

		await page.getByLabel("Model", { exact: true }).selectOption("flux-dev");
		await expect(review.getByRole("button", { name: "Queue 1 request" })).toBeVisible();
		await expect(review.getByRole("button", { name: "Review request" })).toBeEnabled();
		await expect(review.getByRole("status")).toHaveText(
			"Review the completed request to confirm its current terms.",
		);
		await expect(review).toContainText("Up to 1 potentially billable submission.");
		await review.getByRole("tab", { name: "Batch" }).click();
		await expect(review.getByLabel("Batch count")).toHaveValue("1");
		await expect(review.getByLabel("Additional attempts per request")).toHaveValue("0");
	});
});

test("a refusal recorded for a shipped Poyo.ai model shows in its Review", async ({ page }) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(12_000);
	const refused = new Set(["seedream-5.5", "z-image"]);
	await withConnectedStudio(
		page,
		async (origin, submitted) => {
			const review = page.getByRole("region", { name: "Review request" });
			const model = page.getByLabel("Model", { exact: true });
			const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
			const evidence = review
				.locator("dl > div")
				.filter({ has: page.getByRole("term").getByText("Route evidence") });
			const note = `Poyo.ai refused this model for this key on ${new Date().toISOString().slice(0, 10)}.`;
			for (const [index, id] of [...refused].entries()) {
				await model.selectOption(id);
				await prompt.fill(`A refused ${id} crane`);
				await expect(evidence).toContainText("The balance check accepted this key.");
				await expect(evidence).not.toContainText("refused");
				await review.getByRole("button", { name: "Review request" }).click();
				const consent = review.getByRole("checkbox", { name: /unknown/i });
				const queue = review.getByRole("button", { name: "Queue 1 request" });
				await expect(consent.or(queue.and(page.locator(":enabled")))).not.toHaveCount(0);
				if (await consent.count()) await consent.check();
				await queue.click();
				await page.waitForURL(/\/jobs/);
				// One refused job per model so far, each with its note.
				await expect(
					page.getByText("Poyo.ai refused this model for this key. The saved key is unchanged."),
				).toHaveCount(index + 1);
				await page.goto(`${origin}/image`);
				await model.selectOption(id);
				await prompt.fill("Another crane");
				await expect(evidence).toContainText(note);
				await expect(review.getByRole("button", { name: "Review request" })).toBeEnabled();
			}
			// Each model was sent once, and refused.
			expect(submitted.map(({ model }) => model)).toEqual(["seedream-5.5", "z-image"]);
		},
		(model) => refused.has(model),
	);
});

test("once a derived Review is authorised, it shows the wording the server bound", async ({
	page,
}) => {
	test.setTimeout(60_000);
	page.setDefaultTimeout(12_000);
	await withConnectedStudio(page, async (origin) => {
		const review = page.getByRole("region", { name: "Review request" });
		const fact = (name: string) =>
			review.locator("dl > div").filter({ has: page.getByRole("term").getByText(name) });
		await page.getByLabel("Model", { exact: true }).selectOption("flux-dev");
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("A paper crane");
		await expect(fact("Contract")).toContainText(samePath);
		// The server's terms are what Queue binds, so Review shows them over its offline copy.
		await page.route(`${origin}/image/review`, async (route) => {
			const response = await route.fetch();
			const terms = await response.json();
			terms.wording = {
				...terms.wording,
				samePath: "The server's same-path sentence.",
				access: "The server's access note.",
				gallery: "The server's Gallery statement.",
			};
			await route.fulfill({ response, json: terms });
		});
		await review.getByRole("button", { name: "Review request" }).click();
		await expect(review.getByLabel("I accept the unknown cost of this request.")).toBeVisible();
		await expect(fact("Contract")).toContainText("The server's same-path sentence.");
		await expect(fact("Route evidence")).toContainText("The server's access note.");
		await expect(fact("Expected type")).toContainText("The server's Gallery statement.");
		await expect(fact("Contract")).not.toContainText("`");
	});
});
