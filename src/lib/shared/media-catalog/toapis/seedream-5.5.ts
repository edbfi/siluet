/**
 * ToAPIs' Seedream 5.5 page, as far as G3 reads it: the output formats it documents for
 * `metadata.output_format`. G10a completes this descriptor with the page's other fields.
 * The digest is the SHA-256 of the page's Markdown rendering (`<url>.md`).
 */
export const seedream55Page = {
	url: "https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation",
	accessed: "2026-11-27",
	markdownSha256: "d5da194872348ff7f6e34d55c3fdc920da217056a0942bca11bdcefd4ba56111",
	models: ["doubao-seedream-5-5"],
	outputFormat: {
		field: "metadata.output_format",
		values: ["png", "jpeg"],
		default: "png",
		quote:
			"Accepts `png` or `jpeg`, defaulting to `png`. Transparency requires PNG and rejects JPEG.",
	},
} as const;
