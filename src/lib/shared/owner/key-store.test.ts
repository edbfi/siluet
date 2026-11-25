import { expect, test } from "bun:test";
import { browserName } from "./key-store";

// The key error names the browser by its most specific product token, not the last one.
test("the key error names the browser the owner is using", () => {
	const agents = {
		"Chrome/159.0.0.0":
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36",
		"Edg/159.0.0.0":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36 Edg/159.0.0.0",
		"Firefox/159.0": "Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0",
		"Safari/27.2":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15",
	};
	for (const [name, agent] of Object.entries(agents)) expect(browserName(agent)).toBe(name);
});
