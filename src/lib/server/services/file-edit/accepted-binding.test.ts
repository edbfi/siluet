import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { filePlaceholder } from "../../../shared/image-studio/file-edit";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { acceptedFileBinding, r1bReviewSignature } from "./accepted-binding";
import { parseFileRequest } from "./request";

const key = Buffer.alloc(32, 7);
const mac = (...parts: unknown[]) =>
	createHmac("sha256", key).update(JSON.stringify(parts)).digest("hex");
const stage = {
	draft: "11111111-1111-4111-8111-111111111111",
	handle: "22222222-2222-4222-8222-222222222222",
	digest: "a".repeat(64),
	size: 10,
	mime: "image/png",
	transform: "none",
	deadline: 1000,
};
const token = "file2.33333333-3333-4333-8333-333333333333.t.s";
const r1bBody = {
	draft: {
		...createSeedreamDraft("poyo", "edit"),
		prompt: "Draw a peaceful meadow",
		references: [{ kind: "upload", url: filePlaceholder }],
	},
	stage,
	count: 1,
	retryLimit: 0,
	acceptUnknown: true,
	token,
};

test("an R1b body keeps the exact binding and first-use signature R1b computed", () => {
	const live = parseFileRequest(r1bBody);
	if (!live || "error" in live) throw new Error("Expected an R1b request.");
	// Computed by 446f584's accepted-binding.ts and queue.ts `signature` for this body.
	expect(acceptedFileBinding(mac, "creator", token, live)).toBe(
		"7d8196c833b823bef86bcd9498595b5184d42c67ca0ca8ab216fd92f0953baa4",
	);
	expect(
		r1bReviewSignature(
			mac,
			"33333333-3333-4333-8333-333333333333",
			"t".repeat(64),
			"creator",
			"session-digest",
			live,
		),
	).toBe("cab257f4cea4a40a5c272d51a6ef69aee0d287590ce9a4ed4abfc869dce32d50");
});

test("a version 3 binding signs every slot in order, each file with its own draft", () => {
	const other = {
		...stage,
		draft: "44444444-4444-4444-8444-444444444444",
		handle: "55555555-5555-4555-8555-555555555555",
		digest: "b".repeat(64),
	};
	const body = (references: unknown[]) => ({
		draft: { ...r1bBody.draft, references },
		count: 1,
		retryLimit: 0,
		acceptUnknown: true,
	});
	const url = { kind: "url", url: "https://images.example.com/b.png" };
	const a = parseFileRequest(body([{ kind: "file", stage }, url, { kind: "file", stage: other }]));
	const b = parseFileRequest(body([{ kind: "file", stage: other }, url, { kind: "file", stage }]));
	if (!a || "error" in a || !b || "error" in b) throw new Error("Expected requests.");
	const v3 = "file3.33333333-3333-4333-8333-333333333333.t.s";
	expect(acceptedFileBinding(mac, "creator", v3, a)).not.toBe(
		acceptedFileBinding(mac, "creator", v3, b),
	);
	expect(acceptedFileBinding(mac, "creator", v3, a)).not.toBe(
		acceptedFileBinding(mac, "creator", v3, { ...a, acceptUnknown: false }),
	);
});
