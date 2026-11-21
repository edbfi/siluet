import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const relative = (name) => new URL(name, import.meta.url);
const read = (name) => readFileSync(relative(name), "utf8");

const fixtureContext = { window: {} };
runInNewContext(read("fixtures.js"), fixtureContext);
const embedded = new Map();
const fixtures = fixtureContext.window.SiluetFixtures.map((asset) => {
	const bytes = readFileSync(relative(asset.src));
	const src = `data:${asset.mime};base64,${bytes.toString("base64")}`;
	embedded.set(asset.src, src);
	return { ...asset, src };
});

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
		const source =
			name === "fixtures.js" ? `window.SiluetFixtures = ${JSON.stringify(fixtures)};` : read(name);
		return `<script>\n${source.replace(/<\/script/gi, "<\\/script")}\n</script>`;
	});

const output = relative("workspace.html");
await Bun.write(output, markup);
console.log(`Wrote ${output.pathname}`);
