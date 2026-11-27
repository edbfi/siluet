import { rm } from "node:fs/promises";
import { type BrowserContext, expect, type Page, type Route } from "@playwright/test";
import { TOTP } from "otpauth";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { claimOwner, keepKey, ownerRequest, signedInPage, signInOwner } from "./owner-session";
import { test as base } from "./studio-test";

// Key rotation at claim and sign-in ([browser key sessions](../../docs/SPEC-browser-key.md)).
type Studio = Awaited<ReturnType<typeof startStudio>>;
const test = base.extend<{ studio: { server: Studio; origin: string; password: string } }>({
	studio: async ({ page }, use) => {
		const directory = await createOwnerDirectory();
		const server = await startStudio(directory);
		try {
			const password = crypto.randomUUID();
			await claimOwner(page, server, password, "owner");
			await use({ server, origin: server.origin.origin, password });
		} finally {
			await server.stop();
			await rm(directory, { recursive: true, force: true });
		}
	},
});

/**
 * Fires `focus` on a bound tab. The commit notice may already have had the tab check and load
 * the new session, which destroys the page's context mid-call; only that is tolerated.
 */
const focusBoundTab = (page: Page) =>
	page
		.evaluate(() => dispatchEvent(new Event("focus")))
		.catch((error: Error) => {
			if (!error.message.includes("Execution context was destroyed")) throw error;
		});

/** The SPKI of this origin's stored browser key, or null. */
const storedSpki = (page: Page) =>
	page.evaluate(async () => {
		const installation =
			document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content") ?? "";
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("siluet-owner", 1);
			request.onupgradeneeded = () => request.result.createObjectStore("keys");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const record = await new Promise<{ spki?: string } | undefined>((resolve, reject) => {
			const request = db.transaction("keys").objectStore("keys").get(installation);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		db.close();
		return record?.spki ?? null;
	});
/** The kept pre-rotation key's `resume` status. */
const keptResume = async (page: Page) =>
	(await signedInPage(page, "resume", "/owner/resume", {}, "key", true)).status;
const sessionOf = async (page: Page, origin: string) =>
	(await (await ownerRequest(page).get(`${origin}/owner/session`)).json()).sessionId as string;
const liveSession = async (page: Page, origin: string, bearer: string) => {
	const response = await page.request.get(`${origin}/owner/session`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
	return response.ok() ? ((await response.json()).sessionId as string) : response.status();
};
/** Owner request bodies this page sent, by endpoint. */
function ownerBodies(page: Page) {
	const sent: { path: string; body: Record<string, unknown> }[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (request.method() === "POST" && /^\/owner\/(?!challenge)/.test(path))
			sent.push({ path, body: request.postDataJSON() });
	});
	return (path: string) => sent.filter((request) => request.path === path).map((r) => r.body);
}
/** The sessions this page's claim, sign-in and factor answers issued. */
function issuedTo(page: Page) {
	const bearers: { bearer: string; sessionId: string }[] = [];
	page.on("response", async (response) => {
		if (!/\/owner\/(claim|sign-in|factor)$/.test(response.url())) return;
		const body = await response.json().catch(() => null);
		if (typeof body?.bearer === "string") bearers.push(body);
	});
	return bearers;
}
async function fillSignIn(page: Page, password: string) {
	await page.getByLabel("Username").fill("owner");
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
}
async function signOut(page: Page, origin: string) {
	await page.goto(origin);
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page).toHaveURL(`${origin}/sign-in`);
}
/** Turn on two-step sign-in from Security; returns its seed and recovery codes. */
async function enableFactor(page: Page, origin: string, password: string) {
	await page.goto(`${origin}/settings/security`);
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	const seed = (await page.locator("section code").first().textContent()) ?? "";
	await page.getByLabel("New authenticator code").fill(new TOTP({ secret: seed }).generate());
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	const codes = await dialog.locator("li").allTextContents();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).toHaveCount(0);
	return { seed, codes: codes.map((code) => code.trim()) };
}
/** Let the server answer, then lose the answer on its way to the page. */
const loseAnswer = async (route: Route) => {
	await route.fetch();
	await route.abort("failed");
};
/** Hold the answer once the server has committed; resolves `answered` with its body. */
function holdAnswer(release: Promise<void>) {
	const answered = Promise.withResolvers<Record<string, unknown>>();
	const handler = async (route: Route) => {
		const response = await route.fetch();
		answered.resolve(await response.json());
		await release;
		await route.fulfill({ response }).catch(() => {});
	};
	return { handler, answered: answered.promise };
}
/** Show the sign-in form in a tab of a signed-in browser: its first resume is lost. */
async function signInFormWhileSignedIn(context: BrowserContext, origin: string) {
	const page = await context.newPage();
	await page.route("**/owner/resume", (route) => route.abort("failed"));
	await page.goto(`${origin}/sign-in`);
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
	await page.unroute("**/owner/resume");
	return page;
}
const restarted = "Sign-in restarted. Enter your username and password again.";

