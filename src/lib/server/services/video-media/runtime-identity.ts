import { readFile } from "node:fs/promises";

// Only a known absent PID or a different boot/start pair proves an abandoned Save.
export async function runtimeIdentity(pid: number) {
	try {
		const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => null);
		if (!boot?.trim()) return undefined;
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return /^\d+$/.test(start) ? `${boot.trim()}/${start}` : undefined;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		return undefined;
	}
}
