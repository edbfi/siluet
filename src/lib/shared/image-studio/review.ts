import type { PricingProvider } from "../pricing/feeds";
import type { ReviewPricingInput } from "./review-price";
import type { SeedreamOperation } from "./seedream";

export type ReviewOperation = SeedreamOperation;

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

const schemeOrSlashes =
	/(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/|(?:https?|blob|file|data|mailto):|\/\//u;
const host =
	/(?:[\p{L}\p{M}\p{N}_-]+\.)+(?:xn--[a-z\d-]+|(?:\p{L}\p{M}*){2,})\.?|\d{1,3}(?:\.\d{1,3}){3}|localhost\.?|\[[a-f\d:.%]+\]/u;
const bareHost = new RegExp(
	String.raw`(?<![\p{L}\p{N}_.-])(?:www\.|(?:${host.source})(?=:\d+|[/?#])|\p{L}[\p{L}\p{N}_-]*(?=:\d+[/#?]))`,
	"iu",
);
const sentencePunctuation = /[.,;:!?'"…\p{Pe}\p{Pf}]/u;
const authorityPunctuation = /[.,;:!?'"…*\p{Pe}\p{Pf}\p{Pd}]/u;
const literalHandleSuffix = /^\p{Pc}[\p{L}\p{M}\p{N}\p{Pc}-]*[.,;!'"…*\p{Pe}\p{Pf}]*$/u;
const authority = new RegExp(
	String.raw`^(?:(?:${host.source})(?::\d+)?|\p{L}[\p{L}\p{N}_-]*:\d+)(?=$|[\p{P}\p{S}])`,
	"iu",
);
const closingWrapper = new Map([
	['"', '"'],
	["'", "'"],
	["(", ")"],
	["<", ">"],
	["[", "]"],
	["{", "}"],
	["“", "”"],
	["‘", "’"],
	["«", "»"],
	["‹", "›"],
	["「", "」"],
]);
const ipv6Authority = /^(?:(?:[a-z][a-z\d+.-]*:)?\/\/(?:[^/?#]*@)?)?\[[a-f\d:.%]+\]/iu;
const linkStart = new RegExp(`(?:${schemeOrSlashes.source}|${bareHost.source})`, "iu");

export const redactPrompt = (prompt: string) => prompt.replace(/\S+/gu, redactLink);

function redactLink(token: string): string {
	let start = token.search(linkStart);
	const closingPunctuation = start < 0 ? authorityPunctuation : sentencePunctuation;
	if (start < 0) {
		const at = token.lastIndexOf("@");
		const colon = token.indexOf(":");
		if (colon < 0 || at <= colon) return token;
		const address = token.slice(at + 1);
		const match = authority.exec(address);
		if (!match) return token;
		// An empty password has the same spelling as a credit label before a handle.
		if (at === colon + 1 && literalHandleSuffix.test(address.slice(match[0].length))) return token;
		start = at + 1;
	}
	let prefix = token.slice(0, start);
	// A bare host can have user:password@ in front of it. Keep only its opening punctuation.
	if (prefix.endsWith("@")) prefix = /^[<'"*\p{Ps}\p{Pi}]*/u.exec(prefix)?.[0] ?? "";
	// In a bracketed IPv6 authority, the closing bracket belongs to the address.
	const hostEnd = start + (ipv6Authority.exec(token.slice(start))?.[0].length ?? 0);
	let end = token.length;
	while (
		end > hostEnd &&
		(closingPunctuation.test(token[end - 1]) || (token[end - 1] === ">" && prefix.endsWith("<")))
	)
		end--;
	// Trailing punctuation can itself be a private query value. Only a paired wrapper
	// provides a boundary between a query or fragment and the surrounding prose.
	if (end < token.length && /[?#]/u.test(token.slice(start))) {
		const closer = closingWrapper.get(prefix.slice(-1));
		const boundary = closer ? token.lastIndexOf(closer) : -1;
		end = boundary >= end ? boundary : token.length;
	}
	return `${prefix}[URL hidden]${token.slice(end)}`;
}

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
		prompt: redactPrompt(prompt),
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
