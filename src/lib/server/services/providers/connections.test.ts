import { expect, test } from "bun:test";
import type { ProviderConnectionStatus, ProviderId } from "#lib/shared/providers/connections.ts";
import type { ConnectionCheck, ConnectionCheckResult } from "../../providers/connection-check";
import { createProviderConnections } from "./connections";

function setup(poyo: ConnectionCheck, toapis: ConnectionCheck = poyo) {
	const connections = new Map<ProviderId, ProviderConnectionStatus>();
	const keys = new Map<ProviderId, string>();
	const revisions = { poyo: 0, toapis: 0 };
	let elapsed = 0;
	const service = createProviderConnections(
		{
			revision: async (id) => revisions[id],
			status: async (id) => connections.get(id) ?? { id, state: "disconnected" },
			save: async (id, key, verifiedAt, seedream, expectedRevision) => {
				if (revisions[id] !== expectedRevision) return false;
				revisions[id]++;
				connections.set(id, { id, state: "connected", verifiedAt, seedream });
				keys.set(id, key);
				return true;
			},
			remove: async (id) => {
				revisions[id]++;
				connections.delete(id);
				keys.delete(id);
			},
		},
		{ poyo, toapis },
		() => elapsed,
	);
	return { service, keys, connections, advance: (ms: number) => (elapsed += ms) };
}

test("a rejected or unavailable replacement preserves the accepted key and timestamp", async () => {
	const { service, keys } = setup(async (key) => {
		if (key === "fixture-original") return { outcome: "accepted", seedream: true };
		return { outcome: key === "fixture-rejected" ? "rejected" : "unavailable" };
	});
	expect(await service.connect("poyo", "  fixture-original ")).toBe("connected");
	const accepted = await service.statuses();
	expect(await service.connect("poyo", "fixture-rejected")).toBe("rejected");
	expect(await service.connect("poyo", "fixture-unavailable")).toBe("unavailable");
	expect(await service.statuses()).toEqual(accepted);
	expect(keys.get("poyo")).toBe("fixture-original");
	expect(accepted).toEqual([
		{ id: "poyo", state: "connected", verifiedAt: expect.any(Number), seedream: true },
		{ id: "toapis", state: "disconnected" },
	]);
});

test("eligibility excludes disconnected, unreadable, and connected keys lacking Seedream", async () => {
	const accepted: ConnectionCheck = async () => ({ outcome: "accepted", seedream: true });
	const { service, connections } = setup(accepted, async (key) => ({
		outcome: "accepted",
		seedream: key === "fixture-toapis-eligible",
	}));
	expect(await service.eligibleSeedreamProviders()).toEqual([]);
	await service.connect("poyo", "fixture-poyo");
	await service.connect("toapis", "fixture-toapis-restricted");
	expect(await service.eligibleSeedreamProviders()).toEqual(["poyo"]);
	await service.connect("toapis", "fixture-toapis-eligible");
	expect(await service.eligibleSeedreamProviders()).toEqual(["poyo", "toapis"]);
	connections.set("poyo", { id: "poyo", state: "reconnect" });
	expect(await service.eligibleSeedreamProviders()).toEqual(["toapis"]);
	expect(await service.remove("poyo")).toBe("removed");
	expect(await service.remove("toapis")).toBe("removed");
	expect(await service.eligibleSeedreamProviders()).toEqual([]);
});

test("each provider allows three checks per minute, counting failures and ignoring invalid input", async () => {
	let reads = 0;
	const { service, advance } = setup(async () => {
		reads++;
		return { outcome: "rejected" };
	});
	expect(await service.connect("poyo", "")).toBe("invalid");
	expect(await service.connect("poyo", "fixture\r\nheader")).toBe("invalid");
	expect(await service.connect("poyo", "q".repeat(1025))).toBe("invalid");
	expect(await service.connect("poyo", new File([], "fixture"))).toBe("invalid");
	for (let attempt = 0; attempt < 3; attempt++)
		expect(await service.connect("poyo", "fixture-key")).toBe("rejected");
	expect(await service.connect("poyo", "fixture-key")).toBe("rate-limited");
	expect(await service.connect("toapis", "fixture-key")).toBe("rejected");
	expect(await service.remove("poyo")).toBe("removed");
	expect(await service.connect("poyo", "fixture-key")).toBe("rate-limited");
	expect(reads).toBe(4);
	advance(60_000);
	expect(await service.connect("poyo", "fixture-key")).toBe("rejected");
	expect(reads).toBe(5);
});

test("a removal supersedes a pending check while the other provider remains available", async () => {
	const pending = Promise.withResolvers<ConnectionCheckResult>();
	const started = Promise.withResolvers<void>();
	const { service } = setup(
		() => {
			started.resolve();
			return pending.promise;
		},
		async () => ({ outcome: "accepted", seedream: true }),
	);
	const verification = service.connect("poyo", "fixture-key");
	await started.promise;
	expect(await service.connect("poyo", "fixture-another")).toBe("busy");
	expect(await service.remove("poyo")).toBe("removed");
	expect(await service.connect("toapis", "fixture-toapis")).toBe("connected");
	pending.resolve({ outcome: "accepted", seedream: true });
	expect(await verification).toBe("superseded");
	expect(await service.eligibleSeedreamProviders()).toEqual(["toapis"]);
});

test("a storage error releases the provider for retry and exposes no exception text", async () => {
	let fail = true;
	const service = createProviderConnections(
		{
			revision: async () => 0,
			status: async (id) => ({ id, state: "disconnected" }),
			save: async () => {
				if (fail) throw new Error("fixture-secret");
				return true;
			},
			remove: async () => {
				throw new Error("fixture-secret");
			},
		},
		{
			poyo: async () => ({ outcome: "accepted", seedream: true }),
			toapis: async () => ({ outcome: "accepted", seedream: true }),
		},
	);
	expect(await service.connect("poyo", "fixture-secret")).toBe("storage-unavailable");
	fail = false;
	expect(await service.connect("poyo", "fixture-another")).toBe("connected");
	expect(await service.remove("poyo")).toBe("storage-unavailable");
});
