import { sql } from "drizzle-orm";
import { fileAttemptStore } from "../../src/lib/server/db/file-attempt";
import { imageJobStore } from "../../src/lib/server/db/image-job-store";
import { openRuntimeInstallation } from "../../src/lib/server/db/runtime-installation";

const [root, cut] = process.argv.slice(2);
const installation = await openRuntimeInstallation(root);
const phases = fileAttemptStore(installation, "prior");
const jobs = imageJobStore(installation);
await installation.use((db) =>
	db.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase)
 VALUES('job','binding','poyo',1,'{}','submitting','seedream-5.5',0,120000,'prior','claimed')`),
);
await jobs.beginDispatch("job", "poyo", 0, "prior");
const order = ["claimed", "uploading", "uploaded", "editing", "accepted"];
if (order.indexOf(cut) >= 1) await phases.advance("job", "claimed", 1);
if (order.indexOf(cut) >= 2) await phases.advance("job", "uploading", 2);
if (order.indexOf(cut) >= 3) await phases.advance("job", "uploaded", 3);
if (cut === "accepted")
	await jobs.recordSubmission(
		"job",
		{ kind: "accepted", taskId: "accepted-id" },
		4,
		2000,
		0,
		"prior",
	);
console.log("durable");
setInterval(() => {}, 60000);
