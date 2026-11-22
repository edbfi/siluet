import { expect, test } from "bun:test";
import bundle from "../../../../../pricing/v1/feed.json";
import { editDisclosure } from "../../../shared/image-studio/edit-disclosure";
import { createImageReview } from "../../../shared/image-studio/review";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import {
	buildZImageRequest,
	createZImageDraft,
	validateZImageDraft,
	zImageDisclosure,
	zImageEligible,
} from "../../../shared/image-studio/z-image";
import { decodePricingFeeds } from "../../../shared/pricing/feeds";
import { checkPoyoConnection } from "./connection";
import { createPoyoImage } from "./image";

const signed = "HTTPS://Studio.Example.NET:443/f/%2f?token=fixture%2F#second";
const reference = { kind: "url", url: `  ${signed} `, hostname: "untrusted.local" };
const prompt = "🌒";
const create = createZImageDraft("generate", prompt);
const edit = { ...createZImageDraft("edit", prompt), references: [reference] };
const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;
const endpoint = "https://api.poyo.ai/api/generate/submit";

function reviewed(draft: unknown) {
	const result = validateZImageDraft(draft);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const request = buildZImageRequest(result.input);
	return { request, review: createImageReview(result.input, request) };
}

// https://docs.poyo.ai/api-manual/image-series/z-image
// https://poyo.ai/models/z-image#pricing
test("both Z-Image operations project the exact REST fields and dated Poyo quote offline", () => {
	const feeds = decodePricingFeeds(bundle);
	const uncovered = decodePricingFeeds({
		...bundle,
		rates: { ...bundle.rates, "z-image": { kind: "unavailable" } },
	});
	const batch = { count: 1, retryLimit: 0 };
	const fresh = Date.parse(bundle.sourceDate);
	const expires = fresh + 30 * 24 * 60 * 60 * 1000;
	for (const draft of [create, edit]) {
		const isEdit = draft.operation === "edit";
		for (const size of isEdit ? [...ratios, undefined] : ratios) {
			const options = size ? { size } : {};
			const { request, review } = reviewed({ ...draft, prompt: `  ${prompt}   `, options });
			const fields = { prompt, ...options, enable_safety_checker: false } as const;
			expect(request).toEqual({
				method: "POST",
				url: endpoint,
				body: {
					model: "z-image",
					input: { ...fields, ...(isEdit && { image_urls: [signed] }) },
				},
			});
			expect(review.outgoing.body).toEqual({
				model: "z-image",
				input: {
					...fields,
					...(isEdit && { image_urls: ["[remote URL hidden]"] }),
				},
			});
			expect(review.sources).toEqual(isEdit ? [{ kind: "url", label: "studio.example.net" }] : []);
			expect(JSON.stringify(review)).not.toContain("token=fixture");
			expect(estimateReviewPrice(feeds, review.pricing, batch, expires - 1)).toMatchObject({
				status: "known",
				unit: "poyo_credit",
				perRequest: "2",
				batch: "2",
				maxAttempts: 1,
				sourceDate: bundle.sourceDate,
			});
			for (const [inputFeeds, now, reason] of [
				[feeds, expires, "expired-feed"],
				[{}, fresh, "missing-feed"],
				[uncovered, fresh, "rate-unavailable"],
			] as const)
				expect(estimateReviewPrice(inputFeeds, review.pricing, batch, now)).toEqual({
					status: "unknown",
					reason,
					maxAttempts: 1,
				});
		}
	}
});

test("Z-Image drafts start with a fixed create ratio or omitted edit size, without staged media", () => {
	expect(create.options).toEqual({ size: "1:1" });
	expect(createZImageDraft("edit", prompt)).toMatchObject({ prompt, options: {}, references: [] });
	expect(validateZImageDraft({ ...create, prompt: prompt.repeat(1000) }).ok).toBe(true);
	for (const value of ["", " \t ", prompt.repeat(1001)])
		expect(validateZImageDraft({ ...create, prompt: value }).ok).toBe(false);
});

test("Z-Image rejects foreign fields, sizes, wrong source counts, local URLs and files", () => {
	for (const draft of [
		{ ...create, options: {} },
		{ ...create, references: [reference] },
		{ ...create, provider: "toapis" },
		{ ...create, callback_url: signed },
		{ ...create, operation: "unknown" },
		{ ...edit, references: [] },
		{ ...edit, references: [reference, reference] },
		{ ...edit, references: [null] },
		{ ...edit, references: [{ ...reference, url: "https://127.0.0.1/a" }] },
		{ ...edit, references: [{ kind: "file", file: new File(["x"], "private.png") }] },
		{ ...edit, references: [{ ...reference, file: "private.png" }] },
		...[create, edit].flatMap((draft) =>
			["auto", "3:2", "2:3", "21:9", null, ""].map((size) => ({ ...draft, options: { size } })),
		),
		...["resolution", "background", "outputFormat", "enable_safety_checker", "image_urls"].map(
			(key) => ({ ...edit, options: { [key]: false } }),
		),
	])
		expect(validateZImageDraft(draft).ok).toBe(false);
});

