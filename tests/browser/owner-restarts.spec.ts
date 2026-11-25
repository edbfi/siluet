import { rm } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { claimOwner } from "./owner-session";
import { test } from "./studio-test";

/** Statuses of this page's session renewals and data loads, in order. */
function watch(page: Page) {
	const seen: string[] = [];
	page.on("response", (response) => {
		const path = new URL(response.url()).pathname;
		if (path === "/owner/resume" || path.endsWith("/__data.json"))
			seen.push(`${path} ${response.status()}`);
	});
	return seen;
}

test("restarts between challenge, resume and resend recover as the session table says", async ({
	page,
}) => {
	test.setTimeout(90000);
	const directory = await createOwnerDirectory();
	let server = await startStudio(directory);
	const origin = server.origin.origin;
	// Sessions persist; challenges and bearers live in memory and are lost.
	const restart = async () => {
		const port = server.origin.port;
		await server.stop();
		server = await startStudio(directory, port);
	};
	try {
		await claimOwner(page, server, crypto.randomUUID());
		const seen = watch(page);
		const heading = (name: string) => page.getByRole("heading", { name, exact: true });

		// Between challenge and resume: the resume's nonce is gone (403); the tab takes a fresh
		// challenge and resumes once.
		let first = true;
		await page.route("**/owner/challenge", async (route) => {
			if (!first) return route.fallback();
			first = false;
			const response = await route.fetch();
			await restart();
			await route.fulfill({ response });
		});
		await page.goto(`${origin}/jobs`);
		await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
		await page.unroute("**/owner/challenge");
		expect(seen.filter((entry) => entry.startsWith("/owner/resume"))).toEqual([
			"/owner/resume 403",
			"/owner/resume 200",
		]);

		// Between resume and the next request: the hook refuses the lost bearer, and the request
		// is resent once with a renewed one.
		seen.length = 0;
		await restart();
		await page.getByRole("link", { name: "Gallery" }).first().click();
		await expect(heading("Gallery")).toBeVisible();
		expect(seen).toEqual([
			"/gallery/__data.json 401",
			"/owner/resume 200",
			"/gallery/__data.json 200",
		]);

		// Between the renewal and its resend: the resend meets a second refusal and fails with a
		// TypeError, which the navigation shows as the error page. The tab stays bound: its next
		// request renews and goes through, without a sign-in.
		seen.length = 0;
		await restart();
		first = true;
		await page.route("**/owner/resume", async (route) => {
			if (!first) return route.fallback();
			first = false;
			const response = await route.fetch();
			await restart();
			await route.fulfill({ response });
		});
		await page.getByRole("link", { name: "Jobs" }).first().click();
		await expect(page.getByRole("alert")).toHaveText("Internal Error");
		expect(seen).toEqual(["/jobs/__data.json 401", "/owner/resume 200", "/jobs/__data.json 401"]);
		seen.length = 0;
		await page.getByRole("link", { name: "Open the studio" }).click();
		await expect(heading("Studio home")).toBeVisible();
		await expect(page).toHaveURL(`${origin}/`);
		expect(seen).toEqual(["/__data.json 401", "/owner/resume 200", "/__data.json 200"]);
	} finally {
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
