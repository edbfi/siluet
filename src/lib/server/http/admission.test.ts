import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import type { RequestEvent } from "@sveltejs/kit";
import type { ResolveOptions } from "@sveltejs/kit/hooks";
import { Glob } from "bun";
import { AccessError, recoverMessage } from "../services/owner/access-error";
import type { StudioRuntime } from "../services/owner/runtime";
import { admit, classify, pageRoutes, signedRoutes } from "./admission";

const routeId = (file: string) => {
	const dir = dirname(file);
	return dir === "." ? "/" : `/${dir}`;
};
const routes = (pattern: string) => [...new Glob(pattern).scanSync("src/routes")].map(routeId);

describe("the route tree", () => {
	test("the page set equals the +page.svelte routes", () => {
		expect([...pageRoutes].sort()).toEqual(routes("**/+page.svelte").sort());
	});
	test("no endpoint shares a page's directory, and every endpoint needs a bearer", () => {
		const endpoints = routes("**/+server.ts");
		for (const id of endpoints) {
			expect(pageRoutes.has(id)).toBe(false);
			if (id === "/healthz") continue;
			// Navigation-style GETs and HEADs to an endpoint are never public documents.
			expect(classify("GET", id, false)).toBe("private");
			expect(classify("HEAD", id, false)).toBe("private");
			if (!signedRoutes.has(id)) expect(classify("POST", id, false)).toBe("private");
		}
		for (const id of signedRoutes) expect(endpoints).toContain(id);
	});
	test("each request lands in one matrix row", () => {
		expect(classify("GET", "/gallery", false)).toBe("document");
		expect(classify("HEAD", "/settings/security", false)).toBe("document");
		expect(classify("GET", null, false)).toBe("document");
		expect(classify("GET", "/gallery", true)).toBe("private");
		expect(classify("GET", "/sign-in", true)).toBe("public-data");
		expect(classify("GET", "/setup", true)).toBe("public-data");
		expect(classify("POST", "/setup", false)).toBe("private");
		expect(classify("POST", "/settings/security", false)).toBe("private");
		expect(classify("GET", "/owner/resume", false)).toBe("private");
		expect(classify("POST", "/owner/resume", false)).toBe("signed");
		expect(classify("GET", "/owner/session", false)).toBe("private");
		expect(classify("GET", "/healthz", false)).toBe("health");
	});
});

const origin = new URL("http://127.0.0.1:4321");
const installationId = "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f";
function harness({
	claimed = true,
	session = null as { username: string } | null,
	failure = null as AccessError | null,
} = {}) {
	const calls: string[] = [];
	const studio = {
		origin,
		installationId,
		hasOwner: async () => claimed,
		async checkAccess() {
			calls.push("checkAccess");
			if (failure) throw failure;
		},
		access: {
			session: async (bearer: string | null) => {
				calls.push(`session:${bearer}`);
				return bearer === "live" ? session : null;
			},
			peek: async (bearer: string | null) => {
				calls.push(`peek:${bearer}`);
				return bearer === "live" ? session : null;
			},
		},
	} as unknown as StudioRuntime;
	async function request(
		method: string,
		id: string | null,
		{
			data = false,
			bearer,
			cookie,
			action = false,
		}: { data?: boolean; bearer?: string; cookie?: string; action?: boolean } = {},
	) {
		const headers = new Headers();
		if (bearer) headers.set("authorization", `Bearer ${bearer}`);
		if (cookie) headers.set("cookie", cookie);
		if (action) headers.set("x-sveltekit-action", "true");
		const event = {
			request: new Request(new URL(id ?? "/missing", origin), { method, headers }),
			route: { id },
			url: new URL(id ?? "/missing", origin),
			isDataRequest: data,
			locals: {},
		} as unknown as RequestEvent;
		let options: ResolveOptions | undefined;
		const response = await admit(
			event,
			(_event, resolved) => {
				options = resolved;
				const html = resolved?.transformPageChunk?.({
					html: '<meta name="siluet-installation" content="%siluet.installation%">',
					done: true,
				});
				return new Response((html as string | undefined) ?? "resolved", { status: 200 });
			},
			studio,
			{ "cache-control": "no-store" },
		);
		return { response, options, locals: event.locals };
	}
	return { request, calls };
}

