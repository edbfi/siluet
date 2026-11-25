import { randomBytes } from "node:crypto";
import type { KeyPurpose } from "../../../shared/owner/key-message";
import { toBase64Url } from "../../../shared/owner/key-message";

export const challengeMs = 60000;
/** Outstanding and per-minute issue limits. Restored tabs resume at once, so `resume` gets more. */
const limits = (purpose: KeyPurpose) =>
	purpose === "resume" ? { outstanding: 64, perMinute: 120 } : { outstanding: 16, perMinute: 30 };

/**
 * Single-use nonces for browser-key signatures, held in memory only, so a restart loses them.
 * Deadlines use the monotonic clock.
 */
export function createChallenges(monotonic = () => performance.now()) {
	const outstanding = new Map<KeyPurpose, Map<string, number>>();
	const issued = new Map<KeyPurpose, number[]>();
	return {
		/** A fresh nonce, or null when this purpose's issue rate is spent. */
		issue(purpose: KeyPurpose) {
			const now = monotonic();
			const { outstanding: cap, perMinute } = limits(purpose);
			const recent = (issued.get(purpose) ?? []).filter((at) => at > now - 60000);
			issued.set(purpose, recent);
			if (recent.length >= perMinute) return null;
			recent.push(now);
			const nonces = outstanding.get(purpose) ?? new Map<string, number>();
			outstanding.set(purpose, nonces);
			for (const [nonce, expires] of nonces) if (expires <= now) nonces.delete(nonce);
			// Maps keep insertion order, so the first entry is the oldest.
			while (nonces.size >= cap) nonces.delete(nonces.keys().next().value as string);
			const nonce = toBase64Url(randomBytes(32));
			nonces.set(nonce, now + challengeMs);
			return nonce;
		},
		/** Spend a nonce. True only once, before its deadline, for the purpose it was issued for. */
		consume(purpose: KeyPurpose, nonce: unknown) {
			const nonces = outstanding.get(purpose);
			if (typeof nonce !== "string" || !nonces) return false;
			const expires = nonces.get(nonce);
			nonces.delete(nonce);
			return expires !== undefined && monotonic() < expires;
		},
	};
}
export type Challenges = ReturnType<typeof createChallenges>;
