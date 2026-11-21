import { expect, test } from "@playwright/test";

test("the built studio serves health, styles and an interactive status control", async ({
	page,
	request,
}) => {
	const base = process.env.SILUET_TEST_URL;
	if (!base) throw new Error("The built server did not report its loopback URL.");

	const health = await request.get(new URL("/healthz", base).href);
	expect(health.status()).toBe(200);
	expect(await health.json()).toEqual({ status: "ok" });

	await page.goto(base);
	await expect(page.getByRole("heading", { name: "Siluet", exact: true })).toBeVisible();
	await expect(page.getByRole("main")).toHaveCSS("padding-top", "32px");
	const status = page.getByRole("button", { name: "Studio status" });
	await expect(status).toHaveAttribute("aria-expanded", "false");
	await status.click();
	await expect(page.getByText("The local studio is running.")).toBeVisible();
});
