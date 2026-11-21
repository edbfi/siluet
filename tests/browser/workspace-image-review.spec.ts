import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const entry = new URL("../../design/workspace/index.html", import.meta.url).href;

test.use({ offline: true });

async function openImageStudio(page: Page, provider = "poyo") {
	await page.addInitScript((key) => {
		localStorage.setItem(
			"siluet.workspace.v1",
			JSON.stringify({
				version: 1,
				settings: { onboarded: true, keys: { [key]: true } },
			}),
		);
	}, provider);
	await page.goto(`${entry}#image`);
	return page.getByRole("region", { name: "Review request" });
}

test("Image Studio opens a four-field Review and keeps Queue available across tabs", async ({
	page,
}) => {
	const review = await openImageStudio(page);
	const tabs = review.getByRole("tablist", { name: "Review request" });
	const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
	const queue = review.getByRole("button", { name: "Queue 1 request" });
	await expect(tabs.getByRole("tab")).toHaveText(["Review", "Batch", "Outgoing request"]);
	await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Review");
	await expect(facts.locator("dt")).toHaveText([
		"API provider",
		"Operation",
		"Media sent",
		"Price",
	]);
	await expect(facts.locator("[data-studio-price]")).toHaveText(/\S/);
	await expect(facts.getByRole("button")).toHaveCount(0);
	await expect(review.getByLabel("Batch count")).toBeHidden();
	await expect(review.getByText("Simulation controls")).toBeHidden();
	await expect(queue).toBeVisible();

	await tabs.getByRole("tab", { name: "Batch" }).click();
	const batch = review.getByRole("tabpanel", { name: "Batch" });
	await expect(batch.getByText("Automatic retries are off.")).toBeVisible();
	await expect(batch.getByRole("button", { name: "Retry settings" })).toBeVisible();
	await batch.getByLabel("Batch count").selectOption("3");
	await batch.getByText("Simulation controls").click();
	await batch.getByLabel("Simulated outcome").selectOption("rate-limit");

	await tabs.getByRole("tab", { name: "Outgoing request" }).click();
	const queueBatch = review.getByRole("button", { name: "Queue 3 requests" });
	await expect(queueBatch).toHaveAccessibleDescription(/up to 3 potentially billable attempts/i);
	await expect(queueBatch).toBeVisible();
	await tabs.getByRole("tab", { name: "Review", exact: true }).click();
	await expect(review.getByText(/up to 3 potentially billable attempts/i)).toBeVisible();
	await expect(facts.getByText(/potentially billable/)).toHaveCount(0);
	await tabs.getByRole("tab", { name: "Batch" }).click();
	await expect(batch.getByLabel("Batch count")).toHaveValue("3");
	await expect(batch.getByLabel("Simulated outcome")).toHaveValue("rate-limit");
	await page.getByLabel("Prompt", { exact: true }).fill("Glaze on stoneware");
	await queueBatch.click();
	await expect(review.getByRole("status")).toHaveText(
		"Queued 3 requests. Follow progress in Jobs.",
	);
});

test("a one-request batch discloses the additional attempts before Queue when retries are enabled", async ({
	page,
}) => {
	const review = await openImageStudio(page);
	await review.getByRole("tab", { name: "Batch" }).click();
	await review.getByRole("button", { name: "Retry settings" }).click();
	await page.getByRole("switch", { name: "Automatic retries" }).check();
	await page.getByRole("combobox", { name: "Additional attempts per job" }).selectOption("2");
	await page.getByRole("link", { name: "Image Studio", exact: true }).click();
	const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
	const queue = review.getByRole("button", { name: "Queue 1 request" });
	await expect(facts).toBeVisible();
	await expect(queue).toHaveAccessibleDescription("Up to 3 potentially billable attempts.");
	await expect(review.getByText("Up to 3 potentially billable attempts.")).toBeVisible();
	await review.getByRole("tab", { name: "Batch" }).click();
	await expect(review.getByText("Up to 2 additional retries per request.")).toBeVisible();
});

