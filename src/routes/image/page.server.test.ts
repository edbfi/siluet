import { expect, test } from "bun:test";
import { load } from "./+page.server";

test("Image Studio loads the current key's model refusals with its other data", async () => {
	const asked: string[] = [];
	const locals = {
		studio: {
			providers: { imageAvailability: async () => ({ eligibleProviders: ["poyo"] }) },
			cleaning: { read: async () => "remove" },
			refusals: {
				current: async (provider: string) => {
					asked.push(provider);
					return [{ model: "flux-dev", refusedAt: 1_799_000_000_000 }];
				},
			},
		},
	};
	const data = (await load({ locals } as never)) as Record<string, unknown>;
	expect(asked).toEqual(["poyo"]);
	expect(data.refusals).toEqual([{ model: "flux-dev", refusedAt: 1_799_000_000_000 }]);
	expect(data.eligibleProviders).toEqual(["poyo"]);
});
