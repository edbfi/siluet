import { openInstallation } from "../../src/lib/server/db/installation";

try {
	const install = await openInstallation(
		process.argv[2],
		process.argv[3] === "recovery" ? "recovery" : "startup",
	);
	process.send?.("locked");
	process.on("message", async () => {
		await install.close();
		process.exit(0);
	});
} catch {
	process.exit(1);
}
