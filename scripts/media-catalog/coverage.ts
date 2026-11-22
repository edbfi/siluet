import ledger from "../../docs/media-catalog.v1.json";

type Provider = keyof typeof ledger.providers;

export function documentedRoutes(row: { route: string | null; aliases?: string[] }) {
	return row.route === null ? [] : [row.route, ...(row.aliases ?? [])];
}

export function catalogCoverage(provider: Provider) {
	const rows = ledger.providers[provider].rows;
	const ids = new Set(rows.flatMap((row) => row.ids));
	const unresolved = new Set(
		rows.filter((row) => row.contract !== "documented").flatMap((row) => row.ids),
	);
	let documentedOperations = 0;
	let prerequisiteBound = 0;
	let review = 0;
	let queue = 0;
	let partialOptions = 0;
	let addedSinceBaseline = 0;
	for (const row of rows) {
		const routeIds = documentedRoutes(row).length * row.ids.length;
		documentedOperations += routeIds * row.operations.length;
		prerequisiteBound += routeIds * Object.keys(row.requires ?? {}).length;
		for (const name of Object.values(row.support ?? {})) {
			const profile = ledger.supportProfiles[name as keyof typeof ledger.supportProfiles];
			if ("addedSinceBaseline" in profile && profile.addedSinceBaseline)
				addedSinceBaseline += row.ids.length;
			if (profile.review) review += row.ids.length;
			if (profile.queue) queue += row.ids.length;
			if (profile.optionCoverage === "partial") partialOptions += row.ids.length;
		}
	}
	return {
		discoveredIds: ids.size,
		unresolvedIds: unresolved.size,
		documentedOperations,
		prerequisiteBound,
		review,
		queue,
		partialOptions,
		addedSinceBaseline,
	};
}

if (import.meta.main) {
	console.log(
		`Catalog observed ${ledger.observedOn}. Current checkout coverage includes operations added since the audited release ${ledger.supportBaselineCommit.slice(0, 7)}.`,
	);
	console.table({ poyo: catalogCoverage("poyo"), toapis: catalogCoverage("toapis") });
}
