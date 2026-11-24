import { expect, test } from "bun:test";
import {
	fileDisclosure,
	fileLimitMessage,
	notCleanedLead,
	originalRotationNote,
} from "./file-edit";

test("an over-limit answer names the refusing provider and suggests ToAPIs only after Poyo.ai", () => {
	expect(
		fileLimitMessage({ provider: "poyo", limit: 10_000_000, size: 11_500_000 }, "cleaned copy"),
	).toBe(
		"Poyo.ai accepts files up to 10.0 MB; this cleaned copy is 11.5 MB. Choose ToAPIs or export a smaller image.",
	);
	expect(
		fileLimitMessage({ provider: "toapis", limit: 30_000_000, size: 31_000_000 }, "file"),
	).toBe("ToAPIs accepts files up to 30.0 MB; this file is 31.0 MB. Export a smaller image.");
	expect(
		fileLimitMessage(
			{ provider: "poyo", limit: 10_000_000, size: 11_000_000, position: 3 },
			"file",
		),
	).toBe(
		"Poyo.ai accepts files up to 10.0 MB; the file in reference 3 is 11.0 MB. Choose ToAPIs or export a smaller image.",
	);
	for (const answer of [null, {}, { provider: "other", limit: 1, size: 2 }, { provider: "poyo" }])
		expect(fileLimitMessage(answer, "file")).toBe("The file is too large for this provider.");
});

test("Review names each slot's preparation, the rotation note's slots and the Poyo.ai window", () => {
	const cleaned = fileDisclosure("poyo", [
		{ position: 1, transform: "none", rotated: false },
		{ position: 3, transform: "reencoded-rotation", rotated: false },
	]);
	expect(cleaned).toContain(
		"Poyo.ai allows ten uploads per account in any 60 seconds, shared by every key and signed-in session. Other activity on the account can throttle a later file and leave earlier copies hosted.",
	);
	expect(cleaned.join(" ")).toContain("up to 3 potentially billable requests");
	expect(cleaned.join(" ")).toContain("re-encoded the JPEG of reference 3 once at quality 95");
	expect(cleaned.some((line) => line.startsWith(notCleanedLead))).toBeFalse();
	const originals = fileDisclosure("toapis", [
		{ position: 2, transform: "original", rotated: true },
		{ position: 4, transform: "original", rotated: false },
		{ position: 5, transform: "original", rotated: true },
	]);
	expect(originals).toContain(
		`${notCleanedLead} Metadata removal is off in Settings, so Siluet sends references 2, 4 and 5 to ToAPIs unchanged, including any location, camera, authorship or AI-source metadata.`,
	);
	expect(originals).toContain(`${originalRotationNote} This applies to references 2 and 5.`);
	expect(originals.join(" ")).not.toContain("ten uploads");
	// One file keeps the single-file words.
	const single = fileDisclosure("poyo", [{ position: 1, transform: "original", rotated: true }]);
	expect(single).toContain(originalRotationNote);
	expect(single.join(" ")).toContain("Siluet sends this file to Poyo.ai unchanged");
	expect(single.join(" ")).not.toContain("ten uploads");
});
