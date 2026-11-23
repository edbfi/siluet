import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { cmykJpeg, markedFile } from "../fixtures/local-image";
import { prompt, withEditStudio } from "./edit-studio-fixture";

// A JPEG with an APP9 segment the cleaner cannot classify. An original may carry it.
async function vendorJpeg() {
	const jpeg = await sharp({
		create: { width: 24, height: 16, channels: 3, background: "#406080" },
	})
		.jpeg()
		.toBuffer();
	const payload = Buffer.from("vendor-specific\0data");
	const header = Buffer.from([0xff, 0xe9, 0, 0]);
	header.writeUInt16BE(payload.length + 2, 2);
	return {
		name: "vendor.jpg",
		mimeType: "image/jpeg",
		buffer: Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]),
	};
}

async function openEdit(page: Page, origin: string) {
	await page.goto(`${origin}/image`);
	await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	const file = page.getByLabel("Reference image 1", { exact: true });
	const review = page.getByRole("region", { name: "Review request", exact: true });
	return {
		file,
		review,
		inspect: review.getByRole("button", { name: "Review request", exact: true }),
		queue: review.getByRole("button", { name: "Queue 1 request" }),
		consent: review.getByRole("checkbox", { name: /unknown total cost/ }),
	};
}

// The owner changes the setting in another tab; this tab is then shown again.
async function changeElsewhere(page: Page, origin: string, enabled: boolean) {
	const { revision } = await (await page.request.get(`${origin}/settings/files/state`)).json();
	const saved = await page.request.post(`${origin}/settings/files`, {
		headers: { origin, accept: "text/html" },
		form: { expectedRevision: String(revision), ...(enabled ? { enabled: "on" } : {}) },
	});
	expect(saved.ok()).toBe(true);
}
const shown = (page: Page) =>
	page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

// Hold the next staging response until `release()`. Its request reaches the server at once.
async function holdNextStaging(page: Page) {
	const arrived = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let held = false;
	await page.route("**/image/files/*", async (route) => {
		if (route.request().method() !== "POST" || held) return route.fallback();
		held = true;
		const response = await route.fetch();
		arrived.resolve();
		await released.promise;
		await route.fulfill({ response });
	});
	return { arrived: arrived.promise, release: () => released.resolve() };
}
const cleanedHelp = (page: Page) => page.getByText(/Siluet cleans before upload/);

test("a file the cleaner declines is checked unchanged after cleaning is turned off elsewhere", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		const { file } = await openEdit(page, origin);
		const posts: string[] = [];
		page.on("request", (request) => {
			if (request.method() === "POST" && /\/image\/files\/[^/]+$/.test(request.url()))
				posts.push(request.url());
		});
		await file.setInputFiles(await vendorJpeg());
		await expect(file).toHaveAccessibleDescription(/unclassified or unreadable metadata/);
		expect(posts).toHaveLength(1);
		// Shown again with no change: nothing is prepared again.
		await shown(page);
		await page.waitForTimeout(300);
		expect(posts).toHaveLength(1);
		await changeElsewhere(page, origin, false);
		await shown(page);
		await expect(file).toHaveAccessibleDescription(/File checked · Not cleaned\./);
		expect(posts).toHaveLength(2);
	});
});

test("showing the tab with no change keeps an active Review and its consent", async ({ page }) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		const { file, inspect, consent, queue } = await openEdit(page, origin);
		await file.setInputFiles(await markedFile("png"));
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await inspect.press("Enter");
		await consent.press("Space");
		await expect(queue).toBeEnabled();
		await shown(page);
		await page.waitForTimeout(300);
		await expect(consent).toBeChecked();
		await expect(queue).toBeEnabled();
	});
});

test("a setting change after Review prepares the file again and clears consent", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, inspect, consent, queue, review } = await openEdit(page, origin);
		await file.setInputFiles(await markedFile("jpeg"));
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await inspect.press("Enter");
		await consent.press("Space");
		await changeElsewhere(page, origin, false);
		// Queue finds the Review stale, sends nothing and prepares the file under the new setting.
		await queue.press("Enter");
		await expect(file).toHaveAccessibleDescription(/File checked · Not cleaned\./);
		await expect(consent).toHaveCount(0);
		expect(fixtures.uploads).toHaveLength(0);
		await inspect.press("Enter");
		await expect(
			review.getByRole("list", { name: "Provider disclosure" }).getByText(/^Not cleaned\./),
		).toBeVisible();
	});
});

test("a lost Queue response keeps the request, and Retry sends exactly it again", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, inspect, consent, queue, review } = await openEdit(page, origin);
		await file.setInputFiles(await markedFile("png"));
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await inspect.press("Enter");
		await consent.press("Space");
		const bodies: string[] = [];
		let lost = true;
		await page.route("**/image/file-queue", async (route) => {
			bodies.push(route.request().postData() ?? "");
			const response = await route.fetch();
			if (lost) {
				lost = false;
				return route.abort();
			}
			return route.fulfill({ response });
		});
		await queue.press("Enter");
		await expect(review.getByRole("status")).toContainText("Queue confirmation is unavailable");
		await review.getByRole("button", { name: "Retry", exact: true }).press("Enter");
		await expect(page).toHaveURL(/\/jobs/);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		await expect(page.getByRole("article")).toHaveCount(1);
		await expect.poll(() => fixtures.uploads.length, { timeout: 20_000 }).toBe(1);
	});
});

test("a single WebP keeps the URL-only reason", async ({ page }) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		const { file, queue, inspect } = await openEdit(page, origin);
		const webp = await sharp({
			create: { width: 4, height: 4, channels: 3, background: "white" },
		})
			.webp()
			.toBuffer();
		await file.setInputFiles({ name: "photo.webp", mimeType: "image/webp", buffer: webp });
		await expect(queue).toHaveAccessibleDescription(/1–10 public image URLs/i);
		await expect(inspect).toHaveCount(0);
	});
});

test("a change elsewhere during preparation, then a refusal, describes the new mode", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin }) => {
		await changeElsewhere(page, origin, false);
		const { file } = await openEdit(page, origin);
		await expect(page.getByText(/Siluet checks and sends unchanged before upload/)).toBeVisible();
		const staging = await holdNextStaging(page);
		await file.setInputFiles({
			name: "cmyk.jpg",
			mimeType: "image/jpeg",
			buffer: await cmykJpeg(),
		});
		// Admitted with cleaning off; cleaning is turned on before its refusal arrives.
		await staging.arrived;
		await changeElsewhere(page, origin, true);
		await shown(page);
		await expect(cleanedHelp(page)).toBeVisible();
		staging.release();
		await expect(file).toHaveAccessibleDescription(/unsupported image coding/);
		await expect(cleanedHelp(page)).toBeVisible();
	});
});

test("a copy prepared again after a stale Queue shows the current mode while it prepares", async ({
	page,
}) => {
	await withEditStudio(page, "toapis", "completed", async ({ origin, fixtures }) => {
		const { file, inspect, consent, queue } = await openEdit(page, origin);
		await file.setInputFiles(await markedFile("png"));
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		await inspect.press("Enter");
		await consent.press("Space");
		await changeElsewhere(page, origin, false);
		const staging = await holdNextStaging(page);
		await queue.press("Enter");
		await staging.arrived;
		await expect(file).toHaveAccessibleDescription(
			/unchanged before upload\..* Checking the file…/,
		);
		staging.release();
		await expect(file).toHaveAccessibleDescription(/File checked · Not cleaned\./);
		expect(fixtures.uploads).toHaveLength(0);
	});
});
