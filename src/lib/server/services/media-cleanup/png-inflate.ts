import { inflate } from "node:zlib";
import { PngCleanupError } from "./png-errors";

export function inflatePng(
	input: Buffer,
	maxOutputLength: number,
	codes: {
		invalid: PngCleanupError["code"];
		oversized: PngCleanupError["code"];
		trailing?: PngCleanupError["code"];
	},
) {
	return new Promise<Buffer>((resolve, reject) => {
		// Bun 1.4.5 implements Node's info result. Its types still describe only Buffer.
		// https://nodejs.org/api/zlib.html#class-options
		inflate(
			input,
			{ info: true, maxOutputLength: Math.max(1, maxOutputLength) },
			(error, result: unknown) => {
				if (error) {
					const oversized = "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
					return reject(new PngCleanupError(oversized ? codes.oversized : codes.invalid));
				}
				if (
					typeof result !== "object" ||
					result === null ||
					!("buffer" in result) ||
					!Buffer.isBuffer(result.buffer) ||
					!("engine" in result) ||
					typeof result.engine !== "object" ||
					result.engine === null ||
					!("bytesWritten" in result.engine) ||
					typeof result.engine.bytesWritten !== "number"
				)
					return reject(new PngCleanupError("png-verification"));
				if (result.engine.bytesWritten !== input.length) {
					return reject(new PngCleanupError(codes.trailing ?? codes.invalid));
				}
				if (result.buffer.length > maxOutputLength)
					return reject(new PngCleanupError(codes.oversized));
				resolve(result.buffer);
			},
		);
	});
}
