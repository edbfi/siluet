import { describe, expect, test } from "bun:test";
import {
	fromBase64Url,
	type KeyMessage,
	keyMessage,
	toBase64Url,
} from "../../../shared/owner/key-message";
import { importBrowserKey, verifyKeySignature } from "./browser-key";

// Authored for this test with WebCrypto: a P-256 public key and its signature over `message`.
const spki =
	"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEChU1MCMmvryn6usIhEz-EOK8-ecjZG4W0oOPFKZQ-yf2YmfIvXmtai-80VebhQJZQDolw-aNazu2d7MEnRwb5g";
const signature =
	"SAhDytB2TG7bFPAnZEEnAHUKFOfHg2hQMOlKSeE8w_88AkDXzXKaPwgbuozZHxW3A_WxnNXsG2ibJ2-TaCsemw";
const p384 =
	"MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8JyAk5xj2wN_UpFAG4s66nz5onrlkNHNEp6m5GapgwdWu1702srxpHtQTe1klw3m_kE-YMtQsEAS0tRbp6Y-OjO2pWmEXdCXF5zoDvkjYxpC0HVtXIBIrimGVQ0kldZ_";
const message: KeyMessage = {
	purpose: "resume",
	origin: "http://127.0.0.1:3000",
	installation: "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f",
	binding: spki,
	nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
};

describe("the signed message", () => {
	test("joins its fields with LF under the version line", () => {
		expect(new TextDecoder().decode(keyMessage({ ...message, binding: "" }))).toBe(
			`siluet-browser-key/1\nresume\nhttp://127.0.0.1:3000\n${message.installation}\n\n${message.nonce}`,
		);
	});
	test("base64url has one spelling per byte string", () => {
		const bytes = Uint8Array.from({ length: 33 }, (_, i) => i * 7);
		for (const length of [0, 1, 2, 3, 32, 33]) {
			const slice = bytes.slice(0, length);
			expect(fromBase64Url(toBase64Url(slice))).toEqual(slice);
		}
		expect(fromBase64Url("AB")).toBeNull(); // nonzero trailing bits
		expect(fromBase64Url("AA==")).toBeNull();
		expect(fromBase64Url("A")).toBeNull();
		expect(fromBase64Url("AA+/")).toBeNull();
		expect(fromBase64Url(7)).toBeNull();
	});
});

describe("verifyKeySignature", () => {
	test("accepts the authored vector", async () => {
		expect(await verifyKeySignature(spki, signature, message)).toBe(true);
	});

	test("refuses each tampered field", async () => {
		for (const changed of [
			{ purpose: "sign-out" as const },
			{ origin: "http://127.0.0.1:3001" },
			{ origin: "http://[::1]:3000" },
			{ installation: "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e50" },
			{ binding: "" },
			{ nonce: "AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" },
		])
			expect(await verifyKeySignature(spki, signature, { ...message, ...changed })).toBe(false);
		const flipped = fromBase64Url(signature) as Uint8Array;
		flipped[10] ^= 1;
		expect(await verifyKeySignature(spki, toBase64Url(flipped), message)).toBe(false);
	});

	test("takes only 64-byte P1363 signatures", async () => {
		const raw = fromBase64Url(signature) as Uint8Array;
		expect(await verifyKeySignature(spki, toBase64Url(raw.slice(0, 63)), message)).toBe(false);
		expect(await verifyKeySignature(spki, toBase64Url(Uint8Array.of(...raw, 0)), message)).toBe(
			false,
		);
		// The same signature in DER (SEQUENCE of two INTEGERs) is refused.
		const integer = (half: Uint8Array) => {
			let value = Array.from(half);
			while (value.length > 1 && value[0] === 0 && value[1] < 128) value = value.slice(1);
			if (value[0] >= 128) value = [0, ...value];
			return [2, value.length, ...value];
		};
		const body = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
		const der = Uint8Array.of(48, body.length, ...body);
		expect(await verifyKeySignature(spki, toBase64Url(der), message)).toBe(false);
	});

	test("takes only a canonical P-256 SPKI", async () => {
		expect(await importBrowserKey(spki)).not.toBeNull();
		expect(await importBrowserKey(p384)).toBeNull();
		expect(await verifyKeySignature(p384, signature, message)).toBe(false);
		const der = fromBase64Url(spki) as Uint8Array;
		expect(await importBrowserKey(toBase64Url(der.slice(0, 90)))).toBeNull();
		const broken = Uint8Array.from(der);
		broken[30] ^= 0xff; // a point off the curve
		expect(await importBrowserKey(toBase64Url(broken))).toBeNull();
		// The compressed encoding of the same point is a different spelling.
		const point = der.slice(26);
		const compressed = Uint8Array.of(
			...der.slice(0, 26),
			2 + (point[64] & 1),
			...point.slice(1, 33),
		);
		expect(await importBrowserKey(toBase64Url(compressed))).toBeNull();
		expect(await importBrowserKey(`${spki}=`)).toBeNull();
		expect(await importBrowserKey(undefined)).toBeNull();
	});

	test("verifies a fresh non-extractable browser key", async () => {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
			"sign",
			"verify",
		]);
		const fresh = toBase64Url(
			new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
		);
		const signed = { ...message, binding: fresh };
		const bytes = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			keyMessage(signed),
		);
		expect(await verifyKeySignature(fresh, toBase64Url(new Uint8Array(bytes)), signed)).toBe(true);
		expect(await verifyKeySignature(spki, toBase64Url(new Uint8Array(bytes)), signed)).toBe(false);
	});
});
