// Preload this file to print the process umask, in octal, as the last line on stderr.
process.on("exit", () => {
	process.stderr.write(`umask ${process.umask().toString(8)}\n`);
});