test("claim and sign-in, with and without the factor step, store a new key that cuts off the old one", async ({
	page,
	browser,
	studio,
}) => {
	test.setTimeout(120000);
	const { origin, password } = studio;
	const bodies = ownerBodies(page);
	await page.goto(`${origin}/jobs`);
	const claimed = await storedSpki(page);
	expect(claimed).not.toBeNull();
	// A signed-in sign-in rotates too: the old key loses its session.
	await keepKey(page);
	await signInOwner(page, origin, password, "owner");
	expect(await storedSpki(page)).not.toBe(claimed);
	expect(await keptResume(page)).toBe(401);
	// Sign-out then sign-in through the form leaves the old key nothing.
	await signOut(page, origin);
	await keepKey(page);
	const signedOut = await storedSpki(page);
	await fillSignIn(page, password);
	await expect(page).toHaveURL(`${origin}/`);
	const rotated = await storedSpki(page);
	expect(rotated).not.toBe(signedOut);
	expect(bodies("/owner/sign-in").at(-1)).toMatchObject({
		key: rotated,
		replaces: { key: signedOut },
	});
	expect(await keptResume(page)).toBe(401);
	// A Security change keeps the key.
	const { codes } = await enableFactor(page, origin, password);
	expect(await storedSpki(page)).toBe(rotated);
	// With the factor step.
	await signOut(page, origin);
	await keepKey(page);
	await fillSignIn(page, password);
	await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
	await page.getByRole("button", { name: "Verify code" }).click();
	await expect(page).toHaveURL(`${origin}/`);
	const factored = await storedSpki(page);
	expect(factored).not.toBe(rotated);
	expect(bodies("/owner/factor").at(-1)).toMatchObject({
		key: factored,
		replaces: { key: rotated },
	});
	expect(await keptResume(page)).toBe(401);
	// A browser without a key signs in with no `replaces`, and is accepted.
	const elsewhere = await browser.newContext();
	try {
		const tab = await elsewhere.newPage();
		const sent = ownerBodies(tab);
		await tab.goto(`${origin}/sign-in`);
		await fillSignIn(tab, password);
		await tab.getByLabel("Authenticator or recovery code").fill(codes[1]);
		await tab.getByRole("button", { name: "Verify code" }).click();
		await expect(tab).toHaveURL(`${origin}/`);
		expect("replaces" in (sent("/owner/sign-in")[0] ?? {})).toBe(false);
	} finally {
		await elsewhere.close();
	}
});

