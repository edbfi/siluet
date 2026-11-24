import { expect, test } from "bun:test";
import { duplicateReferenceSlots, stageableReferences } from "./references";

const signed = "https://images.example.org/shot%2fa?sig=first&v=1&v=2#detail";
const distinct = "https://images.example.org/shot%2fa?sig=second&v=1&v=2#detail";
const remote = (url: string) => ({ kind: "url" as const, url, hostname: "images.example.org" });

test("reports the first repeated trimmed URL using its positions among all references", () => {
	const references = [
		remote(signed),
		{ kind: "file" as const, file: new File(["image"], "shot.png") },
		remote(distinct),
		remote(`  ${distinct}\t`),
		remote(signed),
	];
	expect(duplicateReferenceSlots(references)).toEqual([3, 4]);
	expect(references[3]).toEqual(remote(`  ${distinct}\t`));
});

test("keeps different signatures and URL spellings distinct even on the same host", () => {
	expect(
		duplicateReferenceSlots([
			remote(signed),
			remote(distinct),
			remote(signed.replace("%2f", "%2F")),
			remote(signed.replace("&v=1&v=2", "&v=2&v=1")),
			remote(signed.replace("#detail", "#other")),
		]),
	).toBeNull();
});

test("stages every local JPEG or PNG in order, unless another file keeps the draft offline", () => {
	const local = (name: string, type: string) => ({
		kind: "file" as const,
		file: new File(["image"], name, { type }),
	});
	const png = local("shot.png", "image/png");
	const jpeg = local("shot.JPEG", "");
	const generic = local("shot.jpg", "application/octet-stream");
	expect(stageableReferences([png])).toEqual([{ position: 1, file: png.file }]);
	expect(stageableReferences([jpeg, remote(signed), generic])).toEqual([
		{ position: 1, file: jpeg.file },
		{ position: 3, file: generic.file },
	]);
	// The same file twice stays visible: the duplicate refusal names both positions.
	expect(stageableReferences([png, png])).toEqual([
		{ position: 1, file: png.file },
		{ position: 2, file: png.file },
	]);
	for (const other of [
		local("shot.webp", "image/webp"),
		local("shot.png", "image/webp"),
		local("shot.gif", ""),
	]) {
		expect(stageableReferences([other])).toBeNull();
		expect(stageableReferences([png, other])).toBeNull();
	}
	expect(stageableReferences([remote(signed)])).toBeNull();
	expect(stageableReferences([])).toBeNull();
});

test("the same attached file in two slots is a duplicate", () => {
	const shared = { kind: "file" as const, file: new File(["image"], "a.png") };
	expect(
		duplicateReferenceSlots([shared, { kind: "file", file: new File(["image"], "a.png") }]),
	).toBeNull();
	expect(duplicateReferenceSlots([remote(signed), shared, shared])).toEqual([2, 3]);
});
