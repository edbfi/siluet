import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { loadBundledPricing, loadLocalPricing } from "../../scripts/pricing/local-feed";
import { decodePricingFeeds } from "../../src/lib/shared/pricing/feeds";

/** @param {string} name */
const relative = (name) => new URL(name, import.meta.url);
/** @param {string} name */
const read = (name) => readFileSync(relative(name), "utf8");

const pricingScript = "pricing.generated.js";
const walletScript = "wallet.generated.js";

/**
 * @param {URL} destination
 * @param {import("../../src/lib/shared/pricing/feeds").PricingFeeds | import("../../src/lib/shared/pricing/feeds").ProviderPricingFeed | undefined} feed
 */
export async function exportWorkspace(destination, feed) {
	const feeds = decodePricingFeeds(feed);
	const bundle = await Bun.build({
		entrypoints: [fileURLToPath(relative("pricing.ts"))],
		target: "browser",
		format: "iife",
		minify: { whitespace: true },
		define: { SILUET_WORKSPACE_PRICING: JSON.stringify(feeds) },
	});
	const notice = feeds.poyo ? `/*\n${read("../../pricing/v1/LICENSE.poyo")}\n*/\n` : "";
	const pricing = notice + (await bundle.outputs[0].text());
	const walletBundle = await Bun.build({
		entrypoints: [fileURLToPath(relative("wallet-observations.ts"))],
		target: "browser",
		format: "iife",
		minify: { whitespace: true },
	});
	const wallet = await walletBundle.outputs[0].text();
	/** @type {{ window: { SiluetFixtures: { src: string, mime: string }[] } }} */
	const fixtureContext = { window: { SiluetFixtures: [] } };
	runInNewContext(read("fixtures.js"), fixtureContext);
	const embedded = new Map();
	const fixtures = fixtureContext.window.SiluetFixtures.map((asset) => {
		const bytes = readFileSync(relative(asset.src));
		const src = `data:${asset.mime};base64,${bytes.toString("base64")}`;
		embedded.set(asset.src, src);
		return { ...asset, src };
	});
	const scripts = new Map([
		["fixtures.js", `window.SiluetFixtures = ${JSON.stringify(fixtures)};`],
		[pricingScript, pricing],
		[walletScript, wallet],
	]);
	const markup = read("index.html")
		.replace(/\bsrc="([^"]+)"/g, (attribute, src) => {
			const data = embedded.get(src);
			return data ? `src="${data}"` : attribute;
		})
		.replace(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/g, (_tag, name) => {
			const css = read(name).replace(/<\/style/gi, "<\\/style");
			return `<style>\n${css}\n</style>`;
		})
		.replace(/<script src="([^"]+)"><\/script>/g, (_tag, name) => {
			const source = scripts.get(name) ?? read(name);
			return `<script>\n${source.replace(/<\/script/gi, "<\\/script")}\n</script>`;
		});
	const bundleFile = new URL(pricingScript, destination);
	const standaloneFile = new URL("workspace.html", destination);
	const walletFile = new URL(walletScript, destination);
	await Promise.all([
		Bun.write(bundleFile, pricing),
		Bun.write(standaloneFile, markup),
		Bun.write(walletFile, wallet),
	]);
	return [bundleFile, standaloneFile, walletFile];
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const useCache = args[0] === "--local-pricing";
	if (args.length > (useCache ? 1 : 0)) {
		throw new Error("Usage: bun design/workspace/export.js [--local-pricing]");
	}
	const now = Date.now();
	const [poyo, toapis] = await Promise.all(
		/** @type {const} */ (["poyo", "toapis"]).map((provider) =>
			useCache ? loadLocalPricing(now, { provider }) : loadBundledPricing(provider),
		),
	);
	for (const output of await exportWorkspace(relative("./"), {
		poyo: poyo?.provider === "poyo" ? poyo : undefined,
		toapis: toapis?.provider === "toapis" ? toapis : undefined,
	})) {
		console.log(`Wrote ${output.pathname}`);
	}
}
