import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import ledger from "../../docs/media-catalog.v1.json";
import { maxSeedreamReferences } from "../../src/lib/shared/image-studio/references";
import {
	reviewBatchCounts,
	reviewRetryLimits,
} from "../../src/lib/shared/image-studio/review-price";
import {
	h3MaxOperation,
	releasedModels,
	releasedOperations,
	resolveOperationKey,
} from "../../src/lib/shared/media-catalog/registry";
import { catalogCoverage, documentedRoutes } from "./coverage";

const { poyo, toapis } = ledger.providers;
const providers = ["poyo", "toapis"] as const;

test("the frozen discovery scope accounts for snapshot, regional and documentation-only IDs", () => {
	expect(ledger.defaults).toEqual({
		keyAccess: "unknown",
		optionContract: "unknown-until-reviewed",
		d4: "unknown",
		support: "inventory",
	});
	expect(ledger.version).toBe(1);
	expect(ledger.observedOn).toBe("2026-11-22");
	expect(ledger.supportProfiles["seedream-edit"].queue).toContain(
		`1–${maxSeedreamReferences} ordered public HTTP(S) image URLs`,
	);
	expect(ledger.supportProfiles["seedream-edit"].queue).toContain(
		"one local JPEG or PNG via provider upload, cleaned unless cleaning is off, one request, zero retries",
	);
	expect(poyo.sources.uploadStream).toBe(
		"https://docs.poyo.ai/api-manual/file-series/upload-stream",
	);
	for (const profile of ["seedream-generate", "seedream-edit"] as const) {
		const queue = ledger.supportProfiles[profile].queue;
		expect(queue).toContain(`1–${reviewBatchCounts.at(-1)} requests`);
		expect(queue).toContain(`0–${reviewRetryLimits.at(-1)} authorized retries per request`);
	}
	expect(ledger.supportBaselineCommit).toBe("3a2432bd896c74cc6f76ff02bb2a16df5addc3b4");
	const discovery = poyo.discovery;
	expect(poyo.sources.catalog).toContain(discovery.snapshot.revision);
	expect(discovery.snapshot.sha256).toBe(
		"eebbc67cb1f6cc25d75f93518b0b390c5fb6c0b9abfb12241d7219d9215cd945",
	);
	expect(
		poyo.rows
			.filter((row) => !row.catalogCategory)
			.flatMap((row) => row.ids)
			.sort(),
	).toEqual([...discovery.docsOnlyIds].sort());
	const listed = poyo.rows.filter((row) => row.catalogCategory).flatMap((row) => row.ids);
	expect(new Set(listed).size).toBe(listed.length);
	expect(
		listed.length +
			Object.values(discovery.excludedCatalogRowsByCategory).reduce((a, b) => a + b, 0),
	).toBe(discovery.snapshot.rows);

	const listings = toapis.listings.flatMap((group) => group.ids.map((id) => ({ ...group, id })));
	expect(listings.map((row) => row.id).sort()).toEqual(
		[...new Set(toapis.rows.flatMap((row) => row.ids))].sort(),
	);
	for (const section of ["image", "video", "text"] as const) {
		const snapshot = toapis.discovery.snapshot;
		expect(listings.filter((row) => row.snapshotSection === section)).toHaveLength(
			section === "text" ? snapshot.textRowsWithImageTag : snapshot[`${section}Rows`],
		);
	}
	for (const region of ["cn", "global"] as const) {
		for (const media of ["image", "video"] as const) {
			expect(
				listings.filter((row) => row.regions?.includes(region) && row.guideMedia === media),
			).toHaveLength(toapis.discovery.current[`${media}Ids`][region]);
		}
	}
});

