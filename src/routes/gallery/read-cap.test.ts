import { expect, test } from "bun:test";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { readCap } from "#lib/components/media/private-media.ts";

// Both Gallery pages carry the tab's read cap on their root as `data-read-cap`, so a browser
// journey reads the cap from the built page instead of importing the constant (D5).

// Bun has no Svelte loader; compile each component for the server as Bun imports it.
Bun.plugin({
	name: "svelte-server",
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
			contents: compile(await Bun.file(path).text(), { filename: path, generate: "server" }).js
				.code,
			loader: "js",
		}));
	},
});

const root = (body: string) => body.match(/<section\b[^>]*>/)?.[0] ?? "";

test("the Gallery grid's root renders the read cap", async () => {
	const { default: Gallery } = await import("./+page.svelte");
	const { body } = render(Gallery, { props: { data: { images: [] } } as never });
	expect(root(body)).toContain(`data-read-cap="${readCap}"`);
});

test("a saved item's root renders the read cap", async () => {
	const { default: Item } = await import("./[jobId]/+page.svelte");
	const image = {
		jobId: "6b0e3f4a-3c2d-4e5f-8a9b-0c1d2e3f4a5b",
		mime: "image/png",
		width: 5000,
		height: 4000,
		size: 1,
		savedAt: 0,
		available: false,
	};
	const { body } = render(Item, { props: { data: { image } } as never });
	expect(root(body)).toContain(`data-read-cap="${readCap}"`);
});
