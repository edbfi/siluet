import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { seedreamRoutes } from "../../shared/media-catalog/registry";
import {
	type ProviderConnectionStatus,
	type ProviderId,
	providerIds,
} from "../../shared/providers/connections";
import type { CredentialAccess } from "./image-credential-access";
import {
	type JobCredentialScope,
	jobCredentialAccess,
	jobsNeedCredential,
} from "./image-job-store";
import type { Installation } from "./installation";
import { issueGeneration, recordSnapshot } from "./inventory-store";
import { clearRefusals } from "./model-refusal";
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

function allowsCredential(access: CredentialAccess, provider: ProviderId, seedream: boolean) {
	if (access === "poyo-balance") return provider === "poyo";
	if (access === "toapis-video") return provider === "toapis";
	return seedream;
}

export function providerStore(installation: Installation) {
	const { directory, use } = installation;
	const revisionQuery = (id: ProviderId) =>
		sql`SELECT revision FROM provider_credential WHERE provider=${id}`;
	const verified = new Map<ProviderId, string>();
	async function inspectConnections() {
		const revisions = {
			seedream: new Map<ProviderId, number>(),
			"poyo-balance": new Map<ProviderId, number>(),
			"toapis-video": new Map<ProviderId, number>(),
		};
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
			const statuses = providerIds.map<ProviderConnectionStatus>((id) => ({
				id,
				state: "repair",
				hasCredential: rows.some((row) => row.provider === id),
			}));
			return { statuses, revisions };
		}

		const statuses = providerIds.map<ProviderConnectionStatus>((id) => {
			const row = rows.find((row) => row.provider === id);
			if (!row) return { id, state: "disconnected" };
			const verifiedAt = row.verified_at;
			const seedream = row.seedream === 1;
			try {
				if (key) {
					const data = associatedData(id, row.revision, verifiedAt, seedream);
					// Only reuse a successful authentication for the exact key, metadata and ciphertext.
					const fingerprint = createHmac("sha256", key)
						.update(data)
						.update(row.ciphertext)
						.digest("hex");
					if (verified.get(id) !== fingerprint) {
						decrypt(key, row.ciphertext, data).fill(0);
						verified.set(id, fingerprint);
					}
					if (seedream) revisions.seedream.set(id, row.revision);
					if (id === "poyo") revisions["poyo-balance"].set(id, row.revision);
					if (id === "toapis") revisions["toapis-video"].set(id, row.revision);
					return { id, state: "connected", verifiedAt, seedream };
				}
			} catch {
				// The credential is unreadable. Retain its row until reconnect or removal.
			}
			return { id, state: "reconnect" };
		});
		return { statuses, revisions };
	}

	return {
		revision(id: ProviderId) {
			return use(async (db) => {
				const row = await db.get<{ revision: number }>(revisionQuery(id));
				if (!row) throw new Error("Missing provider credential slot.");
				return row.revision;
			});
		},
		async credential(
			id: ProviderId,
			expectedRevision?: number,
			access: CredentialAccess = "seedream",
		) {
			const row = await use((db) =>
				db.get<{ revision: number; verified_at: number; ciphertext: string; seedream: number }>(
					sql`SELECT revision, verified_at, ciphertext, seedream FROM provider_credential
				    WHERE provider=${id} AND ciphertext IS NOT NULL`,
				),
			);
			if (
				!row ||
				!allowsCredential(access, id, row.seedream === 1) ||
				(expectedRevision !== undefined && expectedRevision !== row.revision)
			)
				return null;
			try {
				const key = await readProviderKey(directory);
				if (!key) return null;
				const clear = decrypt(
					key,
					row.ciphertext,
					associatedData(id, row.revision, row.verified_at, row.seedream === 1),
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
		async statuses() {
			return (await inspectConnections()).statuses;
		},
		async jobReadability() {
			const { revisions } = await inspectConnections();
			return (job: JobCredentialScope) =>
				revisions[jobCredentialAccess(job)].get(job.provider) === job.revision;
		},
		async save(
			id: ProviderId,
			credential: string,
			verifiedAt: number,
			seedream: boolean,
			expectedRevision: number,
			guardActiveJobs = false,
			/** The image listing a ToAPIs Connect read, recorded as the new revision's snapshot. */
			models?: readonly string[],
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
								if (
									guardActiveJobs &&
									(await tx.get(sql`SELECT 1 WHERE ${jobsNeedCredential(id, verifiedAt)}`))
								)
									return "job-warning" as const;
								if (!(await prepared.publishIfCurrent())) return null;
								const revision = expectedRevision + 1;
								const ciphertext = encrypt(
									prepared.key,
									credential,
									associatedData(id, revision, verifiedAt, seedream),
								);
								await tx.run(sql`UPDATE provider_credential SET revision=${revision}, ciphertext=${ciphertext},
									verified_at=${verifiedAt}, seedream=${Number(seedream)} WHERE provider=${id}`);
								// A new key revision clears the refusals recorded against the old one.
								await clearRefusals(tx, id, revision);
								if (id === "toapis" && models)
									await recordSnapshot(tx, {
										origin: seedreamRoutes.toapis.origin,
										scope: "image",
										revision,
										generation: await issueGeneration(tx, seedreamRoutes.toapis.origin, "image"),
										checkedAt: verifiedAt,
										result: { outcome: "succeeded", models },
									});
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
		remove(id: ProviderId, guardActiveJobs = false, now = Date.now()) {
			const guard = guardActiveJobs ? sql`AND NOT ${jobsNeedCredential(id, now)}` : sql``;
			return use((db) =>
				db.transaction(
					async (tx) => {
						const changed =
							await tx.get(sql`UPDATE provider_credential SET revision=revision+1, ciphertext=NULL,
							verified_at=NULL, seedream=NULL WHERE provider=${id} ${guard} RETURNING revision`);
						if (!changed) return "job-warning" as const;
						// No refusal outlives the key it was recorded against.
						await tx.run(sql`DELETE FROM model_refusal WHERE provider=${id}`);
					},
					{ behavior: "immediate" },
				),
			);
		},
	};
}
