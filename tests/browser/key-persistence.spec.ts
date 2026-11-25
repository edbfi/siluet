import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { claimOwner } from "./owner-session";
import { test } from "./studio-test";

test("the browser key survives a reload, a browser relaunch and a Siluet restart", async ({
	browserName,
	playwright,
}) => {
	test.setTimeout(90000);
	const directory = await createOwnerDirectory();
	const profile = await mkdtemp(join(tmpdir(), "siluet-key-profile-"));
	let server = await startStudio(directory);
	const launch = () => playwright[browserName].launchPersistentContext(profile);
	try {
		const origin = server.origin.origin;
		let context = await launch();
		let page = context.pages()[0] ?? (await context.newPage());
		await claimOwner(page, server, crypto.randomUUID(), "owner");
		await page.goto(`${origin}/jobs`);
		await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
		await page.reload();
		await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
		await context.close();
		const port = server.origin.port;
		await server.stop();
		server = await startStudio(directory, port);
		context = await launch();
		page = context.pages()[0] ?? (await context.newPage());
		await page.goto(`${origin}/jobs`);
		await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
		expect(await context.cookies()).toEqual([]);
		await context.close();
	} finally {
		await server.stop();
		await rm(profile, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
