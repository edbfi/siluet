import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

if (process.platform === "win32") {
	const root = process.env.SystemRoot;
	if (!root || !isAbsolute(root)) throw new Error("Windows compiler unavailable.");
	const compiler = join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
	const native = join(import.meta.dir, "..", "native");
	const output = join(native, "..", "build", "native");
	await mkdir(output, { recursive: true });
	for (const name of ["FactorKey", "ConsoleMode"]) {
		const result = Bun.spawnSync([
			compiler,
			"/nologo",
			"/optimize+",
			"/target:exe",
			`/out:${join(output, `${name}.exe`)}`,
			join(native, `${name}.cs`),
		]);
		if (result.exitCode !== 0) {
			process.stderr.write(result.stdout);
			process.stderr.write(result.stderr);
			throw new Error(`Could not build the Windows ${name} helper.`);
		}
	}
}
