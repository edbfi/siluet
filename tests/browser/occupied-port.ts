// Give the launcher an occupied first choice, then let the OS choose its retry.
import { launchStudio } from "../../scripts/start";

const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
let first = true;
try {
	process.exitCode = await launchStudio(process.env, undefined, async (hostname) => {
		if (first) {
			first = false;
			return Number(blocker.port);
		}
		const free = Bun.serve({ hostname, port: 0, fetch: () => new Response(null) });
		const port = Number(free.port);
		await free.stop(true);
		return port;
	});
} finally {
	await blocker.stop(true);
}
