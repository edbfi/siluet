import { createHash, randomBytes } from "node:crypto";
import { AccessError } from "./access-error";
export const token = () => randomBytes(32).toString("base64url");
export const sessionDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string) {
	if (Buffer.byteLength(password) > 1024 || Array.from(password).length < 15)
		throw new AccessError(
			"Use at least 15 characters and at most 1024 bytes for your password.",
			400,
		);
	return Bun.password.hash(password, { algorithm: "argon2id" });
}