test("the phone Review shortcut and arrow keys reach each panel without moving Queue into it", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	const review = await openImageStudio(page);
	await page.getByRole("link", { name: "Review request" }).click();
	await expect(review.getByRole("heading", { name: "Review request" })).toBeFocused();
	await page.keyboard.press("Tab");
	const selected = () => review.getByRole("tab", { selected: true });
	await expect(selected()).toBeFocused();
	await selected().press("ArrowLeft");
	await expect(selected()).toHaveText("Outgoing request");
	await expect(selected()).toBeFocused();
	await selected().press("ArrowRight");
	await expect(selected()).toHaveText("Review");
	await selected().press("ArrowRight");
	await expect(selected()).toHaveText("Batch");
	await selected().press("End");
	await expect(selected()).toHaveText("Outgoing request");
	await selected().press("Home");
	await expect(selected()).toHaveText("Review");
	await expect(review.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
	await expect(review.getByRole("tabpanel")).toHaveCount(1);
	await page.keyboard.press("Tab");
	await expect(review.getByRole("tabpanel", { name: "Review", exact: true })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(review.getByRole("button", { name: "Queue 1 request" })).toBeFocused();
});

for (const provider of ["poyo", "toapis"]) {
	test(`${provider} Image Studio shows exact JSON fields and redacts staged source URLs`, async ({
		page,
	}) => {
		const review = await openImageStudio(page, provider);
		await page.getByLabel("Model", { exact: true }).selectOption("qwen-image-3.0");
		await page.getByLabel("Operation", { exact: true }).selectOption("edit");
		const localFile = fileURLToPath(
			new URL("../../design/workspace/media/daymark.jpg", import.meta.url),
		);
		await page.getByLabel("Choose reference image 1 file").setInputFiles(localFile);
		await expect(page.getByLabel("Replace reference image 1 file")).toBeVisible();
		await page.getByText("Use a URL", { exact: true }).nth(1).click();
		const sourceUrl = "https://images.example.invalid/reference.png?token=fixture-secret";
		await page.getByLabel("HTTP or HTTPS URL for reference image 2").fill(sourceUrl);
		await page.getByRole("button", { name: "Use URL", exact: true }).click();
		const prompt = `  Glaze <blue> & gold. See ${sourceUrl}  `;
		await page.getByLabel("Prompt", { exact: true }).fill(prompt);
		await page.getByLabel("Resolution", { exact: true }).selectOption("2K");
		await page.getByRole("button", { name: "4:3", exact: true }).click();
		await page.getByText("Advanced options", { exact: true }).click();
		await page.getByLabel("Expand prompt").uncheck();
		if (provider === "poyo") await page.getByLabel("Output format").selectOption("jpeg");
		else await page.getByLabel("Visible watermark").check();
		await expect(review.getByRole("tabpanel")).toContainText("daymark.jpg");
		await expect(review.getByRole("tabpanel")).toContainText("images.example.invalid (URL hidden)");

		const outgoing = review.getByRole("tab", { name: "Outgoing request" });
		await outgoing.click();
		const panel = review.getByRole("tabpanel", { name: "Outgoing request" });
		const body = panel.locator("pre code");
		const input = {
			prompt: "Glaze <blue> & gold. See [URL hidden]",
			image_urls: ["[local image]", "[remote URL hidden]"],
			size: "4:3",
			resolution: "2K",
		};
		expect(JSON.parse((await body.textContent()) ?? "")).toEqual(
			provider === "poyo"
				? {
						model: "qwen-image-3",
						input: {
							...input,
							enable_safety_checker: false,
							output_format: "jpeg",
							prompt_extend: false,
						},
					}
				: {
						model: "qwen-image-3.0",
						...input,
						disable_nsfw: false,
						metadata: { prompt_extend: false, watermark: true },
					},
		);
		await expect(panel).not.toContainText(
			/images\.example\.invalid|fixture-secret|daymark\.jpg|blob:/,
		);
		await review.getByRole("tab", { name: "Batch" }).click();
		await review.getByRole("tab", { name: "Review", exact: true }).click();
		await expect(review.getByRole("tabpanel")).toContainText("daymark.jpg");
		await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(prompt);
	});
}
