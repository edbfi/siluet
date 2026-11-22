import { expect, test } from "bun:test";
import type { Cookies, RequestEvent } from "@sveltejs/kit";
import { pendingCredential, setCredential } from "./cookies";
import { token } from "./credentials";
import { authenticate } from "./form";

function response(jar: Map<string, string>) {
	const incoming = new Map(jar);
	const outgoing = new Map<string, string | null>();
	const cookies = {
		get: (key: string) => incoming.get(key),
		set: (key: string, value: string) => outgoing.set(key, value),
		delete: (key: string) => outgoing.set(key, null),
	} as unknown as Cookies;
	return {
		cookies,
		outgoing,
		deliver() {
			for (const [key, value] of outgoing) {
				if (value === null) jar.delete(key);
				else jar.set(key, value);
			}
		},
	};
}

test.each(["factor", "cancel"] as const)(
	"a delayed %s response removes just the spent pending cookie",
	async (action) => {
		const origin = new URL("http://127.0.0.1");
		const jar = new Map<string, string>();
		const name = "fixture",
			old = token(),
			next = token(),
			session = token();
		const issue = (value: string) => {
			const r = response(jar);
			setCredential(r.cookies, name, value, origin, true);
			r.deliver();
		};
		issue(old);
		const oldName = [...jar].find(([, v]) => v === old)?.[0];
		if (!oldName) throw new Error("Missing first credential.");
		const delayed = response(jar);
		let submitted = "";
		const verify = async (value: string) => {
			submitted = value;
			return session;
		};
		await expect(
			authenticate(
				{
					request: new Request(origin, {
						method: "POST",
						body: new URLSearchParams({ action, code: "123456" }),
					}),
					cookies: delayed.cookies,
					locals: {
						studio: {
							origin,
							cookieName: name,
							access: { security: { complete: verify, cancel: verify } },
						},
					},
				} as unknown as RequestEvent,
				false,
			),
		).rejects.toMatchObject({ status: 303 });
		expect(submitted === old).toBe(true);
		issue(next);
		delayed.deliver();
		expect(delayed.outgoing.get(oldName)).toBeNull();
		expect([...jar.values()].includes(old)).toBe(false);
		expect(pendingCredential(response(jar).cookies, name) === next).toBe(true);
	},
);
