import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import poyoBundle from "../../pricing/v2/poyo.json";
import toapisBundle from "../../pricing/v2/toapis.json";
import type { SeedreamProvider } from "../../src/lib/shared/image-studio/seedream-options";
import { localFilenameMarker, localImageMarker } from "../fixtures/local-image";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys } from "../fixtures/provider-connections";
import {
	editedImageSignature,
	referenceEditFixtures,
	referenceMarkers,
	referenceQueryMarker,
	signedReference,
} from "../fixtures/reference-edit";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest, signInOwner } from "./owner-session";

// A signed-in studio with one connected provider and the Seedream edit fixtures, shared by
// the URL and local-file edit specs.
export const promptMarker = "private-edit-prompt";
export const promptUrlMarker = "private-prompt-url";
export const prompt = `Move the sculpture beside ${promptMarker}. See <https://prompt.example.test/?sig=${promptUrlMarker}>.`;
export const updatedSignature = "private-updated-signature";
export const changedReference = signedReference.replace(referenceQueryMarker, updatedSignature);
export const privateNames = ["fixture-handbag-private-name", "fixture-table-private-name"];
export const bundledObservation = { poyo: poyoBundle.sourceDate, toapis: toapisBundle.observedAt };
// Bundled rates are current from their latest confirmation, which may follow the source date.
export const bundledCurrent = { poyo: poyoBundle.confirmedAt, toapis: toapisBundle.observedAt };

export function providerPayload(
	provider: SeedreamProvider,
	urls = [signedReference],
	text = prompt,
) {
	const output = { background: "auto", output_format: "png" };
	return provider === "poyo"
		? {
				model: "seedream-5.5",
				input: {
					prompt: text,
					size: "auto",
					resolution: "2K",
					...output,
					enable_safety_checker: false,
					image_urls: urls,
				},
			}
		: {
				model: "doubao-seedream-5-5",
				prompt: text,
				size: "2K",
				disable_nsfw: false,
				metadata: { ...output, watermark: false },
				image_urls: urls,
			};
}

export type Outcome = NonNullable<Parameters<typeof referenceEditFixtures>[1]>;
export type Studio = Awaited<ReturnType<typeof startStudio>>;

export async function withEditStudio(
	page: Page,
	provider: SeedreamProvider,
	outcome: Outcome,
	run: (context: {
		origin: string;
		cacheHome: string;
		rates: { observedAt: string; observedMs: number };
		fixtures: ReturnType<typeof referenceEditFixtures>;
		post: (path: string, data: unknown, from?: string) => ReturnType<Page["request"]["post"]>;
		restart: <T>(prepare?: (directory: string) => Promise<T>) => Promise<T | undefined>;
		/** Sign in again after a restart, in a new session. */
		newSession: () => Promise<void>;
		assertRedacted: (value: string) => void;
		assertPrivate: (includePage?: boolean) => Promise<void>;
		assertOneSubmission: () => void;
	}) => Promise<void>,
	fixtureTime?: number,
) {
	const dir = await createOwnerDirectory();
	const fixtures = referenceEditFixtures(provider, outcome, prompt);
	const cacheHome = await mkdtemp(join(tmpdir(), "siluet-reference-pricing-"));
	const env = {
		...fixtures.env,
		XDG_CACHE_HOME: cacheHome,
		...(fixtureTime === undefined ? {} : { SILUET_TEST_PROVIDER_TIME: String(fixtureTime) }),
	};
	let studio: Studio | undefined;
	try {
		const observedAt = bundledObservation[provider];
		const rates =
			fixtureTime === undefined
				? await writeReviewPricing(cacheHome, 0)
				: { observedAt, observedMs: Date.parse(bundledCurrent[provider]) };
		studio = await startStudio(dir, "0", false, env);
		const origin = studio.origin.origin;
		const port = studio.origin.port;
		const browserRequests: string[] = [];
		const browserMessages: string[] = [];
		page.on("console", (message) => browserMessages.push(message.text()));
		page.on("pageerror", (error) => browserMessages.push(error.message));
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (new URL(url).origin === origin) return route.continue();
			browserRequests.push(url);
			return route.abort();
		});
		await expect.poll(studio.token).not.toBe("");
		const password = crypto.randomUUID();
		await claimOwner(page, studio, password);
		const connected = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider, key: providerFixtureKeys[provider] },
		});
		expect(connected.ok()).toBe(true);

		function assertRedacted(value: string) {
			for (const marker of [
				...referenceMarkers,
				...privateNames,
				updatedSignature,
				promptMarker,
				promptUrlMarker,
				editedImageSignature,
				providerFixtureKeys[provider],
				// A local file's planted metadata, its name and the hosted upload link.
				localImageMarker,
				localFilenameMarker,
				new URL(fixtures.hosted).search.slice(1),
			]) {
				expect(value).not.toContain(marker);
			}
		}
		const assertPrivate = async (includePage = true) => {
			assertRedacted(studio?.diagnostics() ?? "");
			assertRedacted(browserMessages.join("\n"));
			const { origins } = await page.context().storageState({ indexedDB: true });
			assertRedacted(JSON.stringify(origins));
			assertRedacted(
				await page.evaluate(async () =>
					JSON.stringify([
						sessionStorage,
						...(await Promise.all(
							(
								await caches.keys()
							).map(async (key) => {
								const cache = await caches.open(key);
								return Promise.all(
									(await cache.keys()).map(async (request) => [
										request.url,
										await (await cache.match(request))?.text(),
									]),
								);
							}),
						)),
					]),
				),
			);
			if (includePage) assertRedacted(await page.content());
			expect(browserRequests).toEqual([]);
			expect(fixtures.requests.filter(({ path }) => path === "/unexpected")).toEqual([]);
		};
		await run({
			origin,
			cacheHome,
			rates,
			fixtures,
			async post(path, data, from = origin) {
				const response = await ownerRequest(page).post(origin + path, {
					data,
					headers: { origin: from },
				});
				assertRedacted(await response.text());
				return response;
			},
			async restart(prepare) {
				await studio?.stop(outcome !== "crash-after-acceptance");
				assertRedacted(studio?.diagnostics() ?? "");
				studio = undefined;
				const prepared = await prepare?.(dir);
				const paths = await readdir(dir, { recursive: true });
				expect(paths).toContain("studio.db");
				assertRedacted(paths.join("\n"));
				for (const file of paths.filter((file) => file.startsWith("studio.db"))) {
					assertRedacted((await readFile(join(dir, file))).toString("latin1"));
				}
				studio = await startStudio(dir, port, false, env);
				return prepared;
			},
			async newSession() {
				// The page's browser key signs in again; its next load resumes the new session.
				await signInOwner(page, origin, password);
				ownerRequest(page).reset();
			},
			assertRedacted,
			assertPrivate,
			assertOneSubmission() {
				expect(fixtures.requests.filter(({ path }) => path.endsWith("/submit"))).toEqual([
					{ path: `/${provider}/submit`, method: "POST", key: providerFixtureKeys[provider] },
				]);
			},
		});
	} finally {
		await studio?.stop();
		await fixtures.stop();
		await rm(dir, { recursive: true, force: true });
		await rm(cacheHome, { recursive: true, force: true });
	}
}
