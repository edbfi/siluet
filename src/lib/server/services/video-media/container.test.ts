import { expect, test } from "bun:test";
import { refuseEbml } from "./container";
import { TruncatedVideoError, UnsupportedVideoError } from "./errors";

// EBML header: ID 1A45DFA3, then EBMLVersion (4286) and DocType (4282) children.
function ebml(docType: string) {
	const type = Buffer.from(docType, "latin1");
	const children = Buffer.concat([
		Buffer.from([0x42, 0x86, 0x81, 0x01]),
		Buffer.from([0x42, 0x82, 0x80 | type.length]),
		type,
	]);
	return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | children.length]), children]);
}
function refusal(head: Buffer, size = head.length + 1_000_000) {
	try {
		refuseEbml(head, size);
	} catch (error) {
		return error;
	}
	return null;
}

test("WebM and Matroska headers get their own reason", () => {
	for (const type of ["webm", "matroska"]) {
		const error = refusal(ebml(type));
		expect(error).toBeInstanceOf(UnsupportedVideoError);
		expect((error as UnsupportedVideoError).reason).toBe("webm");
	}
});

test("other EBML documents are unsupported and short EBML files are truncated", () => {
	expect((refusal(ebml("other")) as UnsupportedVideoError).reason).toBe("profile");
	const head = ebml("webm").subarray(0, 9);
	expect(refusal(head, head.length)).toBeInstanceOf(TruncatedVideoError);
	expect(refusal(head)).toBeInstanceOf(UnsupportedVideoError);
});

test("MP4 and other files pass through", () => {
	expect(refusal(Buffer.from("\0\0\0\x20ftypisom", "latin1"))).toBeNull();
	expect(refusal(Buffer.alloc(2))).toBeNull();
});
