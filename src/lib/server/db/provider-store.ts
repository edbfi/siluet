import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ProviderConnectionStatus, ProviderId } from "../../shared/providers/connections";
import type { Installation } from "./installation";
import { ensureProviderKey, readProviderKey } from "./provider-key";

export { providerKeyFilename } from "./provider-key";

const algorithm = "aes-256-gcm";
const nonceSize = 12;
const tagSize = 16;

function associatedData(id: ProviderId, revision: number, verifiedAt: number, seedream: boolean) {
	return Buffer.from(
		JSON.stringify(["siluet-provider-credential-v1", id, revision, verifiedAt, seedream]),
	);
}

function encrypt(key: Buffer, credential: string, data: Buffer) {
	const nonce = randomBytes(nonceSize);
	const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: tagSize });
	cipher.setAAD(data);
	const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
	return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function canDecrypt(key: Buffer, encoded: string, data: Buffer) {
	const payload = Buffer.from(encoded, "base64");
	if (payload.length <= nonceSize + tagSize) return false;
	const decipher = createDecipheriv(algorithm, key, payload.subarray(0, nonceSize), {
		authTagLength: tagSize,
	});
	decipher.setAAD(data);
	decipher.setAuthTag(payload.subarray(nonceSize, nonceSize + tagSize));
	decipher.update(payload.subarray(nonceSize + tagSize)).fill(0);
	decipher.final().fill(0);
	return true;
}

export function providerStore(installation: Installation) {
	const { directory, use } = installation;
	const revisionQuery = (id: ProviderId) =>
		sql`SELECT revision FROM provider_credential WHERE provider=${id}`;
	return {
		revision(id: ProviderId) {
			return use(async (db) => {
				const row = await db.get<{ revision: number }>(revisionQuery(id));
				if (!row) throw new Error("Missing provider credential slot.");
				return row.revision;
			});
		},
		status(id: ProviderId): Promise<ProviderConnectionStatus> {
			return use(async (db) => {
				const row = await db.get<{
					revision: number;
					ciphertext: string;
					verified_at: number;
					seedream: number;
				}>(
					sql`SELECT revision, ciphertext, verified_at, seedream FROM provider_credential WHERE provider=${id} AND ciphertext IS NOT NULL`,
				);
				if (!row) return { id, state: "disconnected" };
				const verifiedAt = row.verified_at;
				const seedream = row.seedream === 1;
				try {
					const key = await readProviderKey(directory);
					if (
						key &&
						canDecrypt(key, row.ciphertext, associatedData(id, row.revision, verifiedAt, seedream))
					) {
						return { id, state: "connected", verifiedAt, seedream };
					}
				} catch {
					// The credential is unreadable. Retain its row until reconnect or removal.
				}
				return { id, state: "reconnect" };
			});
		},
		save(
			id: ProviderId,
			credential: string,
			verifiedAt: number,
			seedream: boolean,
			expectedRevision: number,
		) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						// A removal or accepted replacement may have finished during the provider read.
						const row = await tx.get<{ revision: number }>(revisionQuery(id));
						if (row?.revision !== expectedRevision) return false;
						const revision = expectedRevision + 1;
						const key = await ensureProviderKey(directory);
						const ciphertext = encrypt(
							key,
							credential,
							associatedData(id, revision, verifiedAt, seedream),
						);
						await tx.run(sql`UPDATE provider_credential SET revision=${revision}, ciphertext=${ciphertext},
							verified_at=${verifiedAt}, seedream=${Number(seedream)} WHERE provider=${id}`);
						return true;
					},
					{ behavior: "immediate" },
				),
			);
		},
		remove(id: ProviderId) {
			return use(async (db) => {
				await db.run(sql`UPDATE provider_credential SET revision=revision+1, ciphertext=NULL,
					verified_at=NULL, seedream=NULL WHERE provider=${id}`);
			});
		},
	};
}
