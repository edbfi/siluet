import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { exportWorkspace } from "../../design/workspace/export";
import type { PricingFeed } from "../../src/lib/shared/pricing/feed";
import { decodeToapisPricingFeed } from "../../src/lib/shared/pricing/toapis-feed";
import { toapisRates } from "../fixtures/toapis-feed";
import { reloadTest } from "./file-reload";

const workspace = new URL("../../design/workspace/", import.meta.url);
// https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json
const pinnedRates = {
	version: 1,
	provider: "poyo",
	revision: "747e5d75319585d66396a3c05bd1b97d9390ce74",
	sourceDate: "2026-11-19T13:42:30Z",
	rates: {
		"z-image": { kind: "per-request", credits: "2" },
		"seedream-5.5": {
			kind: "per-image-with-references",
			resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
			perReference: "1.6",
		},
	},
} satisfies PricingFeed;
const reviewedAt = new Date("2026-11-21T12:00:00Z");
const expiredAt = new Date("2027-01-01T12:00:00Z");
let previewDirectory: string;
let sourceEntry: URL;
let portableEntry: URL;

test.use({ offline: true });

test.beforeAll(async () => {
	previewDirectory = await mkdtemp(join(tmpdir(), "siluet-pricing-"));
	const sourceDirectory = pathToFileURL(`${previewDirectory}/source/`);
	await cp(workspace, sourceDirectory, {
		recursive: true,
		filter: (source) => !/(?:workspace\.html|pricing\.generated\.js)$/.test(source),
	});
	const [, standalone] = await exportWorkspace(sourceDirectory, {
		poyo: pinnedRates,
		toapis: decodeToapisPricingFeed(toapisRates),
	});
	await mkdir(join(previewDirectory, "portable"));
	sourceEntry = new URL("index.html", sourceDirectory);
	portableEntry = pathToFileURL(join(previewDirectory, "portable", "workspace.html"));
	await rename(standalone, portableEntry);
});