test("Setup claims with a new key and sends no replaces; a /setup tab elsewhere loads / after the claim", async ({
	context,
}) => {
	const directory = await createOwnerDirectory();
	const server = await startStudio(directory);
	try {
		const origin = server.origin.origin;
		await expect.poll(server.token).not.toBe("");
		const [page, other] = [await context.newPage(), await context.newPage()];
		for (const tab of [page, other]) await tab.goto(`${origin}/setup`);
		await expect(other.getByRole("button", { name: "Claim studio" })).toBeVisible();
		const bodies = ownerBodies(page);
		await page.getByLabel("Claim token").fill(server.token());
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
		await page.getByRole("button", { name: "Claim studio" }).click();
		await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();
		const [claim] = bodies("/owner/claim");
		expect("replaces" in claim).toBe(false);
		expect(await storedSpki(page)).toBe(claim.key);
		// The other tab hears of the claim and joins its session.
		await expect(other).toHaveURL(`${origin}/`);
		expect(await sessionOf(other, origin)).toBe(await sessionOf(page, origin));
	} finally {
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a refused sign-in, a reload and a cache return mid-factor keep the stored key", async ({
	page,
	studio,
}) => {
	test.setTimeout(90000);
	const { origin, password } = studio;
	await page.addInitScript(() => {
		// A commit that `pagehide` interrupts before its write lands.
		const transaction = IDBDatabase.prototype.transaction;
		IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args) {
			const opened = transaction.apply(this, args);
			if ((globalThis as { hideOnCommit?: boolean }).hideOnCommit && args[1] === "readwrite") {
				(globalThis as { hideOnCommit?: boolean }).hideOnCommit = false;
				dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
				opened.abort();
			}
			return opened;
		} as typeof transaction;
	});
	const { codes } = await enableFactor(page, origin, password);
	await signOut(page, origin);
	const stored = await storedSpki(page);
	await fillSignIn(page, "not the password");
	await expect(page.getByRole("alert")).toHaveText("Check your username and password.");
	expect(await storedSpki(page)).toBe(stored);
	// A reload mid-factor restarts the sign-in.
	await fillSignIn(page, password);
	await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
	await page.reload();
	await expect(page.getByRole("alert")).toHaveText(restarted);
	expect(await storedSpki(page)).toBe(stored);
	// A back/forward-cache return mid-factor does too. No engine restores these no-store
	// documents under Playwright, so the page gets the restore's own events.
	await fillSignIn(page, password);
	await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
	await page.evaluate(() => {
		dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
	});
	await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText(restarted);
	expect(await storedSpki(page)).toBe(stored);
	// A return without a pending proof says nothing.
	await page.reload();
	await page.evaluate(() => {
		dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
	});
	await expect(page.getByRole("alert")).toHaveCount(0);
	// A commit `pagehide` interrupted leaves no live session: the return restarts the sign-in.
	await fillSignIn(page, password);
	await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
	await page.evaluate(() => {
		(globalThis as { hideOnCommit?: boolean }).hideOnCommit = true;
	});
	await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
	await page.getByRole("button", { name: "Verify code" }).click();
	await expect
		.poll(() => page.evaluate(() => (globalThis as { hideOnCommit?: boolean }).hideOnCommit))
		.toBe(false);
	await page.evaluate(() =>
		dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
	);
	await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText(restarted);
	expect(await storedSpki(page)).toBe(stored);
});

test("Retry keeps the credential inputs disabled, and Cancel still leaves its factor step", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
	const { codes } = await enableFactor(page, origin, password);
	await signOut(page, origin);
	const stored = await storedSpki(page);
	const lose = (route: Route) => route.abort("failed");
	const retry = page.getByRole("button", { name: "Retry" });
	// The sign-in's answer and the candidate's resume are both lost: Retry is offered.
	await page.route("**/owner/sign-in", lose);
	await page.route("**/owner/resume", lose);
	await fillSignIn(page, password);
	await expect(retry).toBeVisible();
	await expect(page.getByLabel("Username")).toBeDisabled();
	await expect(page.getByLabel("Password", { exact: true })).toBeDisabled();
	await page.unroute("**/owner/sign-in", lose);
	await page.unroute("**/owner/resume", lose);
	await retry.click();
	await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
	// The same for the code's answer, then Cancel ends the factor step.
	const code = page.getByLabel("Authenticator or recovery code");
	await page.route("**/owner/factor", lose);
	await page.route("**/owner/resume", lose);
	await code.fill(codes[0]);
	await page.getByRole("button", { name: "Verify code" }).click();
	await expect(retry).toBeVisible();
	await expect(code).toBeDisabled();
	await page.unroute("**/owner/factor", lose);
	await page.unroute("**/owner/resume", lose);
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(await storedSpki(page)).toBe(stored);
});

