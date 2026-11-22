import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import encodeQR from "qr";

function profile(seed: Buffer, label?: string) {
	return new TOTP({
		secret: new Secret({ buffer: Uint8Array.from(seed).buffer }),
		issuer: "Siluet",
		label: label ?? "Owner",
		algorithm: "SHA1",
		digits: 6,
		period: 30,
	});
}
export function setupMaterial(seed: Buffer, installation: string) {
	const totp = profile(seed, installation.slice(0, 8));
	return { manual: totp.secret.base32, qr: encodeQR(totp.toString(), "data-url") };
}
export function checkStep(seed: Buffer, value: string, now: number, used: number) {
	if (!/^[0-9]{6}$/.test(value) || value.length !== 6) return null;
	const totp = profile(seed);
	const step = Math.floor(now / 30000);
	const actual = Buffer.from(value);
	const matches = [step - 1, step, step + 1].filter(
		(s) => s >= 0 && timingSafeEqual(Buffer.from(totp.generate({ timestamp: s * 30000 })), actual),
	);
	return matches.length === 1 && matches[0] > used ? matches[0] : null;
}
export function recoveryDigest(installation: string, set: string, value: string) {
	if (
		!/^(?:[0-9a-f]{32}|[0-9a-f]{4}(?:-[0-9a-f]{4}){7})$/i.test(value) ||
		![32, 39].includes(value.length)
	)
		return null;
	return createHash("sha256")
		.update(
			["siluet/recovery/1", installation, set, value.replaceAll("-", "").toUpperCase()].join("\0"),
		)
		.digest("hex");
}
export function makeRecoverySet(installation: string) {
	const id = crypto.randomUUID();
	const codes = Array.from({ length: 10 }, () =>
		randomBytes(16)
			.toString("hex")
			.toUpperCase()
			.replace(/(.{4})(?=.)/g, "$1-"),
	);
	const digests = codes.map((code) => {
		const digest = recoveryDigest(installation, id, code);
		if (!digest) throw new Error("Invalid recovery code encoding.");
		return digest;
	});
	return { id, codes, digests };
}