test.afterAll(async () => {
	await rm(previewDirectory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
	await page.clock.install({ time: reviewedAt });
	await page.addInitScript(() => {
		const key = "siluet.workspace.v1";
		if (localStorage.getItem(key)) return;
		localStorage.setItem(
			key,
			JSON.stringify({
				version: 1,
				settings: {
					onboarded: true,
					keys: { poyo: true, toapis: true },
					retryEnabled: true,
					retryLimit: 3,
				},
			}),
		);
	});
});

function reviewPrice(page: Page) {
	return page.getByRole("tabpanel", { name: "Review", exact: true }).locator("[data-studio-price]");
}

for (const filename of ["index.html", "workspace.html"]) {
	test(`${filename} quotes the documented PoYo rates offline`, async ({ page }) => {
		const requests: string[] = [];
		await page.route(/^https?:/, (route) => {
			requests.push(route.request().url());
			return route.abort();
		});
		const entry = filename === "index.html" ? sourceEntry : portableEntry;
		if (filename === "workspace.html") await page.setViewportSize({ width: 320, height: 720 });
		await page.goto(`${entry.href}#image`);
		const price = reviewPrice(page);
		await expect(price).toContainText("2 Poyo.ai credits estimated");
		await expect(price).toContainText("2026-11-19");

		await page.getByLabel("Model", { exact: true }).selectOption("seedream-5.5");
		await expect(price).toContainText("7 Poyo.ai credits estimated");
		await page.getByLabel("Resolution", { exact: true }).selectOption("1.5K");
		await expect(price).toContainText("4 Poyo.ai credits estimated");
		await page.getByLabel("Resolution", { exact: true }).selectOption("2K");
		await page.getByLabel("Operation", { exact: true }).selectOption("edit");
		await expect(price).toContainText("Estimate unavailable");

		for (const index of [1, 2]) {
			await page
				.getByText("Use a URL", { exact: true })
				.nth(index - 1)
				.click();
			await page
				.getByLabel(`HTTP or HTTPS URL for reference image ${index}`)
				.fill(`https://images.example.invalid/ref-${index}.png?key=fixture-secret`);
			await page.getByRole("button", { name: "Use URL", exact: true }).click();
		}
		await expect(price).toContainText("10.2 Poyo.ai credits estimated");
		await page.getByRole("tab", { name: "Batch" }).click();
		await page.getByLabel("Batch count").selectOption("5");
		await page.getByRole("tab", { name: "Review", exact: true }).click();
		await expect(price).toContainText("51 Poyo.ai credits estimated");
		await expect(price).toContainText("Up to 20 attempts");
		await expect(price).toContainText("Total charge unknown");
		await expect(price).not.toContainText(/fixture-secret|images\.example\.invalid/);
		await page.getByRole("radio", { name: "ToAPIs", exact: true }).check();
		await expect(price).toContainText("Estimate unavailable");
		await expect(price).toContainText("Up to 20 attempts");
		expect(requests).toEqual([]);
	});
}

test("an expired Image Studio quote returns to Review before Queue can create a job", async ({
	page,
}) => {
	await page.goto(`${sourceEntry.href}#image`);
	const title = "Copper light on the tide";
	await page.getByLabel("Prompt", { exact: true }).fill(title);
	await expect(reviewPrice(page)).toContainText("2 Poyo.ai credits estimated");

	const review = page.getByRole("region", { name: "Review request" });
	const queue = review.getByRole("button", { name: "Queue 1 request" });
	await review.getByRole("tab", { name: "Outgoing request" }).click();
	await page.clock.setSystemTime(expiredAt);
	await queue.press("Enter");

	await expect(
		review.getByRole("tab", { name: "Review", exact: true, selected: true }),
	).toBeFocused();
	await expect(reviewPrice(page)).toContainText("The published rates have expired.");
	await expect(review.getByRole("status")).toContainText("The price estimate changed");

	await queue.press("Enter");
	await expect(review.getByRole("status")).toContainText("Queued 1 request.");
	await review.getByRole("button", { name: "View jobs" }).click();
	const attempts = page.getByRole("list", { name: "Job attempts" });
	await expect(attempts.getByRole("button", { name: new RegExp(title) })).toHaveCount(1);
	await expect(page.getByRole("region", { name: "Billing" })).toContainText("Estimate unavailable");
});

reloadTest(
	"Jobs keeps the reviewed estimate through an automatic retry, expiry, and reload",
	async ({ page }) => {
		await page.goto(`${sourceEntry.href}#image`);
		await page.getByLabel("Prompt", { exact: true }).fill("Tide over black basalt");
		await page.getByRole("tab", { name: "Batch" }).click();
		await page.getByText("Simulation controls", { exact: true }).click();
		await page.getByLabel("Simulated outcome").selectOption("transient");
		await page.getByRole("button", { name: "Queue 1 request" }).click();
		await page.clock.setSystemTime(expiredAt);
		await page.clock.runFor(2500);

		await page.getByRole("link", { name: "Jobs", exact: true }).click();
		const billing = page.getByRole("region", { name: "Billing" });
		await expect(billing).toContainText("2 Poyo.ai credits estimated");
		await expect(billing).toContainText("2026-11-19");
		await expect(billing.getByText("Settled charge", { exact: true })).toBeVisible();
		await expect(billing.getByText("Unknown", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Attempt 1", exact: true }).click();
		await page.reload();
		await expect(billing).toContainText("2 Poyo.ai credits estimated");
		await page.getByRole("link", { name: "Image Studio", exact: true }).click();
		await page.getByRole("tab", { name: "Review", exact: true }).click();
		await expect(reviewPrice(page)).toContainText("Estimate unavailable");
		await expect(reviewPrice(page)).toContainText("published rates have expired");
	},
);

test("an explicit retry reviews and records a fresh estimate for its one attempt", async ({
	page,
}) => {
	await page.goto(`${sourceEntry.href}#image`);
	await page.getByLabel("Prompt", { exact: true }).fill("Dunes at late afternoon");
	await page.getByRole("tab", { name: "Batch" }).click();
	await page.getByLabel("Batch count").selectOption("2");
	await page.getByText("Simulation controls", { exact: true }).click();
	await page.getByLabel("Simulated outcome").selectOption("failure");
	await page.getByRole("tab", { name: "Review", exact: true }).click();
	await expect(reviewPrice(page)).toContainText("4 Poyo.ai credits estimated");
	await page.getByRole("button", { name: "Queue 2 requests" }).click();
	await page.clock.runFor(1500);

	await page.getByRole("link", { name: "Jobs", exact: true }).click();
	const billing = page.getByRole("region", { name: "Billing" });
	await expect(billing).toContainText("2 Poyo.ai credits estimated");
	await page.getByRole("button", { name: "Review new submission" }).click();
	const outcome = page.getByRole("region", { name: "Job outcome" });
	const approve = page.getByRole("button", { name: "Approve new submission" });
	await expect(outcome).toContainText("2 Poyo.ai credits estimated");
	await page.clock.setSystemTime(expiredAt);
	await approve.click();
	await expect(outcome).toContainText("The price estimate changed");
	await expect(outcome).toContainText("Estimate unavailable");
	await expect(billing).toContainText("2 Poyo.ai credits estimated");
	await approve.click();
	await page.clock.runFor(1500);
	await expect(outcome).toContainText("Result saved");
	await expect(billing).toContainText("Estimate unavailable");
	await expect(billing.getByText("Unknown", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Attempt 1", exact: true }).click();
	await expect(billing).toContainText("2 Poyo.ai credits estimated");
});

for (const filename of ["index.html", "workspace.html"]) {
	test(`${filename} reviews ordinary ToAPIs tiers and excludes exact pixels offline`, async ({
		page,
	}) => {
		const requests: string[] = [];
		await page.route(/^https?:/, (route) => {
			requests.push(route.request().url());
			return route.abort();
		});
		const entry = filename === "index.html" ? sourceEntry : portableEntry;
		if (filename === "workspace.html") await page.setViewportSize({ width: 320, height: 720 });
		await page.goto(`${entry.href}#image`);
		await page.getByLabel("Model", { exact: true }).selectOption("seedream-5.5");
		await page.getByRole("radio", { name: "ToAPIs", exact: true }).check();
		const price = reviewPrice(page);
		await expect(price).toContainText("≈5.6 ToAPIs credits");
		await expect(price).toContainText("Advertised estimate ($0.028)");
		await expect(price).toContainText("Rates observed 2026-11-20");
		await page.getByRole("button", { name: "1:1", exact: true }).click();
		await expect(price).toContainText("Estimate unavailable");
		await page.getByLabel("Size mode").selectOption("tier");
		await page.getByLabel("Resolution", { exact: true }).selectOption("1K");
		await expect(price).toContainText("≈3.2 ToAPIs credits");
		await page.getByRole("tab", { name: "Batch", exact: true }).click();
		await page.getByLabel("Batch count").selectOption("5");
		await page.getByRole("tab", { name: "Review", exact: true }).click();
		await expect(price).toContainText("≈16 ToAPIs credits");
		await expect(price).toContainText("Up to 20 attempts");
		expect(requests).toEqual([]);
	});
}

reloadTest(
	"Jobs retains an advertised ToAPIs estimate and source across automatic retries and reload",
	async ({ page }) => {
		await page.goto(`${sourceEntry.href}#image`);
		const title = "Tide over black basalt";
		await page.getByLabel("Model", { exact: true }).selectOption("seedream-5.5");
		await page.getByRole("radio", { name: "ToAPIs", exact: true }).check();
		await page.getByLabel("Prompt", { exact: true }).fill(title);
		await page.getByRole("tab", { name: "Batch" }).click();
		await page.getByText("Simulation controls", { exact: true }).click();
		await page.getByLabel("Simulated outcome").selectOption("transient");
		await page.getByRole("button", { name: "Queue 1 request" }).click();
		await page.clock.setSystemTime(expiredAt);
		await page.clock.runFor(11000);

		await page.getByRole("link", { name: "Jobs", exact: true }).click();
		const attempts = page
			.getByRole("list", { name: "Job attempts" })
			.getByRole("button", { name: new RegExp(title) });
		await expect(attempts).toHaveCount(4);
		await page.getByRole("button", { name: "Attempt 1", exact: true }).click();
		const billing = page.getByRole("region", { name: "Billing" });
		await expect(billing).toContainText("≈5.6 ToAPIs credits");
		await expect(billing).toContainText("Public rates observed 2026-11-20");
		await expect(billing).toContainText("Settled charge");
		await page.reload();
		await expect(attempts).toHaveCount(4);
		await expect(page.getByRole("button", { name: "Attempt 1", exact: true })).toBeVisible();
		await expect(billing).toContainText("≈5.6 ToAPIs credits");
		await expect(billing).toContainText("Public rates observed 2026-11-20");
	},
);

test("Video Studio shows the applicable Seedance token rate with an unknown request total", async ({
	page,
}) => {
	await page.goto(`${sourceEntry.href}#video`);
	await page.getByLabel("Model", { exact: true }).selectOption("seedance-2.5");
	await page.getByRole("radio", { name: "ToAPIs", exact: true }).check();
	await page.getByLabel("Operation", { exact: true }).selectOption("generate");
	const price = page.getByRole("region", { name: "Review request" }).locator("[data-studio-price]");
	await expect(price).toContainText("Request total unknown");
	await expect(price).toContainText("$10 per million total tokens");
	await page.getByLabel("Operation", { exact: true }).selectOption("animate");
	await expect(price).toContainText("Estimate unavailable");
	await page.getByText("Use a URL", { exact: true }).click();
	const frameUrl = page.getByRole("textbox", { name: "HTTP or HTTPS URL for starting frame" });
	const addFrame = page.getByRole("button", { name: "Use URL", exact: true });
	await frameUrl.fill(`https://example.invalid/${"é".repeat(1013)}`);
	await addFrame.click();
	await expect(page.getByText(/2048 bytes/)).toBeVisible();
	await expect(price).toContainText("Estimate unavailable");
	await frameUrl.fill("https://images.example.invalid/first.png");
	await addFrame.click();
	await expect(price).toContainText("$10 per million total tokens");
	await page.getByText("Outgoing request", { exact: true }).click();
	const wire = page.locator(".studio-wire-options");
	await expect(wire.filter({ hasText: "image_with_roles" })).toContainText('"role":"first_frame"');
	await expect(wire.filter({ hasText: "aspect_ratio" })).toContainText('"aspect_ratio":"adaptive"');
	await page.getByLabel("Prompt", { exact: true }).fill("Frame study at dusk");
	await page.getByRole("button", { name: "Queue 1 request" }).click();
	await page.getByRole("link", { name: "Jobs", exact: true }).click();
	await expect(page.getByRole("region", { name: "Billing" })).toContainText(
		"$10 per million total tokens",
	);
	await page.getByRole("link", { name: "Video Studio", exact: true }).click();
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	await page.getByText("Use a URL", { exact: true }).click();
	await page
		.getByRole("textbox", { name: /HTTP or HTTPS URL/i })
		.fill("https://images.example.invalid/clip.mp4");
	await page.getByRole("button", { name: "Use URL", exact: true }).click();
	await expect(price).toContainText("Request total unknown");
	await expect(price).toContainText("$6 per million total tokens");
});
