import { type BrowserContext, test as base, expect } from "@playwright/test";

/**
 * Every browser test fails on a Content Security Policy violation in any page it opens,
 * so the journeys prove the built pages work under the studio's policy.
 */
export const test = base.extend<{ cspViolations: string[] }>({
	cspViolations: [
		async ({ browser, context }, use) => {
			const violations: string[] = [];
			const watched = new WeakSet<BrowserContext>();
			const watch = (target: BrowserContext) => {
				if (watched.has(target)) return;
				watched.add(target);
				target.on("console", (message) => {
					if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
				});
			};
			watch(context);
			const { newContext, newPage } = browser;
			browser.newContext = async (...options) => {
				const created = await newContext.apply(browser, options);
				watch(created);
				return created;
			};
			browser.newPage = async (...options) => {
				const created = await newPage.apply(browser, options);
				watch(created.context());
				return created;
			};
			try {
				await use(violations);
			} finally {
				browser.newContext = newContext;
				browser.newPage = newPage;
			}
			expect(violations).toEqual([]);
		},
		{ auto: true },
	],
});
