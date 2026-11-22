import { consoleMode } from "../../scripts/windows-console-mode";

// The parent shares ConPTY with the real command and inspects the actual console input mode.
const before = consoleMode();
const result = Bun.spawnSync([process.execPath, "run", "owner:recover"], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
if (consoleMode() !== before) process.exit(70);
process.exit(result.exitCode);
