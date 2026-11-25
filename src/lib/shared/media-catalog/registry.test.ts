import { expect, test } from "bun:test";
import { saveSecondsProblem } from "../video-studio/save-profile";
import { releasedOperations, releasedVideoOperations } from "./registry";

test("every released video operation has a valid save or null", () => {
	for (const { save } of releasedVideoOperations)
		if (save) {
			expect(saveSecondsProblem(save.seconds)).toBeNull();
			expect(["provider", "upstream"]).toContain(save.basis);
		}
	expect(
		Object.fromEntries(
			releasedVideoOperations.map(({ key, save }) => [`${key.model} ${key.operation}`, save]),
		),
	).toEqual({
		"seedance-2-5 text-to-video": { seconds: 30, basis: "provider" },
		"seedance-2-5 first-frame-to-video": { seconds: 30, basis: "provider" },
		"seedance-2-5 first-and-last-frame-to-video": { seconds: 30, basis: "provider" },
		"seedance-2-5 video-edit": { seconds: 30, basis: "upstream" },
		"h3-max text-to-video": { seconds: 15, basis: "provider" },
	});
});

// The upgrade fills a queued job's limit from (provider, model, operation) alone.
test("each released (provider, model, operation) has one route", () => {
	const keys = releasedOperations.map(({ key }) => `${key.provider} ${key.model} ${key.operation}`);
	expect(new Set(keys).size).toBe(keys.length);
});

test("saveSecondsProblem refuses 0, -1, 15.5, 61, NaN, null and text, and accepts 1 and 60", () => {
	for (const value of [0, -1, 15.5, 61, Number.NaN, null, undefined, "30", Infinity])
		expect(saveSecondsProblem(value)).toBeString();
	for (const value of [1, 15, 30, 60]) expect(saveSecondsProblem(value)).toBeNull();
});
