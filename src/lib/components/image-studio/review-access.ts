/** A Review's ToAPIs access, as the image server returns it. Poyo.ai and derived rows have none. */
export type ReviewedAccess = {
	access?: { state: string; text: string } | null;
	blockers?: readonly string[];
};

/**
 * The access line Review shows under Route evidence, whether Queue is blocked, and the other
 * blockers to list. The access line leaves that list, so its text appears once.
 */
export function reviewAccess(terms: ReviewedAccess | null | undefined) {
	const line = terms?.access?.text ?? null;
	const all = terms?.blockers ?? [];
	return {
		line,
		blocked: all.length > 0,
		blockers: all.filter((blocker) => blocker !== line),
	};
}
