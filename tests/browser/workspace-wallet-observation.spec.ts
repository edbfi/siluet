import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";

import { exportWorkspace } from "../../design/workspace/export";
import { loadBundledPricing } from "../../scripts/pricing/local-feed";
import { reloadOrigin, reloadTest, reloadUrl } from "./workspace-reload";

const workspace = new URL("../../design/workspace/", import.meta.url);
const time = new Date("2026-11-21T12:00:00Z");
let portableDirectory: string;
let portableEntry: URL;
let sourceEntry: URL;

test.use({ offline: true, locale: "en-US", timezoneId: "UTC" });

test.beforeAll(async () => {
	portableDirectory = await mkdtemp(join(tmpdir(), "siluet-wallet-"));
	const source = pathToFileURL(`${join(portableDirectory, "source")}/`);
	await cp(workspace, source, {
		recursive: true,
		filter: (file) => !/(?:workspace\.html|\.generated\.js)$/.test(file),
	});
	const [, standalone] = await exportWorkspace(source, await loadBundledPricing("poyo"));
	await mkdir(join(portableDirectory, "portable"));
	portableEntry = pathToFileURL(join(portableDirectory, "portable", "workspace.html"));
	await rename(standalone, portableEntry);
	sourceEntry = new URL("index.html", source);
});

test.afterAll(async () => {
	await rm(portableDirectory, { recursive: true, force: true });
});

async function openStudio(page: Page, filename = "index.html", reloadable = false) {
	await page.clock.install({ time });
	const entry = filename === "workspace.html" ? portableEntry : sourceEntry;
	await page.goto(`${reloadable ? reloadUrl(entry) : entry.href}#image`);
	const setup = page.getByRole("dialog", { name: "Choose your demo providers" });
	await setup.getByRole("checkbox", { name: /Poyo.ai/ }).check();
	await setup.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("button", { name: "Connect Poyo.ai demo key" }).click();
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("button", { name: "Open studio" }).click();
}

async function queue(page: Page, prompt: string, count = 1) {
	await page.getByLabel("Prompt", { exact: true }).fill(prompt);
	if (count > 1) {
		await page.getByRole("tab", { name: "Batch" }).click();
		await page.getByLabel("Batch count").selectOption(String(count));
		await page.getByRole("tab", { name: "Review", exact: true }).click();
	}
	await page
		.getByRole("button", { name: `Queue ${count} request${count === 1 ? "" : "s"}` })
		.click();
}

function billing(page: Page) {
	return page.getByRole("region", { name: "Billing" });
}

async function jobs(page: Page) {
	const nav = page.getByRole("button", { name: "Open navigation" });
	if (await nav.isVisible()) await nav.click();
	await page.getByRole("link", { name: "Jobs", exact: true }).click();
}

for (const filename of ["index.html", "workspace.html"]) {
	reloadTest(`${filename} shows one wallet interval for a completed batch`, async ({ page }) => {
		const requests: string[] = [];
		await page.route(/^https?:/, (route) => {
			if (route.request().url().startsWith(`${reloadOrigin}/`)) return route.fallback();
			requests.push(route.request().url());
			return route.abort();
		});
		if (filename === "workspace.html") await page.setViewportSize({ width: 320, height: 720 });
		await openStudio(page, filename, true);
		await queue(page, "Light falling across the bay", 2);
		await page.clock.runFor(1500);
		await jobs(page);
		const section = billing(page);
		await expect(section).toContainText("2 Poyo.ai credits estimated");
		await expect(section).toContainText("Settled charge");
		await expect(section.getByText("Unknown", { exact: true })).toBeVisible();
		await expect(section).toContainText("Observed batch wallet change");
		await expect(section).toContainText("−3.2 credits");
		await expect(section).toContainText("2480 credits");
		await expect(section).toContainText("2476.8 credits");
		await expect(section).not.toContainText("historical sample");
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			page.viewportSize()?.width ?? 0,
		);
		await expect(section.locator("time")).toHaveCount(2);
		const [before, after] = await section
			.locator("time")
			.evaluateAll((times) => times.map((time) => time.getAttribute("datetime")));
		expect(Date.parse(after ?? "")).toBeGreaterThan(Date.parse(before ?? ""));

		await page.getByRole("button", { name: /^Wallets\b/ }).click();
		const dialog = page.getByRole("dialog", { name: "Wallets" });
		await expect(dialog.locator('[data-wallet-provider="poyo"]')).toContainText("2,476.8 credits");
		await expect(dialog.locator('[data-wallet-provider="poyo"] time')).toHaveAttribute(
			"datetime",
			after ?? "",
		);
		await page.keyboard.press("Escape");
		await page.reload();
		await expect(section).toContainText("−3.2 credits");
		await expect(section.locator("time").nth(0)).toHaveAttribute("datetime", before ?? "");
		await expect(section.locator("time").nth(1)).toHaveAttribute("datetime", after ?? "");
		expect(requests).toEqual([]);
	});
}

