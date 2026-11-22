import { error, fail, type RequestEvent } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends("studio:jobs");
	const [history, entries] = await Promise.all([
		locals.studio.jobs.history(),
		locals.studio.gallery.list(),
	]);
	return {
		...history,
		saved: entries.filter((entry) => entry.available).map((entry) => entry.jobId),
		now: Date.now(),
	};
};

async function jobId({ request }: RequestEvent) {
	const id = (await request.formData()).get("id");
	if (typeof id !== "string" || !id || id.length > 128) error(400, "Invalid job.");
	return id;
}

export const actions = {
	refresh: async (event) => {
		const id = await jobId(event);
		await event.locals.studio.jobs.refresh(id);
		return { id, message: "" };
	},
	save: async (event) => {
		const id = await jobId(event);
		if (await event.locals.studio.gallery.save(id)) return { id, message: "Saved to Gallery." };
		return fail(409, {
			id,
			message: "The image could not be saved. You can retry Save on this job.",
		});
	},
} satisfies Actions;
