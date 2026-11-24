import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { openInstallation } from "../../src/lib/server/db/installation";
import { localImageMarker, markedFile, rotatedJpeg } from "../fixtures/local-image";
import { editedPng } from "../fixtures/reference-edit";
import { prompt, providerPayload, withEditStudio } from "./edit-studio-fixture";

for (const provider of ["poyo", "toapis"] as const) {
	for (const [format, cleaning] of [
		["jpeg", true],
		["png", true],
		["jpeg", false],
		["png", false],
	] as const) {
		const mode = cleaning ? "cleaned" : "unchanged";
		test(`${provider} queues a local ${format} sent ${mode} and saves the edit automatically`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			await withEditStudio(
				page,
				provider,
				"completed",
				async ({ origin, fixtures, restart, assertPrivate, assertOneSubmission }) => {
					if (!cleaning) {
						const off = await page.request.post(`${origin}/settings/files`, {
							headers: { origin, accept: "text/html" },
							form: { expectedRevision: "0" },
						});
						expect(off.ok()).toBe(true);
					}
					const attached = await markedFile(format);
					const before = fixtures.requests.length;
					await page.goto(`${origin}/image`);
					await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
					await page.getByLabel("Operation", { exact: true }).selectOption("edit");
					const firstFile = page.getByLabel("Reference image 1", { exact: true });
					await firstFile.setInputFiles(attached);
					await expect(firstFile).toHaveAccessibleDescription(
						cleaning ? /Cleaned copy ready\./ : /File checked · Not cleaned\./,
					);
					const review = page.getByRole("region", { name: "Review request", exact: true });
					const localCopy = review.getByRole("region", { name: "Local copy", exact: true });
					await expect(
						localCopy.getByRole("img", { name: cleaning ? "Cleaned local copy" : "Attached file" }),
					).toBeVisible();
					await expect(localCopy.getByText("What survives cleanup")).toHaveCount(cleaning ? 1 : 0);
					await review.getByRole("button", { name: "Review request", exact: true }).press("Enter");
					const disclosure = review.getByRole("list", { name: "Provider disclosure" });
					await expect(disclosure).toContainText("Anyone with that link");
					await expect(disclosure.getByText(/^Not cleaned\./)).toHaveCount(cleaning ? 0 : 1);
					await review.getByRole("tab", { name: "Outgoing request" }).press("Enter");
					await expect(review.getByText(/Multipart file/)).toContainText(
						format === "png" ? "reference.png" : "reference.jpg",
					);
					await expect(review.getByText(/\[hosted upload URL\]/)).toBeVisible();
					await review.getByRole("tab", { name: "Review", exact: true }).press("Enter");
					await review.getByRole("checkbox", { name: /unknown total cost/ }).press("Space");
					// Preparation and Review make no provider calls.
					expect(fixtures.requests.length).toBe(before);
					await review.getByRole("button", { name: "Queue 1 request" }).press("Enter");
					await expect(page).toHaveURL(/\/jobs/);
					const job = page.getByRole("article");
					await expect(job.getByRole("link", { name: "Open saved image" })).toBeVisible({
						timeout: 30_000,
					});
					await expect(job.getByText(/Upload cost unknown/)).toBeVisible();

					expect(fixtures.uploads).toHaveLength(1);
					const [upload] = fixtures.uploads;
					expect(upload.parts).toEqual(["file"]);
					expect(upload.file.name).toBe(format === "png" ? "reference.png" : "reference.jpg");
					expect(upload.file.type).toBe(attached.mimeType);
					const sent = Buffer.from(await upload.file.arrayBuffer());
					if (cleaning) expect(sent.includes(Buffer.from(localImageMarker))).toBe(false);
					else expect(sent.equals(attached.buffer)).toBe(true);
					expect(fixtures.submissions).toEqual([providerPayload(provider, [fixtures.hosted])]);
					assertOneSubmission();
					await assertPrivate();

					const gallery = await job
						.getByRole("link", { name: "Open saved image" })
						.getAttribute("href");
					if (!gallery) throw new Error("Missing Gallery entry");
					// The rows keep only digest, size, type and mode: no names, metadata or links.
					await restart(async (directory) => {
						const db = await openInstallation(directory);
						try {
							const rows = JSON.stringify(
								await db.use((tx) => tx.all(sql`SELECT * FROM image_job`)),
							);
							expect(rows).not.toContain(localImageMarker);
							expect(rows).not.toContain("private-local-filename");
							expect(rows).not.toContain("fixture-upload-link");
						} finally {
							await db.close();
						}
					});
					const removed = await page.request.post(`${origin}/settings/providers?/remove`, {
						headers: { origin, accept: "text/html" },
						form: { provider },
					});
					expect(removed.ok()).toBe(true);
					const after = fixtures.requests.length;
					expect(await (await page.request.get(`${origin + gallery}/media`)).body()).toEqual(
						editedPng,
					);
					await page.goto(origin + gallery);
					await assertPrivate();
					expect(fixtures.requests.length).toBe(after);
				},
			);
		});
	}
}

