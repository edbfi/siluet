// Confirmed per-model permission refusals (catalog engine spec, "Access refusals"). A Poyo.ai
// image 403 `permission_denied_error` refuses one job and keeps the saved key. Siluet keeps the
// refusal once per provider, model and credential revision, and Review shows it with its date.
// A new credential revision clears it.
import { sql } from "drizzle-orm";
import type { ProviderId } from "../../shared/providers/connections";
import type { Installation, InstallationTransaction } from "./installation";

/**
 * Records a job's refusal, only while the job's credential revision is still the saved one: a
 * refusal against a superseded key writes nothing.
 */
export async function recordRefusal(tx: InstallationTransaction, jobId: string, now: number) {
	await tx.run(sql`INSERT OR REPLACE INTO model_refusal(provider,model,credential_revision,refused_at,job_id)
		SELECT j.provider, j.model, j.revision, ${now}, j.id FROM image_job j
		JOIN provider_credential c ON c.provider=j.provider AND c.revision=j.revision AND c.ciphertext IS NOT NULL
		WHERE j.id=${jobId}`);
}

/** Clears every refusal recorded against another revision of a provider's key. */
export async function clearRefusals(
	tx: InstallationTransaction,
	provider: ProviderId,
	revision: number,
) {
	await tx.run(
		sql`DELETE FROM model_refusal WHERE provider=${provider} AND credential_revision<>${revision}`,
	);
}

export type ModelRefusal = { model: string; refusedAt: number };

export function modelRefusals(installation: Installation) {
	return {
		/** The refusals recorded for the provider's current key, by model. */
		current: (provider: ProviderId) =>
			installation.use((db) =>
				db.all<ModelRefusal>(sql`SELECT r.model AS model, r.refused_at AS refusedAt FROM model_refusal r
					JOIN provider_credential c ON c.provider=r.provider AND c.revision=r.credential_revision
					WHERE r.provider=${provider} AND c.ciphertext IS NOT NULL ORDER BY r.model`),
			),
	};
}