test.each(providers)(
	"%s provenance resolves and exact ID spelling matches the audited inventory",
	(provider) => {
		const catalog = ledger.providers[provider];
		const ids = [...new Set(catalog.rows.flatMap((row) => row.ids))].sort();
		// Counts alone miss a case change or one ID silently replacing another.
		expect(createHash("sha256").update(JSON.stringify(ids)).digest("hex")).toBe(
			provider === "poyo"
				? "801466ef7dca8a95dc463b19c472e89b051e5b9c9c92901f43172dfafebbb779"
				: "33fd724ca6b90ecc7657b8c2cb895fe82cb63bcb92561fd903d5f84930a0bdb9",
		);
		const sources = [
			...catalog.lifecycleSources,
			catalog.discovery.snapshot.source,
			...catalog.rows.flatMap((row) => row.sources),
			...(provider === "poyo"
				? [
						poyo.discovery.index,
						poyo.discovery.catalogDocs,
						...poyo.history.flatMap((row) => row.sources),
					]
				: [
						toapis.discovery.modelDocsIndex,
						toapis.discovery.earlierGuide.source,
						toapis.discovery.keyContract,
						...toapis.discovery.snapshot.sameRows,
						...toapis.discovery.current.sources,
						...toapis.outOfScope.map((row) => row.source),
					]),
		];
		expect(poyo.discovery.keyContract).toBeNull();
		for (const source of sources) expect(Object.hasOwn(catalog.sources, source)).toBe(true);
		const hosts =
			provider === "poyo"
				? ["docs.poyo.ai", "raw.githubusercontent.com", "poyo.ai"]
				: ["toapis.com", "toapis.cn", "docs.toapis.com", "docs.toapis.cn"];
		for (const source of Object.values(catalog.sources)) {
			const url = new URL(source);
			expect(url.protocol).toBe("https:");
			expect(hosts).toContain(url.hostname);
		}
	},
);

test("aliases name exact discovered provider IDs and each member belongs to one model group", () => {
	const members = new Map<string, string>();
	const modelGroups = new Set<string>();
	for (const family of ledger.families) {
		for (const model of family.models) {
			expect(modelGroups.has(model.id)).toBe(false);
			modelGroups.add(model.id);
			for (const provider of providers) {
				const ids = new Set(ledger.providers[provider].rows.flatMap((row) => row.ids));
				for (const member of model[provider]) {
					expect(ids.has(member)).toBe(true);
					const alias = `${provider}:${member}`;
					expect(members.has(alias)).toBe(false);
					members.set(alias, `${family.id}/${model.id}`);
				}
			}
		}
	}
	expect(Object.fromEntries(members)).toEqual({
		"poyo:z-image": "z-image/z-image",
		"poyo:seedream-5.5": "seedream/seedream-5.5",
		"poyo:seedream-5.5-layerize": "seedream/seedream-5.5",
		"toapis:doubao-seedream-5-5": "seedream/seedream-5.5",
		"poyo:qwen-image-3": "qwen/qwen-image-3.0",
		"toapis:qwen-image-3.0": "qwen/qwen-image-3.0",
		"poyo:qwen-image-3-pro": "qwen/qwen-image-3.0-pro",
		"toapis:qwen-image-3.0-pro": "qwen/qwen-image-3.0-pro",
		"poyo:seedance-2.5": "seedance/seedance-2.5",
		"toapis:seedance-2-5": "seedance/seedance-2.5",
		"poyo:h3-max": "hailuo/h3-max",
		"toapis:MiniMax-H3-Max": "hailuo/h3-max",
	});
	for (const released of releasedModels) {
		const family = ledger.families.find((family) => family.label === released.family);
		const model = family?.models.find((model) => model.id === released.id);
		expect(model?.label).toBe(released.label);
		for (const { key, modelId } of releasedOperations) {
			if (modelId === released.id) expect(model?.[key.provider]).toContain(key.model);
		}
	}
});

