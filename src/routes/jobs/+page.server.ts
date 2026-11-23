import { error, fail, type RequestEvent } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends("studio:jobs");
	// Listing Gallery first records any missing file, so the jobs show it.
	await locals.studio.gallery.list();
	return { ...(await locals.studio.jobs.history()), now: Date.now() };
};

async function jobId({ request }: RequestEvent) {
	const id = (await request.formData()).get("id");
	if (typeof id !== "string" || !id || id.length > 128) error(400, "Invalid job.");
	return id;
}

export const actions = {
	lookup: async (event) => {
		const id = await jobId(event);
		await event.locals.studio.jobs.lookup(id);
		return { id, message: "Submission check finished. See the current job status." };
	},
	refresh: async (event) => {
		const id = await jobId(event);
		await event.locals.studio.jobs.refresh(id);
		return { id, message: "" };
	},
	download: async (event) => {
		const id = await jobId(event);
		// Retry download and Download again arm the job; the worker downloads in the background.
		if (await event.locals.studio.autoSave.retry(id)) return { id, message: "Download requested." };
		return fail(409, { id, message: "This result cannot be downloaded again now." });
	},
} satisfies Actions;
