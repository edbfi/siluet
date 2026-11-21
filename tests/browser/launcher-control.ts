// A supervisor cannot send a graceful POSIX signal on Windows. Deliver the
// terminal interrupt to the launcher in-process, then let it drain its child.
import type { EventEmitter } from "node:events";

process.once("message", (command: unknown) => {
	if (command === "stop") {
		(process as EventEmitter).emit("SIGINT", "SIGINT");
		process.disconnect?.();
	}
});
// Failed startup must still exit without a supervisor message.
process.channel?.unref();
