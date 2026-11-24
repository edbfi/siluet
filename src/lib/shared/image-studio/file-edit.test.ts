import { expect, test } from "bun:test";
import { fileLimitMessage } from "./file-edit";

test("an over-limit answer names the refusing provider and suggests ToAPIs only after Poyo.ai", () => {
	expect(
		fileLimitMessage({ provider: "poyo", limit: 10_000_000, size: 11_500_000 }, "cleaned copy"),
	).toBe(
		"Poyo.ai accepts files up to 10.0 MB; this cleaned copy is 11.5 MB. Choose ToAPIs or export a smaller image.",
	);
	expect(
		fileLimitMessage({ provider: "toapis", limit: 30_000_000, size: 31_000_000 }, "file"),
	).toBe("ToAPIs accepts files up to 30.0 MB; this file is 31.0 MB. Export a smaller image.");
	for (const answer of [null, {}, { provider: "other", limit: 1, size: 2 }, { provider: "poyo" }])
		expect(fileLimitMessage(answer, "file")).toBe("The file is too large for this provider.");
});
