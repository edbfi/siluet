import type { PricingProvider } from "../pricing/feeds";
import type { ReviewPricingInput } from "./review-price";

export type ReviewOperation = "generate" | "edit";

export type ReviewReference =
	| Readonly<{ kind: "file"; file: Pick<File, "name"> }>
	| Readonly<{ kind: "url"; url: string; hostname: string }>;

type ReviewInput = Readonly<{
	provider: PricingProvider;
	operation: ReviewOperation;
	references: readonly ReviewReference[];
}>;

type ImageFields = Readonly<
	{ prompt: string; image_urls?: readonly string[] } & Record<string, unknown>
>;

type WireBody =
	| Readonly<{ model: string; input: ImageFields }>
	| (Readonly<{ model: string; input?: never }> & ImageFields);

type WireRequest = Readonly<{
	method: string;
	url: string;
	body: WireBody;
}>;

const urlInPrompt = /(?:(?:https?|blob|file|data):|\/\/(?=[\p{L}\p{N}[]))[^\s<>"']+/giu;

/** Build the presentation from the validated wire request before it receives any credentials. */
export function createImageReview(
	{ provider, operation, references }: ReviewInput,
	request: WireRequest,
) {
	const { model } = request.body;
	let fields: ImageFields;
	if (request.body.input === undefined) {
		const { model: _model, ...options } = request.body;
		fields = options;
	} else {
		fields = request.body.input;
	}
	const { prompt, image_urls: urls, ...options } = fields;
	const safeFields: ImageFields = {
		...fields,
		prompt: prompt.replace(urlInPrompt, "[URL hidden]"),
		...(urls && {
			image_urls: urls.map((_, index) =>
				references[index]?.kind === "file" ? "[local image]" : "[remote URL hidden]",
			),
		}),
	};
	const body = request.body.input ? { model, input: safeFields } : { model, ...safeFields };
	const pricing: ReviewPricingInput = {
		provider,
		operation,
		model,
		options,
		sourceCount: urls?.length ?? 0,
	};
	const sources = references.map((source) => ({
		kind: source.kind,
		label:
			source.kind === "file"
				? source.file.name.split(/[\\/]/).at(-1) || "Unnamed image"
				: source.hostname,
	}));
	return {
		pricing,
		sources,
		outgoing: { method: request.method, url: request.url, body },
	};
}

export type ImageReviewData = ReturnType<typeof createImageReview>;
