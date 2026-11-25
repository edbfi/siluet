import { expect, test } from "bun:test";
import { Glob } from "bun";

// Pages are shells without a bearer, so a native form post can never be admitted. Every POST
// form submits through `enhance` or its own handler, which send the tab's bearer.
test("every POST form in src submits through enhance or a handler", async () => {
	const unhandled: string[] = [];
	for (const file of new Glob("**/*.svelte").scanSync("src")) {
		const text = await Bun.file(`src/${file}`).text();
		for (const [form] of text.matchAll(/<form\b[^>]*>/gs))
			if (/method="POST"/i.test(form) && !/use:enhance|onsubmit=/.test(form))
				unhandled.push(`${file}: ${form.replace(/\s+/g, " ").slice(0, 80)}`);
	}
	expect(unhandled).toEqual([]);
});
