import { rm } from "node:fs/promises";
import { type APIResponse, expect } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { test } from "./studio-test";

function expectBaseline(response: APIResponse, label: string) {
	const headers = response.headers();
	expect(headers["x-frame-options"], label).toBe("DENY");
	expect(headers["x-content-type-options"], label).toBe("nosniff");
	expect(headers["referrer-policy"], label).toBe("same-origin");
	expect(headers["content-security-policy"], label).toContain("frame-ancestors 'none'");
	return headers["content-security-policy"];
}

const pagePolicy = [
	"default-src 'self'",
	"img-src 'self' data: blob:",
	"media-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"style-src-attr 'unsafe-inline'",
];

test("pages, endpoints, redirects and refusals send the frame, sniffing and referrer headers", async ({
	page,
	cspViolations,
}) => {
	const directory = await createOwnerDirectory();
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory);
		const { origin } = server.origin;
		const get = (path: string, headers?: Record<string, string>) =>
			page.request.get(origin + path, { headers, maxRedirects: 0 });

		const redirect = await get("/");
		expect(redirect.status()).toBe(303);
		expectBaseline(redirect, "redirect");
		const health = await get("/healthz");
		expect(await health.json()).toEqual({ status: "ok" });
		expect(expectBaseline(health, "/healthz")).toContain("default-src 'none'");
		const wrongHost = await get("/", { host: "localhost" });
		expect(wrongHost.status()).toBe(403);
		expectBaseline(wrongHost, "deny");
		const crossOrigin = await page.request.post(`${origin}/setup`, {
			headers: { origin: "http://localhost" },
			form: {},
		});
		// SvelteKit refuses a cross-site form before the hook runs, with a fixed message.
		expect(crossOrigin.status()).toBe(403);
		expect(await crossOrigin.text()).toBe("Cross-site POST form submissions are forbidden");
		const crossOriginJson = await page.request.post(`${origin}/image/review`, {
			headers: { origin: "http://localhost" },
			data: {},
		});
		expect(crossOriginJson.status()).toBe(403);
		expectBaseline(crossOriginJson, "deny cross-origin endpoint");

		// Pages carry SvelteKit's per-response nonce policy, with no inline script allowance.
		const setup = await get("/setup");
		expect(setup.status()).toBe(200);
		const policy = expectBaseline(setup, "/setup");
		for (const directive of pagePolicy) expect(policy).toContain(directive);
		expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
		expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
		expect(policy).not.toMatch(/style-src [^;]*unsafe-inline/);

		await expect.poll(server.token).not.toBe("");
		const claimed = await page.request.post(`${origin}/setup`, {
			headers: { origin, accept: "text/html" },
			form: { token: server.token(), username: "creator", password: crypto.randomUUID() },
			maxRedirects: 0,
		});
		expect(claimed.status()).toBe(303);
		expectBaseline(claimed, "form action redirect");
		for (const path of [
			"/",
			"/image",
			"/video",
			"/gallery",
			"/jobs",
			"/settings/providers",
			"/settings/security",
			"/settings/files",
		]) {
			const response = await get(path);
			expect(response.status(), path).toBe(200);
			expect(expectBaseline(response, path)).toMatch(/script-src 'self' 'nonce-/);
			// Each page renders and hydrates under the policy; studio-test fails on a violation.
			await page.goto(origin + path);
			await expect(page.locator("main").first()).toBeVisible();
		}
		const missing = await get("/missing-studio-route");
		expect(missing.status()).toBe(404);
		expectBaseline(missing, "404");
		const unknownMedia = await get(`/gallery/${crypto.randomUUID()}/media`);
		expect(unknownMedia.status()).toBe(404);
		expectBaseline(unknownMedia, "missing media");
		const endpoint = await page.request.post(`${origin}/image/review`, {
			headers: { origin },
			data: {},
		});
		expect(endpoint.status()).toBeGreaterThanOrEqual(400);
		expect(expectBaseline(endpoint, "endpoint")).toContain("default-src 'none'");

		// The browser refuses to frame a studio page, and reports that as the one violation.
		await page.setContent(`<iframe src="${origin}/gallery"></iframe>`);
		await expect.poll(() => cspViolations.length).toBe(1);
		expect(cspViolations.splice(0)[0]).toContain("frame-ancestors 'none'");
		expect(await page.frames()[1]?.locator("main").count()).toBe(0);

		// A plain form post still carries its Origin under the referrer policy.
		await page.goto(origin);
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page).toHaveURL(`${origin}/sign-in`);
	} finally {
		await server?.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
