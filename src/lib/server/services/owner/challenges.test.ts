import { expect, test } from "bun:test";
import { createChallenges } from "./challenges";

test("a nonce is 256 bits and spends once, for its own purpose", () => {
	const challenges = createChallenges(() => 0);
	const nonce = challenges.issue("sign-in") as string;
	expect(nonce).toMatch(/^[\w-]{43}$/);
	expect(challenges.consume("resume", nonce)).toBe(false);
	// A consume for the wrong purpose does not spend another purpose's nonce.
	expect(challenges.consume("sign-in", nonce)).toBe(true);
	expect(challenges.consume("sign-in", nonce)).toBe(false);
	expect(challenges.consume("sign-in", undefined)).toBe(false);
});

test("a nonce expires 60 s after issue on the monotonic clock", () => {
	let now = 1000;
	const challenges = createChallenges(() => now);
	const early = challenges.issue("resume") as string;
	const late = challenges.issue("resume") as string;
	now += 59999;
	expect(challenges.consume("resume", early)).toBe(true);
	now += 1;
	expect(challenges.consume("resume", late)).toBe(false);
});

test("resume keeps 64 outstanding, dropping the oldest, and issues 120 a minute", () => {
	let now = 0;
	const challenges = createChallenges(() => now);
	const nonces = Array.from({ length: 65 }, () => challenges.issue("resume") as string);
	expect(challenges.consume("resume", nonces[0])).toBe(false);
	expect(challenges.consume("resume", nonces[1])).toBe(true);
	expect(challenges.consume("resume", nonces[64])).toBe(true);
	for (let i = 65; i < 120; i++) expect(challenges.issue("resume")).not.toBeNull();
	expect(challenges.issue("resume")).toBeNull();
	// Other purposes keep their own budget.
	expect(challenges.issue("sign-out")).not.toBeNull();
	now += 60001;
	expect(challenges.issue("resume")).not.toBeNull();
});

test("other purposes keep 16 outstanding and issue 30 a minute", () => {
	let now = 0;
	const challenges = createChallenges(() => now);
	const nonces = Array.from({ length: 17 }, () => challenges.issue("claim") as string);
	expect(challenges.consume("claim", nonces[0])).toBe(false);
	expect(challenges.consume("claim", nonces[16])).toBe(true);
	for (let i = 17; i < 30; i++) expect(challenges.issue("claim")).not.toBeNull();
	expect(challenges.issue("claim")).toBeNull();
	now += 30000;
	expect(challenges.issue("claim")).toBeNull();
	now += 30001;
	expect(challenges.issue("claim")).not.toBeNull();
});

test("a restarted runtime knows no earlier nonce", () => {
	const before = createChallenges(() => 0);
	const nonce = before.issue("resume");
	expect(createChallenges(() => 0).consume("resume", nonce)).toBe(false);
});
