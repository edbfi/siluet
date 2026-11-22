import { expect, test } from "bun:test";
import { duplicateReferenceSlots } from "./references";

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
