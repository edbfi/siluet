import { expect } from "@playwright/test";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { openInstallation } from "../../src/lib/server/db/installation";
import { localImageMarker, markedFile, rotatedJpeg } from "../fixtures/local-image";
import { editedPng } from "../fixtures/reference-edit";
import { prompt, providerPayload, withEditStudio } from "./edit-studio-fixture";
import { ownerRequest } from "./owner-session";
import { test } from "./studio-test";

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
						const off = await ownerRequest(page).post(`${origin}/settings/files`, {
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
					const consent = review.getByRole("checkbox", { name: /unknown total cost/ });
					await expect(consent).toHaveAccessibleName(
						"I accept the unknown total cost of the upload and edit, the provider access and retention terms above, and that the uploaded copy may stay accessible even if the edit never runs.",
					);
					await consent.press("Space");
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
					const removed = await ownerRequest(page).post(`${origin}/settings/providers?/remove`, {
						headers: { origin, accept: "text/html" },
						form: { provider },
					});
					expect(removed.ok()).toBe(true);
					const after = fixtures.requests.length;
					expect(await (await ownerRequest(page).get(`${origin + gallery}/media`)).body()).toEqual(
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
				.getAttribute("data-source");
			if (!src) throw new Error("Missing preview");
			const previewed = await (await ownerRequest(page).get(origin + src)).body();
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

test("Jobs reports each file slot, its stop and the hosted-copy warning", async ({ page }) => {
	await withEditStudio(page, "poyo", "completed", async ({ origin, restart, fixtures }) => {
		// Single-slot rows as the R2 migration leaves R1b jobs, then a three-file job.
		const rows = [
			["unsent", "rejected", "unsent", false],
			["upload-rejected", "rejected", "rejected", false],
			["upload-unknown", "unknown", "unknown", true],
			["stored", "rejected", "stored", true],
			["edit-unknown", "unknown", "stored", true],
			["edit-recorded", "rejected", "stored", true],
		] as const;
		const requests = fixtures.requests.length;
		await restart(async (directory) => {
			const db = await openInstallation(directory);
			try {
				for (const [phase, state] of rows)
					await db.use((tx) =>
						tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,submission_recorded_at,file_references)
							VALUES(${phase},${phase},'poyo',1,'{"status":"unknown","reason":"missing-feed"}',${state},'seedream-5.5',0,120000,'prior',${phase},1,1)`),
					);
				for (const [phase, , outcome] of rows)
					await db.use((tx) => tx.run(sql`INSERT INTO file_slot VALUES(${phase},1,${outcome})`));
				await db.use((tx) =>
					tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,submission_recorded_at,file_references,file_stop,file_stop_slot,file_other_slot,retry_at)
						VALUES('ordered','ordered','poyo',1,'{"status":"unknown","reason":"missing-feed"}','rejected','seedream-5.5',0,120000,'prior','stored',1,4,'duplicate',3,2,NULL),
						('cooldown','cooldown','poyo',1,'{"status":"unknown","reason":"missing-feed"}','rejected','seedream-5.5',0,120000,'prior','unsent',1,1,'cooldown',1,NULL,${Date.parse("2026-11-24T10:00:00Z")})`),
				);
				await db.use((tx) =>
					tx.run(
						sql`INSERT INTO file_slot VALUES('ordered',1,'stored'),('ordered',3,'stored'),('ordered',4,'unsent'),('cooldown',1,'unsent')`,
					),
				);
				// An acknowledged edit whose task later failed.
				await db.use((tx) =>
					tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,submission_recorded_at,file_references,task_id)
						VALUES('acknowledged','acknowledged','poyo',1,'{"status":"unknown","reason":"missing-feed"}','failed','seedream-5.5',0,120001,'prior','edit-recorded',1,2,'task-acknowledged')`),
				);
				await db.use((tx) =>
					tx.run(
						sql`INSERT INTO file_slot VALUES('acknowledged',1,'stored'),('acknowledged',2,'stored')`,
					),
				);
			} finally {
				await db.close();
			}
		});
		await page.goto(`${origin}/jobs`);
		for (const [phase, , , warn] of rows) {
			const row = page.locator(`#job-${phase}`);
			await expect(row).toBeVisible();
			await expect(row.getByText(/An uploaded file may remain accessible/)).toHaveCount(
				Number(warn),
			);
		}
		const ordered = page.locator("#job-ordered");
		await expect(ordered.getByText("4 references · 3 files")).toBeVisible();
		await expect(
			ordered.getByRole("list", { name: "File uploads" }).getByRole("listitem"),
		).toHaveText([
			"Reference 1 · File uploaded",
			"Reference 3 · File uploaded",
			"Reference 4 · Not sent",
		]);
		await expect(
			ordered.getByText(
				"The upload for reference 3 returned the same link as reference 2, so the edit was not sent.",
			),
		).toBeVisible();
		await expect(ordered.getByText(/An uploaded file may remain accessible/)).toBeVisible();
		const cooldown = page.locator("#job-cooldown");
		await expect(
			cooldown.getByText(
				"Provider cooldown until 2026-11-24T10:00:00.000Z. Review again before queuing.",
			),
		).toBeVisible();
		await expect(cooldown.getByText(/An uploaded file may remain accessible/)).toHaveCount(0);
		const acknowledged = page.locator("#job-acknowledged");
		await expect(acknowledged.getByText(/Task task-acknowledged/)).toBeVisible();
		await expect(acknowledged.getByText(/An uploaded file may remain accessible/)).toBeVisible();
		expect(fixtures.requests.length).toBe(requests);
	});
});
