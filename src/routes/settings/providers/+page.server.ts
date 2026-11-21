import { error, fail, type RequestEvent } from "@sveltejs/kit";
import { providerIds, providerStorageRepairMessage } from "#lib/shared/providers/connections.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	const connections = await locals.studio.providers.statuses();
	const providers = await Promise.all(
		connections.map(async (connection) => ({
			...connection,
			neededByJobs: await locals.studio.jobs.needsCredential(connection.id),
		})),
	);
	return { providers };
};

const messages = {
	"job-warning": {
		status: 409,
		message: "Jobs now need this key. Review the warning before changing the connection.",
	},
	connected: { message: "Key accepted and saved." },
	removed: { message: "Key removed." },
	rejected: { status: 422, message: "The provider rejected this key." },
	unavailable: { status: 503, message: "The provider check is unavailable. Try again later." },
	"rate-limited": {
		status: 429,
		message: "Too many checks for this provider. Try again in a minute.",
	},
	invalid: { status: 400, message: "Enter a valid API key." },
	busy: {
		status: 409,
		message: "A key check for this provider is in progress. Try again when it finishes.",
	},
	superseded: {
		status: 409,
		message: "The saved connection changed while this check was in progress.",
	},
	"storage-repair": {
		status: 409,
		message: providerStorageRepairMessage,
	},
	"storage-unavailable": {
		status: 503,
		message:
			"Siluet could not update the saved connection. Check access to the installation directory and try again.",
	},
} as const;

async function changeConnection(
	{ locals, request }: RequestEvent,
	operation: "connect" | "remove",
) {
	const data = await request.formData();
	const provider = providerIds.find((id) => id === data.get("provider"));
	if (!provider) error(400, "Unknown provider.");
	const warningSeen = data.get("jobWarning") === "seen";
	if (!warningSeen && (await locals.studio.jobs.needsCredential(provider))) {
		return fail(409, {
			provider,
			outcome: "job-warning" as const,
			message: messages["job-warning"].message,
		});
	}
	const connections = locals.studio.providers;
	const outcome =
		operation === "connect"
			? await connections.connect(provider, data.get("key"), warningSeen)
			: await connections.remove(provider, warningSeen);
	const result = messages[outcome];
	const feedback = { provider, outcome, message: result.message };
	return "status" in result ? fail(result.status, feedback) : feedback;
}

export const actions = {
	connect: (event) => changeConnection(event, "connect"),
	remove: (event) => changeConnection(event, "remove"),
} satisfies Actions;
