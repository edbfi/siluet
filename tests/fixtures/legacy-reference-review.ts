import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { openInstallation } from "../../src/lib/server/db/installation";
import { loadStudioPricingFeeds } from "../../src/lib/server/services/pricing/local-feed";

const previousDisclosure = [
	"Queue sends ToAPIs your prompt and full reference URL, including its path, query with any signature, and fragment. ToAPIs and its upstream model services may process these inputs and fetch the image, including through a fallback for eligible accounts and regions.",
	"Keep the image reachable through processing without cookies or extra headers. A signed link may grant access until expiry. A recipient can keep a copy it has already fetched, even after the link expires.",
	"ToAPIs keeps API call logs for 90 days by default. Retention of submitted URLs and fetched reference images is unspecified.",
];

/** Seed the single-reference slice's durable claim and an equally old unused token. */
export async function seedLegacyToapisReviews(
	directory: string,
	cacheHome: string,
	quote: unknown,
	body: unknown,
) {
	const now = Date.now();
	const { toapis: feed } = await loadStudioPricingFeeds(now, cacheHome);
	const installation = await openInstallation(directory);
	try {
		return await installation.use(async (db) => {
			const settings = await db.get<{ secret: string; owner: string; revision: number }>(
				sql`SELECT (SELECT secret FROM image_review_key WHERE singleton=1) AS secret,
					(SELECT username FROM owner WHERE id=1) AS owner, revision
					FROM provider_credential WHERE provider='toapis'`,
			);
			if (!settings || !feed) throw new Error("Missing legacy Review fixture settings.");
			const digest = (...parts: unknown[]) =>
				createHmac("sha256", Buffer.from(settings.secret, "hex"))
					.update(JSON.stringify(parts))
					.digest("hex");
			const terms = digest(
				"edit-review-terms-v1",
				settings.revision,
				quote,
				true,
				feed,
				previousDisclosure,
			);
			const issue = () => {
				const id = crypto.randomUUID();
				const signed = digest(
					"edit-review-v1",
					id,
					terms,
					settings.owner,
					"toapis",
					"POST",
					"https://toapis.com/v1/images/generations",
					body,
					1,
					0,
				);
				return {
					id,
					token: `${id}.${terms}.${signed}`,
					binding: digest("accepted-v1", signed, true),
				};
			};
			const accepted = issue();
			await db.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,model,created_at,poll_deadline,task_id,submission_recorded_at,failure_reason)
				VALUES(${accepted.id},${accepted.binding},'toapis',${settings.revision},${JSON.stringify(quote)},1,'failed','doubao-seedream-5-5',${now},${now + 120_000},'legacy-reference-task',${now},'reference_media_unreadable')`);
			return { acceptedId: accepted.id, acceptedToken: accepted.token, unusedToken: issue().token };
		});
	} finally {
		await installation.close();
	}
}
