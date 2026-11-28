import { collectPoyoPricing } from "./providers/poyo/source.ts";

if (import.meta.main) {
	try {
		const licenseFile = new URL("../../pricing/v1/LICENSE.poyo", import.meta.url);
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		const expectedLicense = decoder.decode(await Bun.file(licenseFile).bytes());
		const handoff = await collectPoyoPricing(
			fetch,
			expectedLicense,
			(model, reason) =>
				console.error(`::warning::PoYo pricing is unavailable for ${model}. ${reason}`),
			Date.now,
			process.env.GITHUB_TOKEN,
		);
		console.log(JSON.stringify(handoff, null, "\t"));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Pricing collection failed.");
		process.exitCode = 1;
	}
}