describe("admit", () => {
	test("a document is a shell with the installation ID, COOP and legacy cookie deletions", async () => {
		const { request, calls } = harness();
		const { response, locals } = await request("GET", "/gallery", {
			cookie: `siluet_${installationId}=old; siluet_signout_4321=x; other=keep`,
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(`content="${installationId}"`);
		expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		expect(response.headers.getSetCookie()).toEqual([
			`siluet_${installationId}=; Path=/; Max-Age=0; SameSite=Lax`,
			"siluet_signout_4321=; Path=/; Max-Age=0; SameSite=Lax",
		]);
		// A document reads no session.
		expect(calls).toEqual(["checkAccess"]);
		expect(locals).toMatchObject({ session: null, owner: null });
		const missing = await request("GET", null);
		expect(await missing.response.text()).toContain(`content="${installationId}"`);
	});

	test("private requests without a live bearer get a no-store 401, never a redirect", async () => {
		const { request } = harness({ claimed: false });
		const before = await request("GET", "/gallery", { data: true });
		expect(before.response.status).toBe(401);
		expect(before.response.headers.get("www-authenticate")).toBe("Bearer");
		expect(before.response.headers.get("cache-control")).toBe("no-store");
		expect(await before.response.json()).toEqual({
			message: "Sign in to open the studio.",
			location: "/setup",
		});
		const after = harness();
		const dead = await after.request("GET", "/gallery/[jobId]/media", { bearer: "dead" });
		expect(dead.response.status).toBe(401);
		expect(dead.response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
		expect((await dead.response.json()).location).toBe("/sign-in");
		const action = await after.request("POST", "/gallery/[jobId]/remove", {
			bearer: "dead",
			action: true,
		});
		expect(await action.response.json()).toEqual({
			type: "redirect",
			status: 303,
			location: "/sign-in",
		});
	});

	test("a live bearer admits private work; the session read for /owner/session is read-only", async () => {
		const { request, calls } = harness({ session: { username: "owner" } });
		const ok = await request("GET", "/jobs", { data: true, bearer: "live" });
		expect(ok.response.status).toBe(200);
		expect(ok.locals).toMatchObject({ owner: "owner" });
		await request("GET", "/owner/session", { bearer: "live" });
		expect(calls).toContain("peek:live");
		expect(calls.filter((c) => c.startsWith("session:"))).toEqual(["session:live"]);
	});

	test("signed endpoints and health skip the hook's access and bearer checks", async () => {
		const { request, calls } = harness({ failure: new AccessError(recoverMessage, 503) });
		expect((await request("POST", "/owner/resume")).response.status).toBe(200);
		expect((await request("GET", "/healthz")).response.status).toBe(200);
		expect(calls).toEqual([]);
	});

	test("public data: /setup until claimed, /sign-in always; invalid bearers are ignored", async () => {
		const unclaimed = harness({ claimed: false });
		expect((await unclaimed.request("GET", "/setup", { data: true })).response.status).toBe(200);
		const claimed = harness();
		expect((await claimed.request("GET", "/setup", { data: true })).response.status).toBe(404);
		expect((await claimed.request("GET", "/setup")).response.status).toBe(404);
		const signIn = await claimed.request("GET", "/sign-in", { data: true, bearer: "dead" });
		expect(signIn.response.status).toBe(200);
		expect(signIn.locals).toMatchObject({ session: null });
	});

	test("access errors: a static page for documents, JSON for data, an error result for actions", async () => {
		const recovery = harness({ failure: new AccessError(recoverMessage, 503) });
		const page = await recovery.request("GET", "/settings/security");
		expect(page.response.headers.get("content-type")).toContain("text/html");
		expect(await page.response.text()).toContain(recoverMessage);
		const data = await recovery.request("GET", "/gallery", { data: true });
		expect(data.response.status).toBe(503);
		expect(await data.response.json()).toEqual({
			message: recoverMessage,
			retry: false,
			recoveryRequired: true,
		});
		const unavailable = harness({ failure: new AccessError("Retry.", 503) });
		const action = await unavailable.request("POST", "/settings/files", { action: true });
		expect(await action.response.json()).toEqual({
			type: "error",
			error: {
				message: "Authenticator storage is temporarily unavailable.",
				retry: true,
				recoveryRequired: false,
			},
		});
	});
});
