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

type Answer = { status: number; body?: unknown };
function harness() {
	const resumes: (Answer | Promise<Answer>)[] = [];
	/** Answers to `GET /owner/session`; without one it finds no session ID. */
	const checks: Promise<Answer>[] = [];
	const navigations: string[] = [];
	const requests: string[] = [];
	const native = (async (input: RequestInfo | URL) => {
		const path = new URL(String(input), origin).pathname;
		requests.push(path);
		const answer = await (path === "/owner/challenge"
			? { status: 200, body: { nonce: "n" } }
			: path === "/owner/resume"
				? (resumes.shift() ?? { status: 500 })
				: path === "/owner/session"
					? (checks.shift() ?? { status: 200, body: {} })
					: { status: 200, body: {} });
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
	return { client, resumes, checks, navigations, requests, states, session };
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

test("a back/forward-cache restore with a destination loads it and checks nothing; without one it checks", async () => {
	const h = harness();
	await bound(h);
	h.client.registerDestination("/settings/security");
	h.client.pagehide();
	h.requests.length = 0;
	h.client.pageshow(true);
	await Bun.sleep(5);
	expect(h.navigations).toEqual([`replace ${origin}/settings/security`]);
	expect(h.requests).toEqual([]);
	// The control: a restore with nothing pending revalidates the session.
	const plain = harness();
	await bound(plain);
	plain.requests.length = 0;
	plain.client.pageshow(true);
	await Bun.sleep(5);
	expect(plain.navigations).toEqual([]);
	expect(plain.requests).toContain("/owner/session");
});

test("a tab restored after leaving for another session reloads, and no check runs while it loads", async () => {
	const h = harness();
	await bound(h);
	h.resumes.push(h.session("s2"));
	await h.client.check();
	expect(h.navigations).toEqual(["reload"]);
	h.requests.length = 0;
	await h.client.check();
	expect(h.requests).toEqual([]);
	// Back restores this document from the cache: it is still on a session it left.
	h.client.pagehide();
	h.client.pageshow(true);
	expect(h.navigations).toEqual(["reload", "reload"]);
	// Done's own load also stops checks while the next document loads.
	const done = harness();
	await bound(done);
	done.client.beginSecurity();
	done.client.stashSecurityBearer("successor");
	done.client.settleSecurity({ sessionId: "s2", codes: ["a"] }, true, page.href);
	done.client.registerDestination("/settings/security");
	done.client.done();
	done.requests.length = 0;
	await done.client.check();
	expect(done.requests).toEqual([]);
});

test("a check answered for the session the tab just left by its own Security change is dropped", async () => {
	for (const via of ["session", "resume"] as const) {
		const h = harness();
		await bound(h);
		const answer = Promise.withResolvers<Answer>();
		if (via === "session") h.checks.push(answer.promise);
		else {
			// Without a live bearer the check renews instead.
			h.client.refused("bearer-s1");
			h.resumes.push(answer.promise);
		}
		const check = h.client.check();
		await Bun.sleep(5);
		h.client.beginSecurity();
		h.client.stashSecurityBearer("successor");
		h.client.settleSecurity({ sessionId: "s2", codes: ["a"] }, true, page.href);
		// The server answered before the change committed.
		answer.resolve(
			via === "session"
				? { status: 200, body: { sessionId: "s1", loginId: "login-1" } }
				: h.session("s1"),
		);
		h.checks.push(Promise.resolve({ status: 200, body: { sessionId: "s2", loginId: "login-1" } }));
		await check;
		expect(h.states.at(-1)).toMatchObject({ codes: { codes: ["a"], notice: null } });
		expect(h.client.mode).toBe("bound");
		expect(h.client.bound()?.sessionId).toBe("s2");
		expect(h.navigations).toEqual([]);
	}
});

test("a check queued behind one that starts a document load sends nothing more", async () => {
	const h = harness();
	await bound(h);
	const answer = Promise.withResolvers<Answer>();
	h.checks.push(answer.promise);
	const first = h.client.check();
	void h.client.check();
	await Bun.sleep(1);
	answer.resolve({ status: 200, body: { sessionId: "s2", loginId: "login-2" } });
	await first;
	expect(h.navigations).toEqual(["reload"]);
	expect(h.requests.filter((path) => path === "/owner/challenge")).toHaveLength(1);
});

test("an access error answered after a Security adoption drops nothing and asks again", async () => {
	const h = harness();
	await bound(h);
	const answer = Promise.withResolvers<Answer>();
	h.checks.push(answer.promise);
	const check = h.client.check();
	await Bun.sleep(1);
	h.client.beginSecurity();
	h.client.stashSecurityBearer("successor");
	h.client.settleSecurity({ sessionId: "s2", codes: [] }, true, page.href);
	expect(h.client.remountKey).toBe(1);
	answer.resolve({
		status: 503,
		body: { message: "Recover the host first.", retry: false, recoveryRequired: true },
	});
	h.checks.push(Promise.resolve({ status: 200, body: { sessionId: "s2", loginId: "login-1" } }));
	await check;
	expect(h.client.remountKey).toBe(1);
	expect(h.requests.filter((path) => path === "/owner/session")).toHaveLength(2);
});