for (const provider of ["poyo", "toapis"] as const) {
	test(`${provider} uploads exactly the previewed copy of a rotated JPEG and discloses its re-encode`, async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await withEditStudio(page, provider, "completed", async ({ origin, fixtures }) => {
			await page.goto(`${origin}/image`);
			await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
			await page.getByLabel("Operation", { exact: true }).selectOption("edit");
			const file = page.getByLabel("Reference image 1", { exact: true });
			await file.setInputFiles({
				name: "sideways.jpg",
				mimeType: "image/jpeg",
				buffer: await rotatedJpeg(),
			});
			await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
			const review = page.getByRole("region", { name: "Review request", exact: true });
			const localCopy = review.getByRole("region", { name: "Local copy", exact: true });
			await expect(localCopy).toContainText("Re-encoded to apply rotation.");
			const src = await localCopy
				.getByRole("img", { name: "Cleaned local copy" })
				.getAttribute("src");
			if (!src) throw new Error("Missing preview");
			const previewed = await (await page.request.get(origin + src)).body();
			const { width, height } = await sharp(previewed).metadata();
			expect([width, height]).toEqual([32, 48]);
			await review.getByRole("button", { name: "Review request", exact: true }).press("Enter");
			await review.getByRole("checkbox", { name: /unknown total cost/ }).press("Space");
			await review.getByRole("button", { name: "Queue 1 request" }).press("Enter");
			await expect(page).toHaveURL(/\/jobs/);
			await expect.poll(() => fixtures.uploads.length, { timeout: 20_000 }).toBe(1);
			const sent = Buffer.from(await fixtures.uploads[0].file.arrayBuffer());
			expect(sent.equals(previewed)).toBe(true);
			expect(sent.includes(Buffer.from(localImageMarker))).toBe(false);
		});
	});
}

test("Jobs warns about restaging only for uncertain or stored uploads", async ({ page }) => {
	await withEditStudio(page, "poyo", "completed", async ({ origin, restart, fixtures }) => {
		const rows = [
			["unsent", "rejected", false],
			["upload-rejected", "rejected", false],
			["upload-unknown", "unknown", true],
			["stored", "rejected", true],
			["edit-unknown", "unknown", true],
			["edit-recorded", "rejected", true],
		] as const;
		const requests = fixtures.requests.length;
		await restart(async (directory) => {
			const db = await openInstallation(directory);
			try {
				for (const [phase, state] of rows)
					await db.use((tx) =>
						tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,submission_recorded_at)
							VALUES(${phase},${phase},'poyo',1,'{"status":"unknown","reason":"missing-feed"}',${state},'seedream-5.5',0,120000,'prior',${phase},1)`),
					);
			} finally {
				await db.close();
			}
		});
		await page.goto(`${origin}/jobs`);
		for (const [phase, , warn] of rows) {
			const row = page.locator(`#job-${phase}`);
			await expect(row).toBeVisible();
			await expect(row.getByText(/An uploaded file may remain accessible/)).toHaveCount(
				Number(warn),
			);
		}
		expect(fixtures.requests.length).toBe(requests);
	});
});
