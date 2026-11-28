// The price basis that pairs with the published v2 Poyo.ai feed (catalog engine spec, Pricing,
// "Basis"). Older builds decode only exact top-level feed keys, so the digests that bind each
// derived rate to its catalog entry travel in this separate file.
import { hasKeys, isPricingRecord } from "./feed";
import { poyoRateKey } from "./poyo-feed";

/** Published blob, trailing LF included, as `publish.sh` limits it. */
export const poyoBasisByteLimit = 32 * 1024;
const maxDigests = 1_000;
const sha256Hex = /^[a-f0-9]{64}$/;

export type PoyoPriceBasis = Readonly<{
	/** The paired feed's revision. */
	revision: string;
	/** SHA-256 of the paired feed's canonical JSON, with no trailing LF. */
	feedSha256: string;
	/** Per rate key, the SHA-256 of the entry's canonical billing and input schema. */
	digests: Readonly<Record<string, string>>;
}>;

export function decodePoyoBasis(value: unknown): PoyoPriceBasis | undefined {
	if (!hasKeys(value, ["revision", "feedSha256", "digests"])) return;
	const { revision, feedSha256, digests } = value;
	if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) return;
	if (typeof feedSha256 !== "string" || !sha256Hex.test(feedSha256)) return;
	if (!isPricingRecord(digests)) return;
	const entries = Object.entries(digests);
	if (entries.length > maxDigests) return;
	const decoded: Record<string, string> = Object.create(null);
	for (const [key, digest] of entries) {
		if (!poyoRateKey.test(key) || typeof digest !== "string" || !sha256Hex.test(digest)) return;
		decoded[key] = digest;
	}
	return { revision, feedSha256, digests: decoded };
}
