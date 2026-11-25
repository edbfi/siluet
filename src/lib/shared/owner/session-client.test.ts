import { expect, test } from "bun:test";
import { toBase64Url } from "./key-message";
import type { BrowserKey } from "./key-store";
import { createSessionClient } from "./session-client";

// Unread-codes and Security settlement rules, against a fake studio.
const origin = "http://127.0.0.1:4000";
const page = { href: `${origin}/settings/security?offer`, pathname: "/settings/security" };
Object.assign(globalThis, {
	location: {
		origin,
		get href() {
			return page.href;
		},
		get pathname() {
			return page.pathname;
		},
	},
	document: { visibilityState: "visible" },
	localStorage: { setItem() {}, getItem: () => null },
});
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
	"sign",
	"verify",
]);
const key: BrowserKey = {
	key: pair.privateKey,
	spki: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
};

function harness() {
	const resumes: { status: number; body?: unknown }[] = [];
	const navigations: string[] = [];
	const native = (async (input: RequestInfo | URL) => {
		const path = new URL(String(input), origin).pathname;
		const answer =
			path === "/owner/challenge"
				? { status: 200, body: { nonce: "n" } }
				: path === "/owner/resume"
					? (resumes.shift() ?? { status: 500 })
					: { status: 200, body: {} };
		return new Response(JSON.stringify(answer.body ?? null), { status: answer.status });
	}) as typeof fetch;
	const client = createSessionClient(
		"7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f",
		native,
		{
			assign: (url) => navigations.push(`assign ${url}`),
			reload: () => navigations.push("reload"),
			replace: (url) => navigations.push(`replace ${url}`),
		},
		{ read: async () => key, ensure: async () => key },
	);
	const states: unknown[] = [];
	client.subscribe((state) => states.push(state));
	const session = (sessionId: string, loginId = "login-1") => ({
		status: 200,
		body: { bearer: `bearer-${sessionId}`, sessionId, loginId },
	});
	return { client, resumes, navigations, states, session };
}
async function bound(h: ReturnType<typeof harness>, sessionId = "s1") {
	h.resumes.push(h.session(sessionId));
	await h.client.classify(await h.client.renew());
}

test("a lone Security change adopts, keeps the codes until Done, then continues the offer", async () => {
	const h = harness();
	await bound(h);
	h.client.beginSecurity();
	h.client.stashSecurityBearer("successor");
	expect(h.client.settleSecurity({ sessionId: "s2", codes: ["a", "b"] }, true, page.href)).toBe(
		true,
	);
	expect(h.client.bound()).toEqual({ sessionId: "s2", loginId: "login-1" });
	expect(h.client.remountKey).toBe(1);
	expect(h.states.at(-1)).toMatchObject({ codes: { codes: ["a", "b"], notice: null } });
	expect(h.client.done()).toBe("/settings/files?offer");
	expect(h.navigations).toEqual([]);
	// Without the offer, or after the URL moved, Done stays.
	h.client.beginSecurity();
	h.client.stashSecurityBearer("third");
	h.client.settleSecurity({ sessionId: "s3", codes: ["c"] }, true, page.href);
	page.href = `${origin}/jobs`;
	expect(h.client.done()).toBeNull();
	page.href = `${origin}/settings/security?offer`;
});

test("a check meeting another session while Security is pending waits, then the latest result applies", async () => {
	const h = harness();
	await bound(h);
	h.client.beginSecurity();
	h.resumes.push(h.session("other", "login-2"));
	const check = h.client.check();
	await Bun.sleep(5);
	expect(h.navigations).toEqual([]);
	h.client.stashSecurityBearer("successor");
	// The waited result names another session: no adoption, the codes are held for Done.
	expect(h.client.settleSecurity({ sessionId: "s2", codes: ["a"] }, true, page.href)).toBe(false);
	await check;
	expect(h.states.at(-1)).toMatchObject({ codes: { notice: "changed" } });
	expect(h.client.mode).toBe("held");
	h.client.done();
	expect(h.navigations).toEqual([`replace ${origin}/settings/security`]);
});

test("rows while codes are shown: a later change marks them replaced, sign-out adds the caveat", async () => {
	for (const [answer, notice, destination] of [
		[
			{ status: 200, body: { bearer: "b", sessionId: "s9", loginId: "login-1" } },
			"replaced",
			"/settings/security",
		],
		[{ status: 401, body: { message: "Gone", location: "/sign-in" } }, "signed-out", "/sign-in"],
	] as const) {
		const h = harness();
		await bound(h);
		h.client.beginSecurity();
		h.client.stashSecurityBearer("successor");
		h.client.settleSecurity({ sessionId: "s2", codes: ["a"] }, true, page.href);
		h.resumes.push(answer);
		await h.client.check();
		expect(h.states.at(-1)).toMatchObject({ codes: { notice } });
		expect(h.navigations).toEqual([]);
		h.client.done();
		expect(h.navigations).toEqual([`replace ${origin}${destination}`]);
	}
});

test("a response after the owner left installs nothing; pagehide and pageshow load a destination once", async () => {
	const h = harness();
	await bound(h);
	h.client.beginSecurity();
	h.client.stashSecurityBearer("successor");
	h.resumes.push(h.session("s2"));
	expect(h.client.settleSecurity({ sessionId: "s2", codes: ["a"] }, false, page.href)).toBe(false);
	expect(h.states.at(-1)).toMatchObject({ codes: null });
	expect(h.client.liveBearer()).not.toBe("successor");
	h.client.registerDestination("/settings/security?offer");
	h.client.pagehide();
	h.client.pageshow(true);
	h.client.pageshow(true);
	expect(h.navigations.filter((n) => n.startsWith("replace") || n === "reload")).toHaveLength(1);
});
