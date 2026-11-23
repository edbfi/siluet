// Let a test stop the launcher over IPC without signalling its process group.
// Deliver the terminal interrupt in-process, then let the launcher drain its child.
import type { EventEmitter } from "node:events";

process.once("message", (command: unknown) => {
	if (command === "stop") {
		(process as EventEmitter).emit("SIGINT", "SIGINT");
		process.disconnect?.();
	}
});
// Failed startup must still exit without a supervisor message.
process.channel?.unref();
