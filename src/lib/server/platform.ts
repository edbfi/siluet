// Siluet's server runs on Linux and macOS. Native dependencies such as sharp and
// Turso decide architecture and libc themselves, so this checks the OS only.
export const unsupportedPlatformMessage = "Siluet runs on Linux and macOS only.";

export class UnsupportedPlatformError extends Error {
	constructor() {
		super(unsupportedPlatformMessage);
	}
}

export function requireSupportedPlatform(platform: NodeJS.Platform = process.platform) {
	if (platform !== "linux" && platform !== "darwin") throw new UnsupportedPlatformError();
}
