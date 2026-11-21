# Image Studio

**Milestone 2 · Approved by the owner on 2026-11-21.** Connect either provider, then review an image request offline. The creator can see what would leave the machine and what it might cost. Uploads, paid submissions, jobs and Gallery begin in milestone 3. [Milestone map](SPEC.md#first-production-milestones)

## Connect a provider

In Settings → Providers, connect, replace or remove either model key independently. On Connect, the server checks the candidate with one rate-limited read. For Poyo.ai, read the balance and discard the account details. For ToAPIs, list accessible image models and flag a valid key lacking Seedream access. Distinguish rejection from an unavailable check. A failed replacement preserves the working key.

Encrypt credentials in the installation database with a separate owner-readable key. On restart, show when the provider last accepted the key, without a network check. Unreadable credentials require reconnection. Removal clears that provider’s credential and status. Apply the existing owner and origin checks. Keep keys out of responses, browser storage and logs.

## Compose an image

Use the approved studio layout in production Svelte. List **ByteDance / Seedream → Seedream 5.5** once, then offer its connected providers. With none eligible, link to Settings. Switching provider keeps the prompt, clears staged media and revalidates options.

| Provider | Generation and reference-guided editing |
| --- | --- |
| Poyo.ai · `seedream-5.5` | Nest prompt (5–5,000 characters), aspect ratio, resolution, background, format and `enable_safety_checker: false` under `input`. Offer automatic aspect ratio for edits. |
| ToAPIs · `doubao-seedream-5-5` | Put prompt, size (resolution tier or valid pixel dimensions) and `disable_nsfw: false` at the top level. Put background, output format and visible watermark under `metadata`. Explain fallback eligibility by account and region. |

Each request produces one image. Generation omits `image_urls`. Edits require 1–10 ordered references there. Keep local files in browser memory. Validate public HTTP(S) reference URLs without fetching them. Enforce each model’s file formats and size cap (Poyo.ai 10 MB, ToAPIs 30 MB) and require PNG for transparency. Discard the draft on reload or sign-out. Layer decomposition and other models are later coverage. [Poyo.ai model contract](https://docs.poyo.ai/api-manual/image-series/seedream-5-5) · [ToAPIs model contract](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation)

## Review the request

- **Review** names the provider, operation and ordered references. Use filenames for bytes the provider would receive and hostnames for full URLs it would fetch. Surface known schema conflicts before Queue. Preserve filtering rejections without rewriting and resubmitting the request.
- **Batch** supports 1–5 requests and 0–3 additional attempts per request. Default retries to zero. Show the maximum potentially billable submissions beside the disabled Queue action, even with an unknown estimate. Two requests with one retry each allow four submissions. The initial-batch estimate excludes retries.
- **Outgoing request** shows the method, destination and JSON from the same validated request used for the estimate. Substitute labeled placeholders for credentials, media and sensitive URLs, including URLs in prompt text. Keep prompts, paths, media bytes and raw provider responses out of diagnostics.
- Show dated per-request and initial-batch estimates in provider credits from the shared calculator’s local rates. Label ToAPIs estimates as standard-route pricing and identify fallback pricing as unknown. Explain unknown totals for missing rates, uncovered options and evidence aged 30 days or more. Update an open Review when a rate expires. Preserve a verified unit rate when usage determines the total. Wallet observations and settled charges belong with submission.

At the first live Queue in milestone 3, the server rechecks the request, connection, attempt limit and quote against its current local rates and clock before uploading or spending. A change returns the creator to the updated Review for another intentional click. A lost acknowledgement always leaves the decision to risk a second charge with the creator.

**Acceptance.** Against fixture providers in the built app, exercise restart, failed key replacement, zero/one/two connections and both operations on each provider. Test keyboard and mobile review, mixed references in order, invalid inputs, exact redacted JSON, fresh and expired rates, and the one- and twenty-attempt bounds. Assert zero external requests during composition and review, zero jobs, and redaction of test secrets. Keep source evidence beside each adapter’s contract tests. Run the [development checks](../README.md#development).