test("only a readable balance-accepted Poyo connection qualifies even without Seedream access", () => {
	expect(zImageEligible({ id: "poyo", state: "connected", verifiedAt: 123, seedream: false })).toBe(
		true,
	);
	expect(
		zImageEligible({ id: "toapis", state: "connected", verifiedAt: 123, seedream: true }),
	).toBe(false);
	for (const state of ["reconnect", "disconnected"] as const)
		expect(zImageEligible({ id: "poyo", state })).toBe(false);
	expect(zImageEligible({ id: "poyo", state: "repair", hasCredential: true })).toBe(false);
});

test("fixed-field consent applies to both operations and edits bind URL transfer and retention", () => {
	expect(zImageDisclosure("generate").join(" ")).toContain("enable_safety_checker: false");
	expect(zImageDisclosure("edit")).toEqual([
		...zImageDisclosure("generate"),
		...editDisclosure("poyo"),
	]);
});

test("a balance check can succeed before Z-Image denies model permission", async () => {
	const check = checkPoyoConnection(async () =>
		Response.json({ code: 200, data: { credits_amount: 0 } }),
	);
	expect((await check("fixture-key")).outcome).toBe("accepted");
	const taskId = "z-offline-21";
	const invalid = { code: 400, error: { type: "validation_error", message: signed } };
	for (const draft of [create, edit]) {
		const { request } = reviewed(draft);
		for (const [status, body, result] of [
			[200, { code: 200, data: { task_id: taskId } }, { kind: "accepted", taskId }],
			[200, invalid, { kind: "rejected", reason: "validation" }],
			[
				403,
				{ code: 403, error: { type: "permission_denied_error" } },
				{ kind: "rejected", reason: "authorization" },
			],
			[
				200,
				{ code: 400, error: { type: "file_format_error" } },
				{ kind: "rejected", reason: "validation" },
			],
			[
				200,
				{ code: 400, error: { type: "content_moderation_error" } },
				{ kind: "rejected", reason: "filtering" },
			],
			[200, { ...invalid, data: { status: "running" } }, { kind: "unknown" }],
			[200, { ...invalid, data: { task_id: taskId } }, { kind: "unknown" }],
			[403, invalid, { kind: "unknown" }],
			[403, { code: 403, error: { type: "upstream_error" } }, { kind: "unknown" }],
			[200, { code: 200, data: { task_id: taskId }, error: "" }, { kind: "unknown" }],
			[200, { code: 200, data: {} }, { kind: "unknown" }],
			[504, null, { kind: "unknown" }],
			[0, null, { kind: "unknown" }],
		] as const) {
			const calls: { url: string; init: RequestInit }[] = [];
			const adapter = createPoyoImage(async (url, init) => {
				calls.push({ url, init });
				if (!status) throw new Error("connection lost");
				return Response.json(body, { status });
			});
			expect(await adapter.submit("fixture-key", request)).toEqual(result);
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe(endpoint);
			expect(calls[0].init).toMatchObject({
				method: "POST",
				redirect: "error",
				body: JSON.stringify(request.body),
			});
			expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer fixture-key");
		}
	}
});

test("Z-Image polls only the accepted task and offers exactly one completed image for Save", async () => {
	const taskId = "z-offline-22";
	const image = { file_type: "image", file_url: signed.replace("HTTPS:", "https:") };
	for (const [status, state, files, resultUrl] of [
		["not_started", "waiting", [image], null],
		["running", "running", [image], null],
		["failed", "failed", [image], null],
		["finished", "completed", [image, { file_type: "audio" }], image.file_url],
		["finished", "completed", [image, image], null],
		["finished", "completed", [{ file_type: "image", file_url: "invalid" }], null],
	] as const) {
		const reads: string[] = [];
		const adapter = createPoyoImage(async (url) => {
			reads.push(url);
			return Response.json({
				code: 200,
				data: { task_id: taskId, status, files, credits_amount: 1.75, error_message: signed },
			});
		});
		expect(await adapter.status("fixture-key", taskId)).toEqual({
			kind: "observed",
			state,
			billing: { status: "reported", credits: "1.75" },
			resultUrl,
			expiresAt: null,
			retryAfter: null,
			failureReason: null,
		});
		expect(await adapter.status("fixture-key", "different")).toMatchObject({
			kind: "paused",
			reason: "unknown-status",
		});
		expect(reads).toEqual(
			[taskId, "different"].map((id) => `https://api.poyo.ai/api/generate/status/${id}`),
		);
	}
});