test("lost claim, sign-in and factor answers reach the new session without re-entry", async ({
	context,
}) => {
	test.setTimeout(120000);
	const directory = await createOwnerDirectory();
	const server = await startStudio(directory);
	try {
		const origin = server.origin.origin;
		const password = crypto.randomUUID();
		await expect.poll(server.token).not.toBe("");
		const page = await context.newPage();
		const bodies = ownerBodies(page);
		await page.goto(`${origin}/setup`);
		await page.route("**/owner/claim", loseAnswer);
		await page.getByLabel("Claim token").fill(server.token());
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Claim studio" }).click();
		await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();
		expect(bodies("/owner/claim")).toHaveLength(1);
		expect(await storedSpki(page)).toBe(bodies("/owner/claim")[0].key);
		// A lost password-only sign-in.
		await signOut(page, origin);
		await page.route("**/owner/sign-in", loseAnswer, { times: 1 });
		await fillSignIn(page, password);
		await expect(page).toHaveURL(`${origin}/`);
		expect(bodies("/owner/sign-in")).toHaveLength(1);
		expect(await storedSpki(page)).toBe(bodies("/owner/sign-in")[0].key);
		// A lost factor completion.
		const { codes } = await enableFactor(page, origin, password);
		await signOut(page, origin);
		await fillSignIn(page, password);
		await page.route("**/owner/factor", loseAnswer, { times: 1 });
		await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
		await page.getByRole("button", { name: "Verify code" }).click();
		await expect(page).toHaveURL(`${origin}/`);
		expect(bodies("/owner/factor")).toHaveLength(1);
		expect(await storedSpki(page)).toBe(bodies("/owner/factor")[0].key);
	} finally {
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a lost sign-in whose original lands after its resend committed gets session-live", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
	await signOut(page, origin);
	// The first sign-in never reaches the server, and the page sees a network failure.
	const original = Promise.withResolvers<{ body: string; headers: Record<string, string> }>();
	await page.route(
		"**/owner/sign-in",
		async (route) => {
			original.resolve({
				body: route.request().postData() ?? "",
				headers: route.request().headers(),
			});
			await route.abort("failed");
		},
		{ times: 1 },
	);
	await fillSignIn(page, password);
	await expect(page).toHaveURL(`${origin}/`);
	const bound = await sessionOf(page, origin);
	// The original lands late, after its resend committed.
	const { body } = await original.promise;
	const late = await page.request.post(`${origin}/owner/sign-in`, {
		headers: { origin, "content-type": "application/json" },
		data: body,
	});
	expect(late.status()).toBe(409);
	expect((await late.json()).reason).toBe("session-live");
	expect(await sessionOf(page, origin)).toBe(bound);
});

test("a tab closed with its answer held leaves the old key and a signed-out browser", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await signOut(page, origin);
	const stored = await storedSpki(page);
	const release = Promise.withResolvers<void>();
	const held = holdAnswer(release.promise);
	await page.route("**/owner/sign-in", held.handler);
	await fillSignIn(page, password);
	await held.answered;
	await page.close();
	const next = await context.newPage();
	await next.goto(`${origin}/jobs`);
	await expect(next).toHaveURL(`${origin}/sign-in`);
	expect(await storedSpki(next)).toBe(stored);
	release.resolve();
});

test("two tabs signing in at once leave one stored key and one live session that both reach", async ({
	page,
	context,
	studio,
}) => {
	test.setTimeout(120000);
	const { origin, password } = studio;
	await signOut(page, origin);
	for (const failCleanup of [false, true]) {
		const [first, second] = [await context.newPage(), await context.newPage()];
		const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const holds = releases.map((release) => holdAnswer(release.promise));
		const tabs = [first, second];
		for (const [i, tab] of tabs.entries()) {
			await tab.goto(`${origin}/sign-in`);
			await tab.route("**/owner/sign-in", holds[i].handler);
		}
		if (failCleanup) await second.route("**/owner/sign-out", (route) => route.abort("failed"));
		for (const tab of tabs) await fillSignIn(tab, password);
		const [won, lost] = await Promise.all(holds.map((hold) => hold.answered));
		releases[0].resolve();
		await expect(first).toHaveURL(`${origin}/`);
		releases[1].resolve();
		// The loser's commit is refused: it signs its login out and joins the winner.
		await expect(second).toHaveURL(`${origin}/`);
		await expect(second.getByRole("button", { name: "Sign out" })).toBeVisible();
		expect(await sessionOf(second, origin)).toBe(won.sessionId);
		expect(await sessionOf(first, origin)).toBe(won.sessionId);
		expect(await liveSession(page, origin, won.bearer as string)).toBe(won.sessionId);
		// A failed cleanup leaves the loser's session to the idle limit; the winner survives.
		expect(await liveSession(page, origin, lost.bearer as string)).toBe(
			failCleanup ? lost.sessionId : 401,
		);
		await signOut(first, origin);
		await Promise.all(tabs.map((tab) => tab.close()));
	}
});