test.each(providers)("%s documents each route, alias and operation once", (provider) => {
	const keys = new Set<string>();
	for (const row of ledger.providers[provider].rows) {
		expect(row.sources.length).toBeGreaterThan(0);
		expect(row.ids.length).toBeGreaterThan(0);
		for (const id of row.ids) expect(id).toMatch(/^\S+$/);
		for (const field of [row.d4, "catalogD4" in row ? row.catalogD4 : undefined]) {
			expect(["declared", "conflict", "unknown"]).toContain(field ?? ledger.defaults.d4);
		}
		if (row.contract !== "documented") {
			expect(["advertised", "unresolved"]).toContain(row.contract);
			expect(row.route).toBeNull();
			expect(row.operations).toBeEmpty();
			expect(row.gaps?.length || row.variant).toBeTruthy();
			expect(row.support).toBeUndefined();
			continue;
		}
		expect(row.route).not.toBeNull();
		expect(row.operations.length).toBeGreaterThan(0);
		for (const [operation, rule] of Object.entries(row.requires ?? {})) {
			expect(row.operations).toContain(operation);
			expect(rule.kind).toBeTruthy();
			expect(typeof rule.upstreamOperationInScope).toBe("boolean");
		}
		for (const route of documentedRoutes(row)) {
			expect(route).toMatch(/^POST \/\S+$/);
			for (const id of row.ids) {
				for (const operation of row.operations) {
					const key = JSON.stringify([provider, id, route, operation]);
					expect(keys.has(key)).toBe(false);
					keys.add(key);
				}
			}
		}
	}
});

test.each(providers)(
	"%s reconciles its shipped media operations and partial option coverage",
	(provider) => {
		const shipped = [];
		for (const row of ledger.providers[provider].rows) {
			for (const [operation, profile] of Object.entries(row.support ?? {})) {
				expect(row.operations).toContain(operation);
				expect(row.d4).toBe("declared");
				const catalogD4 = ("catalogD4" in row && row.catalogD4) || ledger.defaults.d4;
				expect(catalogD4).not.toBe("conflict");
				const support = ledger.supportProfiles[profile as keyof typeof ledger.supportProfiles];
				expect(support.review).toBeTruthy();
				expect(support.queue).toBeTruthy();
				expect(support.optionCoverage).toBe("partial");
				for (const model of row.ids) {
					shipped.push({
						key: { provider, model, route: row.route, operation },
						profile,
						evidence: { d4: row.d4, catalogD4 },
					});
				}
			}
		}
		expect(shipped).toEqual(
			releasedOperations
				.filter((entry) => entry.key.provider === provider)
				.map(({ key, profile, evidence }) => ({ key, profile, evidence })),
		);
		expect(catalogCoverage(provider)).toEqual({
			discoveredIds: provider === "poyo" ? 164 : 119,
			unresolvedIds: provider === "poyo" ? 5 : 21,
			documentedOperations: provider === "poyo" ? 317 : 331,
			prerequisiteBound: provider === "poyo" ? 2 : 17,
			review: provider === "poyo" ? 5 : 3,
			queue: provider === "poyo" ? 5 : 3,
			partialOptions: provider === "poyo" ? 5 : 3,
			addedSinceBaseline: provider === "poyo" ? 3 : 1,
		});
	},
);

test("H3 key never resolves to ToAPIs", () => {
	expect(resolveOperationKey(h3MaxOperation.key)).toBe(h3MaxOperation);
	const toapisRow = toapis.rows.find((row) => row.ids.includes("MiniMax-H3-Max"));
	expect(toapisRow).toBeDefined();
	for (const key of [
		{ ...h3MaxOperation.key, provider: "toapis" },
		{ ...h3MaxOperation.key, provider: "toapis", model: "MiniMax-H3-Max" },
		...(toapisRow?.operations ?? []).map((operation) => ({
			provider: "toapis",
			model: "MiniMax-H3-Max",
			route: toapisRow?.route,
			operation,
		})),
	])
		expect(resolveOperationKey(key)).toBeUndefined();
	expect(toapisRow && "support" in toapisRow).toBe(false);
	const poyoRow = poyo.rows.find((row) => row.ids.includes("h3-max"));
	expect(poyoRow?.support).toEqual({ "text-to-video": h3MaxOperation.profile });
	expect(ledger.supportProfiles[h3MaxOperation.profile]).toMatchObject({
		addedSinceBaseline: true,
		optionCoverage: "partial",
	});
});
