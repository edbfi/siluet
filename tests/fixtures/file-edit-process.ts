import { sql } from "drizzle-orm";
import {
	claimFileSlots,
	fileAttemptStore,
	startFileEdit,
	startFileUpload,
} from "../../src/lib/server/db/file-attempt";
import { imageJobStore } from "../../src/lib/server/db/image-job-store";
import { openRuntimeInstallation } from "../../src/lib/server/db/runtime-installation";

// A three-file job (file, URL, file, file) stopped at `cut`: `claimed`, `uploading:<slot>`,
// `uploaded:<slot>`, `editing` or `accepted`.
const [root, cut] = process.argv.slice(2);
const fileProcessSlots = [1, 3, 4];
const installation = await openRuntimeInstallation(root);
const phases = fileAttemptStore(installation, "prior");
const jobs = imageJobStore(installation);
await installation.use((db) =>
	db.transaction(async (tx) => {
		await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase)
 VALUES('job','binding','poyo',1,'{}','submitting','seedream-5.5',0,120000,'prior','claimed')`);
		await claimFileSlots(tx, "job", fileProcessSlots, 4);
	}),
);
await jobs.beginDispatch("job", "poyo", 0, "prior");
const steps = [
	"claimed",
	...fileProcessSlots.flatMap((slot) => [`uploading:${slot}`, `uploaded:${slot}`]),
	"editing",
	"accepted",
];
let time = 1;
for (const step of steps.slice(1, steps.indexOf(cut) + 1)) {
	const [kind, slot] = step.split(":");
	time++;
	if (kind === "uploading")
		await installation.use((db) =>
			db.transaction((tx) => startFileUpload(tx, "job", "prior", Number(slot), time)),
		);
	if (kind === "uploaded") await phases.stored("job", Number(slot), time);
	if (kind === "editing")
		await installation.use((db) => db.transaction((tx) => startFileEdit(tx, "job", "prior", time)));
	if (kind === "accepted")
		await jobs.recordSubmission(
			"job",
			{ kind: "accepted", taskId: "accepted-id" },
			time,
			2000,
			0,
			"prior",
		);
}
console.log("durable");
setInterval(() => {}, 60000);