test("a tab whose request is in flight acts on another tab's commit only after its answer", async ({
	page,
	context,
	studio,
}) => {
	test.setTimeout(120000);
	const { origin, password } = studio;
	await signOut(page, origin);
	for (const via of ["notice", "focus"] as const) {
		const [winner, loser] = [await context.newPage(), await context.newPage()];
		// Without notices, only the loser's own focus check can find the winner's key.
		if (via === "focus")
			await loser.addInitScript(() => {
				Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
				addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
			});
		for (const tab of [winner, loser]) await tab.goto(`${origin}/sign-in`);
		const sent = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const timeline: string[] = [];
		loser.on("request", (request) => {
			if (request.isNavigationRequest()) timeline.push(`load ${new URL(request.url()).pathname}`);
			if (request.url().endsWith("/owner/sign-out")) timeline.push("sign-out");
		});
		const loserAnswer = Promise.withResolvers<Record<string, unknown>>();
		await loser.route("**/owner/sign-in", async (route) => {
			sent.resolve();
			await release.promise;
			const response = await route.fetch();
			loserAnswer.resolve(await response.json());
			timeline.push("answer");
			await route.fulfill({ response });
		});
		await fillSignIn(loser, password);
		await sent.promise;
		await fillSignIn(winner, password);
		await expect(winner).toHaveURL(`${origin}/`);
		if (via === "focus") await loser.evaluate(() => dispatchEvent(new Event("focus")));
		await loser.waitForTimeout(300);
		expect(timeline).toEqual([]);
		release.resolve();
		await expect(loser).toHaveURL(`${origin}/`);
		expect(timeline.slice(0, 3)).toEqual(["answer", "sign-out", "load /"]);
		const lost = await loserAnswer.promise;
		expect(await liveSession(page, origin, lost.bearer as string)).toBe(401);
		expect(await sessionOf(loser, origin)).toBe(await sessionOf(winner, origin));
		await signOut(winner, origin);
		await Promise.all([winner.close(), loser.close()]);
	}
});

test("a stored key that cannot sign is overwritten; one another tab replaced sends the tab to /", async ({
	page,
	context,
	studio,
}) => {
	test.setTimeout(90000);
	const { origin, password } = studio;
	await signOut(page, origin);
	// Replace the record with one whose key cannot sign, as after a profile reset.
	const unusable = await page.evaluate(async () => {
		const installation =
			document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content") ?? "";
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
			"verify",
		]);
		const spki = btoa(
			String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("siluet-owner", 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("keys", "readwrite");
			transaction.objectStore("keys").put({ key: pair.publicKey, spki }, installation);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		db.close();
		return spki;
	});
	// The reset happened before this document read the key; a change since sends a submit to `/`.
	await page.reload();
	const bodies = ownerBodies(page);
	await fillSignIn(page, password);
	await expect(page).toHaveURL(`${origin}/`);
	expect("replaces" in bodies("/owner/sign-in")[0]).toBe(false);
	const stored = await storedSpki(page);
	expect(stored === unusable || stored === null).toBe(false);
	// Mid-factor, another tab stores its key: the factor step goes to / instead.
	const { codes } = await enableFactor(page, origin, password);
	await signOut(page, origin);
	await fillSignIn(page, password);
	await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
	const other = await context.newPage();
	await signInOwner(other, origin, password, "owner", codes[0]);
	await page.getByLabel("Authenticator or recovery code").fill(codes[1]);
	await page.getByRole("button", { name: "Verify code" }).click();
	await expect(page).toHaveURL(`${origin}/`);
	expect(bodies("/owner/factor")).toHaveLength(0);
	expect(await sessionOf(page, origin)).toBe(await sessionOf(other, origin));
});

