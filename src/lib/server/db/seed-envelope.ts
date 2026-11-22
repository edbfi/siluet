import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyViolation } from "./factor-key";

export function sealSeed(key: Buffer, seed: Buffer, installation: string, id: string) {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify([1, installation, 1, id])));
	return Buffer.concat([nonce, cipher.update(seed), cipher.final(), cipher.getAuthTag()]).toString(
		"base64",
	);
}
export function openSeed(key: Buffer, envelope: string, installation: string, id: string) {
	try {
		const bytes = Buffer.from(envelope, "base64");
		if (bytes.length !== 48 || bytes.toString("base64") !== envelope) throw new KeyViolation();
		const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
		decipher.setAAD(Buffer.from(JSON.stringify([1, installation, 1, id])));
		decipher.setAuthTag(bytes.subarray(32));
		return Buffer.concat([decipher.update(bytes.subarray(12, 32)), decipher.final()]);
	} catch {
		throw new KeyViolation();
	}
}
