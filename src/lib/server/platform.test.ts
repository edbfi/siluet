import { expect, test } from "bun:test";
import {
	requireSupportedPlatform,
	UnsupportedPlatformError,
	unsupportedPlatformMessage,
} from "./platform";

test("accepts linux and darwin; refuses win32, freebsd and aix", () => {
	for (const platform of ["linux", "darwin"] as const)
		expect(() => requireSupportedPlatform(platform)).not.toThrow();
	for (const platform of ["win32", "freebsd", "aix"] as const) {
		expect(() => requireSupportedPlatform(platform)).toThrow(UnsupportedPlatformError);
		expect(() => requireSupportedPlatform(platform)).toThrow(unsupportedPlatformMessage);
	}
	expect(unsupportedPlatformMessage).toBe("Siluet runs on Linux and macOS only.");
});