test("a failing key write shows the key message and leaves the candidate no live session", async ({
	page,
	studio,
}) => {
	test.setTimeout(90000);
	const { origin, password } = studio;
	await page.addInitScript(() => {
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
			if ((globalThis as { failPut?: boolean }).failPut)
				throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			return put.apply(this, args);
		} as typeof put;
	});
	const issued = issuedTo(page);
	const { codes } = await enableFactor(page, origin, password);
	await signOut(page, origin);
	for (const [failCleanup, code] of [
		[false, codes[0]],
		[true, codes[1]],
	] as const) {
		await page.goto(`${origin}/sign-in`);
		const stored = await storedSpki(page);
		if (failCleanup) await page.route("**/owner/sign-out", (route) => route.abort("failed"));
		await fillSignIn(page, password);
		await page.evaluate(() => {
			(globalThis as { failPut?: boolean }).failPut = true;
		});
		await page.getByLabel("Authenticator or recovery code").fill(code);
		await page.getByRole("button", { name: "Verify code" }).click();
		await expect(page.getByRole("alert")).toContainText("cannot keep a sign-in key");
		// The factor proof is cleared: the form is back at its first step.
		await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
		await page.evaluate(() => {
			(globalThis as { failPut?: boolean }).failPut = false;
		});
		expect(await storedSpki(page)).toBe(stored);
		const candidate = issued.at(-1);
		if (!candidate) throw new Error("Expected an issued session.");
		// With the cleanup sign-out failing too, the abandoned session lives to the idle limit.
		expect(await liveSession(page, origin, candidate.bearer)).toBe(
			failCleanup ? candidate.sessionId : 401,
		);
		if (failCleanup) await page.unroute("**/owner/sign-out");
		await page.goto(`${origin}/jobs`);
		await expect(page).toHaveURL(`${origin}/sign-in`);
	}
});

test("tabs that met the old key's 401 before the commit follow the new key once it is stored", async ({
	page,
	context,
	studio,
}) => {
	test.setTimeout(120000);
	const { origin, password } = studio;
	// This tab shows the codes of a regeneration; a sibling is bound to the same session.
	const { codes } = await enableFactor(page, origin, password);
	const sibling = await context.newPage();
	await sibling.goto(`${origin}/jobs`);
	await expect(sibling.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	await page.goto(`${origin}/settings/security`);
	await page.getByLabel("Current password").fill(password);
	await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
	await page.getByLabel("Security action").selectOption("regenerate");
	await page.getByRole("button", { name: "Continue" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	const fresh = (await dialog.locator("li").allTextContents()).map((code) => code.trim());
	// The regeneration replaced the sibling's session; it loads the successor.
	await sibling.reload();
	await expect(sibling.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	const siblingDocuments: string[] = [];
	sibling.on("request", (request) => {
		if (request.isNavigationRequest()) siblingDocuments.push(new URL(request.url()).pathname);
	});
	// Another tab of this browser signs in; its answer is held after the server committed.
	const signing = await signInFormWhileSignedIn(context, origin);
	await fillSignIn(signing, password);
	await signing.getByLabel("Authenticator or recovery code").fill(fresh[0]);
	const release = Promise.withResolvers<void>();
	const held = holdAnswer(release.promise);
	await signing.route("**/owner/factor", held.handler);
	await signing.getByRole("button", { name: "Verify code" }).click();
	const issued = await held.answered;
	// Before the commit: the bound sibling is signed out, and the codes are held as signed out.
	await sibling.evaluate(() => dispatchEvent(new Event("focus")));
	await expect(sibling).toHaveURL(`${origin}/sign-in`);
	await page.evaluate(() => dispatchEvent(new Event("focus")));
	await expect(dialog).toContainText("Signed out.");
	// The commit's notice: the `/sign-in` sibling loads `/`, the codes are marked changed.
	release.resolve();
	await expect(signing).toHaveURL(`${origin}/`);
	await expect(sibling).toHaveURL(`${origin}/`);
	expect(await sessionOf(sibling, origin)).toBe(issued.sessionId);
	await expect(dialog).toContainText("Session changed.");
	await expect(dialog.locator("li")).toHaveCount(10);
	const loaded = page.waitForEvent("load");
	await dialog.getByRole("button", { name: "Done" }).click();
	await loaded;
	await expect(page).toHaveURL(`${origin}/settings/security`);
	expect(await sessionOf(page, origin)).toBe(issued.sessionId);
	expect(siblingDocuments).toContain("/sign-in");
});

test("a bound tab meeting the old key's 401 after the commit reaches the new session directly", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(`${origin}/jobs`);
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	const documents: string[] = [];
	page.on("request", (request) => {
		if (request.isNavigationRequest()) documents.push(new URL(request.url()).pathname);
	});
	const signing = await signInFormWhileSignedIn(context, origin);
	await fillSignIn(signing, password);
	await expect(signing).toHaveURL(`${origin}/`);
	await focusBoundTab(page);
	await expect.poll(() => documents).toContain("/jobs");
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	expect(documents).not.toContain("/sign-in");
	expect(await sessionOf(page, origin)).toBe(await sessionOf(signing, origin));
});
