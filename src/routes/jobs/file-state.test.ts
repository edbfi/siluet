import { expect, test } from "bun:test";
import { type FileSlot, fileStateLabel } from "./file-state.ts";

const slots = (...outcomes: FileSlot["outcome"][]) =>
	outcomes.map((outcome, index) => ({ position: [1, 3, 4][index], outcome }));

test("one file keeps its phase wording", () => {
	expect(fileStateLabel("uploaded", slots("stored"))).toBe("File uploaded · preparing edit");
	expect(fileStateLabel("uploading", slots("uploading"))).toBe("Uploading file");
	expect(fileStateLabel("edit-recorded", slots("stored"))).toBeNull();
});

test("several files are labelled from their slots", () => {
	expect(fileStateLabel("claimed", slots("unsent", "unsent", "unsent"))).toBe("Preparing upload");
	expect(fileStateLabel("uploading", slots("stored", "uploading", "unsent"))).toBe(
		"Uploading reference 3 · file 2 of 3",
	);
	expect(fileStateLabel("uploaded", slots("stored", "stored", "unsent"))).toBe(
		"2 of 3 files uploaded",
	);
	expect(fileStateLabel("uploaded", slots("stored", "stored", "stored"))).toBe(
		"3 files uploaded · preparing edit",
	);
	expect(fileStateLabel("stored", slots("stored", "stored", "unsent"))).toBe(
		"2 of 3 files uploaded · edit not sent",
	);
	expect(fileStateLabel("stored", slots("stored", "unusable", "unsent"))).toBe(
		"2 of 3 files uploaded · edit not sent",
	);
	expect(fileStateLabel("editing", slots("stored", "stored", "stored"))).toBe("Submitting edit");
});
