import { expect, test } from "bun:test";
import { uploadSlot } from "./upload-slot";

test("one file job at a time holds the upload sequence, and release is idempotent", () => {
	const slot = uploadSlot();
	const release = slot.take();
	if (!release) throw new Error("Expected the slot");
	expect(slot.take()).toBeNull();
	release();
	release();
	const again = slot.take();
	expect(again).toBeFunction();
	expect(slot.take()).toBeNull();
	// An earlier release never frees a later holder.
	release();
	expect(slot.take()).toBeNull();
});
