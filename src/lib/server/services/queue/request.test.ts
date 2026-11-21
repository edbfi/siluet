import { expect, test } from "bun:test";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { parseQueueRequest } from "./request";

const draft = { ...createSeedreamDraft("poyo"), prompt: "a folding screen" };
const request = { draft, count: 1, retryLimit: 0, acceptUnknown: false };

test("live submission strictly validates one text generation before building its provider body", () => {
	expect(parseQueueRequest(request)?.input.prompt).toBe(draft.prompt);
	for (const change of [
		{ count: 2 },
		{ retryLimit: 1 },
		{ acceptUnknown: "true" },
		{ quote: { status: "known" } },
		{ draft: { ...draft, operation: "edit" } },
		{ draft: { ...draft, references: [{ url: "https://example.org/a" }] } },
		{ draft: { ...draft, options: { ...draft.options, background: "not-supported" } } },
		{ draft: { ...draft, provider: "other" } },
		{ draft: { ...draft, prompt: " " } },
	])
		expect(parseQueueRequest({ ...request, ...change })).toBeNull();
});