test("a later matching request shows one isolated observed debit beside its public estimate", async ({
	page,
}) => {
	await openStudio(page);
	await queue(page, "First light");
	await page.clock.runFor(1500);
	await queue(page, "Another light");
	await jobs(page);
	const section = billing(page);
	await expect(section).toContainText("2 Poyo.ai credits estimated");
	await expect(section).toContainText("Historical observed wallet change");
	await expect(section).toContainText("−3.2 credits · 1 sample");
	await expect(section.getByText("Unknown", { exact: true })).toBeVisible();
});

test("an automatic retry keeps its original wallet window open", async ({ page }) => {
	await openStudio(page);
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Generation", exact: true }).click();
	await page.getByRole("switch", { name: "Automatic retries" }).check();
	await page.getByLabel("Additional attempts per job", { exact: true }).selectOption("1");
	await page.getByRole("link", { name: "Image Studio", exact: true }).click();
	await page.getByRole("tab", { name: "Batch" }).click();
	await page.getByText("Simulation controls", { exact: true }).click();
	await page.getByLabel("Simulated outcome").selectOption("transient");
	await queue(page, "A still with one automatic retry");
	await page.clock.runFor(1300);
	await jobs(page);
	await expect(billing(page)).toContainText("Waiting for requests to finish");
	await expect(billing(page).locator("time")).toHaveCount(0);
	await page.clock.runFor(2200);
	await expect(billing(page)).toContainText("−3.2 credits");
	await expect(billing(page).locator("time")).toHaveCount(2);
	const [start, end] = await billing(page)
		.locator("time")
		.evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute("datetime") ?? "")));
	expect(end - start).toBeGreaterThanOrEqual(3000);
});

reloadTest("manual retry wallet readings survive reload", async ({ page }) => {
	await openStudio(page, "index.html", true);
	await page.getByRole("tab", { name: "Batch" }).click();
	await page.getByText("Simulation controls", { exact: true }).click();
	await page.getByLabel("Simulated outcome").selectOption("failure");
	await queue(page, "A still with one manual retry");
	await page.clock.runFor(1500);
	await jobs(page);
	const section = billing(page);
	await expect(section).toContainText("−3.2 credits");
	await page.getByRole("button", { name: "Review new submission" }).click();
	await page.getByRole("button", { name: "Approve new submission" }).click();
	await page.clock.runFor(1500);
	await expect(section).toContainText("−1.7 credits");
	await page.reload();
	await expect(section).toContainText("−1.7 credits");
	await expect(section).toContainText("2475.1 credits");
	await page.getByRole("button", { name: "Attempt 1", exact: true }).click();
	await expect(section).toContainText("−3.2 credits");
	await expect(section).toContainText("2480 credits");
});

test("overlapping batches withhold both comparisons", async ({ page }) => {
	await openStudio(page);
	await queue(page, "First active batch");
	await page.clock.runFor(100);
	await queue(page, "Overlapping batch");
	await page.clock.runFor(1500);
	await jobs(page);
	await expect(billing(page)).toContainText("Overlapping requests");
	await page
		.getByRole("list", { name: "Job attempts" })
		.getByRole("button", { name: /First active batch/ })
		.click();
	await expect(billing(page)).toContainText("Overlapping requests");
	await expect(billing(page)).not.toContainText("historical sample");
});
