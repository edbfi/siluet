// Check 11 end to end: the shared ToAPIs inventory snapshot in the built app.
import { join } from "node:path";
import { expect } from "@playwright/test";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { seedanceOperation } from "../../src/lib/shared/media-catalog/registry";
import { videoDefaults } from "../../src/lib/shared/video-studio/seedance";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { seedanceProvider } from "../fixtures/seedance-provider";
import { seedanceShape } from "../fixtures/video/real-clips";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

const keys = { listed: providerFixtureKeys.toapis, absent: "fixture-toapis-absent-secret" };
const prompt = "A paper lantern over still water, inventory fixture.";
const lists: Record<string, string> = {
	"/toapis/models": "doubao-seedream-5-5",
	"/toapis/video-models": "seedance-2-5",
};
const listed = (model: string) => new RegExp(`^ToAPIs listed ${model} for this key at .+ UTC\\.$`);
const absent = (model: string) => new RegExp(`^ToAPIs did not list ${model} for this key at `);
const failed = /^The ToAPIs model check failed at .+ \(service unavailable\)\. Check again\.$/;

type Studio = Awaited<ReturnType<typeof startStudio>>;

test("Settings and Review show listed, absent or unknown per exact ToAPIs model, and only a fresh listing queues", async ({
	page,
}) => {
	test.setTimeout(180_000);
	page.setDefaultTimeout(15_000);
	const directory = await createOwnerDirectory();
	let failing = false;
	let slow: PromiseWithResolvers<void> | null = null;
	const images = jobResponses();
	const videos = seedanceProvider(
		seedanceShape(),
		async (request) => (await request.json()).client_business_id,
	);
	const fixtures = startProviderFixtures(async (request, path) => {
		const model = lists[path];
		if (model) {
			const key = request.headers.get("authorization")?.slice("Bearer ".length);
			if (key !== keys.listed && key !== keys.absent) return null;
			if (slow) await slow.promise;
			if (failing) return new Response("<html>fixture outage</html>", { status: 500 });
			return Response.json({
				success: true,
				object: "list",
				data: key === keys.listed ? [{ id: model, object: "model" }] : [],
			});
		}
		return (await videos(request, path)) ?? images(request, path);
	});
	const count = (path: string, method = "GET") =>
		fixtures.requests.filter((row) => row.path === path && row.method === method).length;
	let server: Studio | undefined;
	try {
		server = await startStudio(directory, "0", false, fixtures.env);
		const { origin, port } = server.origin;
		await page.route(/^https?:/, (route) =>
			new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
		);
		const restart = async (env: Record<string, string> = fixtures.env) => {
			await server?.stop();
			server = undefined;
			server = await startStudio(directory, port, false, env);
		};
		const post = (path: string, data: unknown) =>
			ownerRequest(page).post(origin + path, { data, headers: { origin } });
		const settings = () => page.goto(`${origin}/settings/providers?provider=toapis`);
		const saveKey = async (key: string, button: "Connect" | "Replace key") => {
			await settings();
			await page.getByLabel("API key").fill(key);
			await page.getByRole("button", { name: button, exact: true }).press("Enter");
			await expect(page.getByRole("status")).toHaveText("Key accepted and saved.");
		};
		const checkAgain = async (scope: "image" | "video") => {
			const answered = page.waitForResponse(
				(response) => new URL(response.url()).pathname === "/providers/inventory",
			);
			const button = page.getByRole("button", { name: `Check again: ${scope} models` });
			await button.press("Enter");
			const response = await answered;
			// The section refreshes before it takes another check.
			await expect(button).toHaveText("Check again");
			return response;
		};
		const review = page.getByRole("region", { name: "Review request", exact: true });
		const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
		const queue = review.getByRole("button", { name: "Queue 1 request" });
		const reviewCheck = review.getByRole("button", { name: "Check again: ToAPIs model access" });
		const openImageReview = async () => {
			await page.goto(`${origin}/image`);
			await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
			await review.getByRole("button", { name: "Review request", exact: true }).press("Enter");
		};
		const video = {
			draft: { ...videoDefaults, prompt },
			operationKey: seedanceOperation.key,
			count: 1,
			retryLimit: 0,
			acceptTerms: false,
		};

		await test.step("Connect records the image listing, and Settings shows it", async () => {
			await expect.poll(server?.token ?? (() => "")).not.toBe("");
			await claimOwner(page, server as Studio, crypto.randomUUID());
			await saveKey(keys.listed, "Connect");
			await expect(page.getByText(listed("doubao-seedream-5-5"))).toBeVisible();
			await page.getByText("Every ToAPIs image model (58)").click();
			await expect(
				page.getByRole("listitem").filter({ hasText: /^doubao-seedream-5-5\s*· listed$/ }),
			).toBeVisible();
			await expect(
				page.getByText(
					"A listing is not evidence of entitlement, filtering compatibility or price.",
				),
			).toHaveCount(2);
			expect(count("/toapis/models")).toBe(1);
		});

		let saved = "";
		await test.step("a listed Seedream 5.5 queues, saves and reopens offline", async () => {
			await openImageReview();
			await expect(facts.getByText(listed("doubao-seedream-5-5"))).toBeVisible();
			await review.getByRole("checkbox", { name: /unknown/i }).check();
			await queue.press("Enter");
			await expect(page).toHaveURL(/\/jobs/);
			const open = page.getByRole("article").getByRole("link", { name: "Open saved image" });
			await expect(open).toBeVisible({ timeout: 30_000 });
			saved = (await open.getAttribute("href")) ?? "";
			expect(count("/toapis/submit", "POST")).toBe(1);
			const before = fixtures.requests.length;
			await restart();
			await page.goto(origin + saved);
			expect(await (await ownerRequest(page).get(`${origin}${saved}/media`)).body()).toEqual(
				referencePng,
			);
			expect(fixtures.requests.length).toBe(before);
		});

		await test.step("a failed check leaves the model unknown until a later success", async () => {
			failing = true;
			await settings();
			expect((await checkAgain("image")).status()).toBe(200);
			await expect(page.getByRole("alert").filter({ hasText: failed })).toBeVisible();
			await openImageReview();
			await expect(facts.getByText(failed)).toBeVisible();
			await expect(queue).toBeDisabled();
			failing = false;
			slow = Promise.withResolvers<void>();
			const gate = slow;
			await reviewCheck.press("Enter");
			// While it runs, the name follows the visible text (WCAG 2.5.3).
			await expect(
				review.getByRole("button", { name: "Checking: ToAPIs model access" }),
			).toHaveText("Checking…");
			slow = null;
			gate.resolve();
			await expect(facts.getByText(listed("doubao-seedream-5-5"))).toBeVisible();
			await review.getByRole("checkbox", { name: /unknown/i }).check();
			await expect(queue).toBeEnabled();
			expect(count("/toapis/submit", "POST")).toBe(1);
		});

		await test.step("an absent key reviews, says so after Check again, and sends nothing", async () => {
			await saveKey(keys.absent, "Replace key");
			await expect(page.getByText(absent("doubao-seedream-5-5"))).toBeVisible();
			await openImageReview();
			await expect(facts.getByText(absent("doubao-seedream-5-5"))).toBeVisible();
			const reads = count("/toapis/models");
			// The absent line is already shown, so wait for the check and the Review it refreshes.
			const pathOf = (response: { url(): string }) => new URL(response.url()).pathname;
			const checked = page.waitForResponse(
				(response) => pathOf(response) === "/providers/inventory",
			);
			const refreshed = page.waitForResponse((response) => pathOf(response) === "/image/review");
			await reviewCheck.press("Enter");
			await Promise.all([checked, refreshed]);
			await expect(facts.getByText(absent("doubao-seedream-5-5"))).toBeVisible();
			expect(count("/toapis/models")).toBe(reads + 1);
			await expect(queue).toBeDisabled();
			expect(count("/toapis/submit", "POST")).toBe(1);
		});

		await test.step("a fourth check in a minute is refused with the limit message", async () => {
			await settings();
			const reads = count("/toapis/video-models");
			for (let check = 0; check < 3; check++)
				expect((await checkAgain("video")).status()).toBe(200);
			await expect(
				page.getByRole("status").filter({ hasText: absent("seedance-2-5") }),
			).toBeVisible();
			expect((await checkAgain("video")).status()).toBe(429);
			await expect(
				page
					.getByRole("alert")
					.filter({ hasText: /^Three checks a minute per scope\. Try again in \d+ s\.$/ }),
			).toBeVisible();
			expect(count("/toapis/video-models")).toBe(reads + 3);
		});

		await test.step("a pre-G9 Seedance record queues under its exception until the first video check", async () => {
			await saveKey(keys.listed, "Replace key");
			await server?.stop();
			server = undefined;
			// The shipped record, eligible at the current revision, with no video snapshot yet.
			const client = await connect(join(directory, "studio.db"));
			try {
				const db = drizzle({ client });
				const row = await db.get<{ revision: number }>(
					sql`SELECT revision FROM provider_credential WHERE provider='toapis'`,
				);
				await db.run(
					sql`INSERT OR REPLACE INTO model_access VALUES ('toapis','seedance-2-5',${row?.revision},'eligible',${Date.now()})`,
				);
				expect(
					await db.all(
						sql`SELECT * FROM provider_inventory WHERE scope='video' AND revision=${row?.revision}`,
					),
				).toEqual([]);
			} finally {
				await client.close();
			}
			server = await startStudio(directory, port, false, fixtures.env);
			await page.goto(`${origin}/video`);
			const first = await (await post("/video/review", video)).json();
			expect(first.access).toEqual({
				state: "exception",
				text: "Seedance 2.5 was listed for this key.",
			});
			const queued = await post("/video/queue", {
				...video,
				token: first.token,
				acceptTerms: true,
			});
			expect(await queued.json()).toHaveProperty("jobId");
			expect(count("/toapis/video-submit", "POST")).toBe(1);
			failing = true;
			await settings();
			await checkAgain("video");
			await expect(page.getByRole("alert").filter({ hasText: failed })).toBeVisible();
			const ended = await (await post("/video/review", video)).json();
			expect(ended.access.state).toBe("failed");
			expect(ended.blockers).toEqual([ended.access.text]);
			failing = false;
			await checkAgain("video");
			await expect(
				page.getByRole("status").filter({ hasText: listed("seedance-2-5") }),
			).toBeVisible();
		});

		await test.step("25 hours later, opening each Review makes one automatic check, then Queue succeeds", async () => {
			await restart({
				...fixtures.env,
				SILUET_TEST_PROVIDER_TIME: String(Date.now() + 25 * 3_600_000),
			});
			const imageReads = count("/toapis/models");
			await openImageReview();
			await expect(facts.getByText(listed("doubao-seedream-5-5"))).toBeVisible();
			expect(count("/toapis/models")).toBe(imageReads + 1);
			await review.getByRole("checkbox", { name: /unknown/i }).check();
			await queue.press("Enter");
			await expect(page).toHaveURL(/\/jobs/);
			expect(count("/toapis/submit", "POST")).toBe(2);
			const videoReads = count("/toapis/video-models");
			const reopened = await (await post("/video/review", video)).json();
			expect(reopened.access.state).toBe("listed");
			expect(count("/toapis/video-models")).toBe(videoReads + 1);
		});
	} finally {
		await server?.stop();
		fixtures.stop();
	}
});
