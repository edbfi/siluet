import { expect, test } from "bun:test";
import { interpretPoyoUpload } from "./poyo/upload";
import { interpretToapisUpload } from "./toapis/upload";

const file = { mime: "image/png" as const, size: 12 };
const url = "https://images.storage.net/A%2fb?sig=private";
for (const provider of ["poyo", "toapis"] as const) {
	const poyo = provider === "poyo";
	const interpret = poyo ? interpretPoyoUpload : interpretToapisUpload;
	const data = poyo
		? { file_id: "abc", file_url: url, file_size: 12, mime_type: file.mime }
		: { id: "abc", url, size: 12, mime_type: file.mime };
	const good = { success: true, ...(poyo ? { code: 200 } : {}), data };
	test(`${provider} only accepts consistent storage with a usable exact URL`, () => {
		expect(interpret(200, good, file)).toEqual({ kind: "ready", url });
		for (const [field, value] of [
			[poyo ? "file_size" : "size", 11],
			["mime_type", "image/jpeg"],
			[poyo ? "file_url" : "url", "http://host.net/a"],
			[poyo ? "file_url" : "url", url + "x".repeat(8192)],
		]) {
			expect(interpret(200, { ...good, data: { ...data, [String(field)]: value } }, file)).toEqual({
				kind: "stored",
			});
		}
		expect(
			interpret(200, { ...good, data: { ...data, expires_at: "2000-01-01T00:00:00Z" } }, file),
		).toEqual({ kind: "stored", reason: "expired-link" });
		expect(
			interpret(200, { ...good, data: { ...data, expires_at: "2000-01-01T00:00:00" } }, file),
		).toEqual({ kind: "ready", url });
		const expires = "2099-03-04T12:00:00+02:00";
		expect(interpret(200, { ...good, data: { ...data, expires_at: expires } }, file)).toEqual({
			kind: "ready",
			url,
			expiresAt: Date.parse(expires),
		});
		for (const status of [400, 404, 408, 429, 500])
			expect(interpret(status, good, file)).toEqual({ kind: "unknown" });
		expect(interpret(400, { ...good, success: false }, file)).toEqual({ kind: "unknown" });
		expect(interpret(400, { success: false, ...(poyo ? { code: 400 } : {}) }, file)).toEqual({
			kind: "rejected",
			reason: "validation",
		});
	});
}
test("upload-specific errors preserve uncertain outcomes", () => {
	expect(interpretPoyoUpload(402, { detail: "private" }, file)).toEqual({ kind: "unknown" });
	expect(interpretPoyoUpload(402, { success: false, code: 402 }, file)).toEqual({
		kind: "rejected",
		reason: "quota",
	});
	expect(
		interpretPoyoUpload(
			422,
			{ detail: [{ loc: ["body", "file"], msg: "fixture", type: "value_error" }] },
			file,
		),
	).toEqual({
		kind: "rejected",
		reason: "validation",
	});
	expect(
		interpretToapisUpload(
			400,
			{ success: false, error: { code: "read_request_body_failed" } },
			file,
		),
	).toEqual({ kind: "unknown" });
});
