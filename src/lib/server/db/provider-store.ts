import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	type ProviderConnectionStatus,
	type ProviderId,
	providerIds,
} from "../../shared/providers/connections";
import type { Installation } from "./installation";
import { ProviderKeyPolicyError, prepareProviderKey, readProviderKey } from "./provider-key";

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

function decrypt(key: Buffer, encoded: string, data: Buffer) {
	const payload = Buffer.from(encoded, "base64");
	if (payload.length <= nonceSize + tagSize) throw new Error("Invalid stored credential.");
	const decipher = createDecipheriv(algorithm, key, payload.subarray(0, nonceSize), {
		authTagLength: tagSize,
	});
	decipher.setAAD(data);
	decipher.setAuthTag(payload.subarray(nonceSize, nonceSize + tagSize));
	const clear = decipher.update(payload.subarray(nonceSize + tagSize));
	try {
		decipher.final();
		return clear;
	} catch (error) {
		clear.fill(0);
		throw error;
	}
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
		async credential(id: ProviderId, expectedRevision?: number) {
			const row = await use((db) =>
				db.get<{ revision: number; verified_at: number; ciphertext: string }>(
					sql`SELECT revision, verified_at,ciphertext FROM provider_credential
				    WHERE provider=${id} AND seedream=1 AND ciphertext IS NOT NULL`,
				),
			);
			if (!row || (expectedRevision !== undefined && expectedRevision !== row.revision))
				return null;
			try {
				const key = await readProviderKey(directory);
				if (!key) return null;
				const clear = decrypt(
					key,
					row.ciphertext,
					associatedData(id, row.revision, row.verified_at, true),
				);
				try {
					return { revision: row.revision, key: clear.toString("utf8") };
				} finally {
					clear.fill(0);
				}
			} catch {
				return null;
			}
		},
		async checkKeyStorage() {
			await readProviderKey(directory);
		},
		async statuses(): Promise<ProviderConnectionStatus[]> {
			const rows = await use((db) =>
				db.all<{
					provider: ProviderId;
					revision: number;
					ciphertext: string;
					verified_at: number;
					seedream: number;
				}>(sql`SELECT provider, revision, ciphertext, verified_at, seedream
					FROM provider_credential WHERE ciphertext IS NOT NULL`),
			);

			let key: Buffer | null;
			try {
				key = await readProviderKey(directory);
			} catch (error) {
				if (!(error instanceof ProviderKeyPolicyError)) throw error;
				return providerIds.map((id) => ({
					id,
					state: "repair",
					hasCredential: rows.some((row) => row.provider === id),
				}));
			}

			return providerIds.map((id) => {
				const row = rows.find((row) => row.provider === id);
				if (!row) return { id, state: "disconnected" };
				const verifiedAt = row.verified_at;
				const seedream = row.seedream === 1;
				try {
					if (key) {
						decrypt(
							key,
							row.ciphertext,
							associatedData(id, row.revision, verifiedAt, seedream),
						).fill(0);
						return { id, state: "connected", verifiedAt, seedream };
					}
				} catch {
					// The credential is unreadable. Retain its row until reconnect or removal.
				}
				return { id, state: "reconnect" };
			});
		},
		async save(
			id: ProviderId,
			credential: string,
			verifiedAt: number,
			seedream: boolean,
			expectedRevision: number,
		) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const prepared = await prepareProviderKey(directory);
				try {
					const saved = await use((db) =>
						db.transaction(
							async (tx) => {
								// Removal and replacement advance the revision, including across handles.
								const row = await tx.get<{ revision: number }>(revisionQuery(id));
								if (row?.revision !== expectedRevision) return false;
								if (!(await prepared.publishIfCurrent())) return null;
								const revision = expectedRevision + 1;
								const ciphertext = encrypt(
									prepared.key,
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
					if (saved !== null) return saved;
				} finally {
					await prepared.discard();
				}
			}
			throw new Error("The provider key changed during both save attempts.");
		},
		remove(id: ProviderId) {
			return use(async (db) => {
				await db.run(sql`UPDATE provider_credential SET revision=revision+1, ciphertext=NULL,
					verified_at=NULL, seedream=NULL WHERE provider=${id}`);
			});
		},
	};
}
