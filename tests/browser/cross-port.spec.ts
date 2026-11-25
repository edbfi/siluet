import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect } from "@playwright/test";
import { installationMigrations } from "../../src/lib/server/db/migrations";
import { releasedMigrations } from "../../src/lib/server/db/released-migrations";
import { createInstallation37 } from "../fixtures/db/installation-37";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest, signedInPage } from "./owner-session";
import { test } from "./studio-test";

/** Another web service on the same loopback host: a page Siluet's owner might visit. */
function hostilePort(hostname: string) {
	const seen: Record<string, string>[] = [];
	const server = Bun.serve({
		hostname,
		port: 0,
		fetch(request) {
			seen.push(Object.fromEntries(request.headers));
			return new Response("<!doctype html><title>Q</title><p>Another local service</p>", {
				headers: { "content-type": "text/html" },
			});
		},
	});
	const host = hostname === "::1" ? "[::1]" : hostname;
	return { origin: `http://${host}:${server.port}`, seen, stop: () => server.stop(true) };
}

for (const host of ["127.0.0.1", "::1"] as const) {
	test(`another loopback port on ${host} gets and replays nothing`, async ({ browser }) => {
		test.setTimeout(90000);
		const directory = await createOwnerDirectory();
		const server = await startStudio(directory, "0", false, { SILUET_SERVER_HOST: host });
		const q = hostilePort(host);
		const context = await browser.newContext();
		try {
			const origin = server.origin.origin;
			const page = await context.newPage();
			const resumes: string[] = [];
			await page.route("**/owner/resume", async (route) => {
				resumes.push(route.request().postData() ?? "");
				await route.continue();
			});
			const password = crypto.randomUUID();
			await claimOwner(page, server, password);
			// Positive control: P's own tab reads private data and its saved settings.
			await page.goto(`${origin}/settings/files`);
			await expect(
				page.getByRole("switch", { name: "Remove metadata before upload" }),
			).toBeVisible();
			const sibling = await context.newPage();
			await sibling.goto(`${origin}/jobs`);
			await expect(sibling.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
			const installation = await page.evaluate(() =>
				document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content"),
			);
			const bearer = (await signedInPage(page, "resume", "/owner/resume", {}, "key")).body.bearer;

			// Q, in the same browser, sees no cookie, key, storage or notice of P.
			const visitor = await context.newPage();
			await visitor.goto(q.origin);
			const view = await visitor.evaluate(async (name) => {
				const heard: unknown[] = [];
				const channel = new BroadcastChannel(name);
				channel.onmessage = (event) => heard.push(event.data);
				(globalThis as unknown as { heard: unknown[] }).heard = heard;
				const databases = (await indexedDB.databases?.()) ?? [];
				return {
					cookie: document.cookie,
					storage: localStorage.length,
					databases: databases.map((d) => d.name),
				};
			}, `siluet-owner-${installation}`);
			expect(view).toEqual({ cookie: "", storage: 0, databases: [] });
			// A real session change in P reaches P's other tab, never Q.
			await page.goto(origin);
			await page.getByRole("button", { name: "Sign out" }).click();
			await expect(sibling).toHaveURL(`${origin}/sign-in`);
			expect(
				await visitor.evaluate(() => (globalThis as unknown as { heard: unknown[] }).heard),
			).toEqual([]);

			// Q's fetches, media and POSTs get nothing from P.
			const attempts = await visitor.evaluate(async (p) => {
				const outcome = async (request: Promise<Response>) =>
					request.then(
						(r) => r.type,
						(e: Error) => e.name,
					);
				const image = await new Promise((resolve) => {
					const element = new Image();
					element.onload = () => resolve("loaded");
					element.onerror = () => resolve("error");
					element.src = `${p}/gallery/${crypto.randomUUID()}/media`;
				});
				return {
					data: await outcome(fetch(`${p}/jobs/__data.json`, { credentials: "include" })),
					challenge: await outcome(
						fetch(`${p}/owner/challenge`, {
							method: "POST",
							credentials: "include",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ purpose: "resume" }),
						}),
					),
					image,
				};
			}, origin);
			expect(attempts).toEqual({ data: "TypeError", challenge: "TypeError", image: "error" });
			for (const headers of q.seen) {
				expect(headers.cookie).toBeUndefined();
				expect(headers.authorization).toBeUndefined();
			}
			// The server refuses each of those on its own, not only the browser.
			const raw = (path: string, init: RequestInit = {}) =>
				fetch(origin + path, { ...init, headers: { origin: q.origin, ...init.headers } });
			for (const path of ["/owner/challenge", "/owner/sign-out", "/image/queue"])
				expect((await raw(path, { method: "POST", body: "{}" })).status).toBe(403);
			expect((await fetch(`${origin}/jobs/__data.json`)).status).toBe(401);
			// Replays: a spent resume and a signed-out bearer both fail.
			expect(resumes.length).toBeGreaterThan(0);
			const replay = await fetch(`${origin}/owner/resume`, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: resumes[0],
			});
			expect(replay.status).toBe(403);
			const stale = await fetch(`${origin}/jobs/__data.json`, {
				headers: { authorization: `Bearer ${bearer}` },
			});
			expect(stale.status).toBe(401);
			expect(stale.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
		} finally {
			await context.close();
			q.stop();
			await server.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("the upgrade revokes cookie sessions, expires legacy cookies and keeps the studio", async ({
	page,
	context,
}) => {
	test.setTimeout(60000);
	const directory = await createOwnerDirectory();
	// The migrations of a507bde, the last release with cookie sessions.
	const released = Object.fromEntries(
		Object.entries(installationMigrations).filter(
			([name]) => releasedMigrations.has(name) && name < "20261127120000_browser_key_sessions",
		),
	);
	const token = "legacy-cookie-session-token-that-leaked-to-another-port0";
	const { id, password } = await createInstallation37(
		directory,
		async (db) => {
			const { sql } = await import("drizzle-orm");
			const digest = createHash("sha256").update(token).digest("hex");
			await db.run(sql`INSERT INTO session VALUES (${digest}, 1, ${Date.now()}, ${Date.now()})`);
		},
		undefined,
		released,
	);
	const server = await startStudio(directory);
	try {
		const origin = server.origin.origin;
		const hex = "a".repeat(64);
		await context.addCookies(
			[
				[`siluet_${id}`, token, "/"],
				[`siluet_signout_${server.origin.port}`, "x", "/"],
				[`siluet_${id}_pending_${hex}`, "proof", "/sign-in"],
				["unrelated", "keep", "/"],
			].map(([name, value, path]) => ({ name, value, path, domain: "127.0.0.1" })),
		);
		// The old cookie authenticates nothing.
		const refused = await page.request.get(`${origin}/jobs/__data.json`);
		expect(refused.status()).toBe(401);
		await page.goto(`${origin}/jobs`);
		await expect(page).toHaveURL(`${origin}/sign-in`);
		const names = (await context.cookies()).map((cookie) => cookie.name);
		expect(names).toEqual(["unrelated"]);
		await page.getByLabel("Username").fill("creator");
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
		await page.goto(`${origin}/gallery`);
		await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible();
		expect((await ownerRequest(page).get(`${origin}/jobs/__data.json`)).status()).toBe(200);
	} finally {
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
