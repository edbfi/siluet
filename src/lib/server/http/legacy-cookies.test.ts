import { expect, test } from "bun:test";
import { legacyCookieDeletions } from "./legacy-cookies";

const id = "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f";
const hex = "a".repeat(64);

test("this installation's legacy cookies expire at their original paths", () => {
	const header = [
		`siluet_${id}=secret`,
		"siluet_signout_3000=x",
		"siluet_security_3000=x",
		`siluet_${id}_pending=${hex}`,
		`siluet_${id}_pending_${hex}=proof`,
		`siluet_${id}_setup_${hex}_${"b".repeat(64)}=grant`,
	].join("; ");
	expect(legacyCookieDeletions(header, id, "3000")).toEqual([
		`siluet_${id}=; Path=/; Max-Age=0; SameSite=Lax`,
		"siluet_signout_3000=; Path=/; Max-Age=0; SameSite=Lax",
		"siluet_security_3000=; Path=/; Max-Age=0; SameSite=Lax",
		`siluet_${id}_pending=; Path=/sign-in; Max-Age=0; SameSite=Lax`,
		`siluet_${id}_pending_${hex}=; Path=/sign-in; Max-Age=0; SameSite=Lax`,
		`siluet_${id}_setup_${hex}_${"b".repeat(64)}=; Path=/settings/security; Max-Age=0; SameSite=Lax`,
	]);
});

test("another installation's, another port's and unrelated cookies stay", () => {
	const other = "11111111-2222-4333-8444-555555555555";
	const header = [
		`siluet_${other}=x`,
		"siluet_signout_3001=x",
		"session=x",
		`siluet_${id}_pending_short=x`,
		`siluet_${id}x=x`,
	].join("; ");
	expect(legacyCookieDeletions(header, id, "3000")).toEqual([]);
	expect(legacyCookieDeletions(null, id, "3000")).toEqual([]);
});
