import { json } from "@sveltejs/kit";
import { isKeyPurpose, type KeyPurpose } from "../../../shared/owner/key-message";
import type { Issued } from "../../db/access-store";
import type { OwnerAccess } from "./access";
import { AccessError } from "./access-error";
import { accessBody } from "./access-response";
import { verifyKeySignature } from "./browser-key";
import type { Challenges } from "./challenges";
import { sessionDigest } from "./credentials";

const noStore = { "cache-control": "no-store" };
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	json(body, { status, headers: { ...noStore, ...headers } });
const message = (text: string, status: number) => reply({ message: text }, status);
const forbidden = () => message("Sign in again from this page.", 403);
const string = (value: unknown, max = 2048) =>
	typeof value === "string" && value.length <= max ? value : null;
const issued = ({ bearer, sessionId, loginId }: Issued) => reply({ bearer, sessionId, loginId });

class Refused extends Error {
	constructor(readonly response: Response) {
		super("refused");
	}
}

/**
 * The signed owner endpoints ([browser key sessions](../../../../../docs/SPEC-browser-key.md)).
 * Each spends its nonce and verifies the browser key's signature before the access check,
 * storage or password work.
 */
export function createBrowserSessions(studio: {
	access: OwnerAccess;
	challenges: Challenges;
	origin: URL;
	installation: string;
	hasOwner: () => Promise<boolean>;
	checkAccess: () => Promise<void>;
}) {
	const { access, challenges } = studio;
	async function body(request: Request) {
		if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
			throw new Refused(new Response(null, { status: 415, headers: noStore }));
		const value = await request.json().catch(() => null);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Refused(message("Send a JSON object.", 400));
		return value as Record<string, unknown>;
	}
	/** Spend the nonce, then verify; only then check access. */
	async function verified(
		purpose: KeyPurpose,
		fields: Record<string, unknown>,
		binding: (key: string) => string | null,
	) {
		const key = string(fields.key, 256);
		const spent = challenges.consume(purpose, fields.nonce);
		const bound = key === null ? null : binding(key);
		if (
			!spent ||
			key === null ||
			bound === null ||
			!(await verifyKeySignature(key, fields.signature, {
				purpose,
				origin: studio.origin.origin,
				installation: studio.installation,
				binding: bound,
				nonce: fields.nonce as string,
			}))
		)
			throw new Refused(forbidden());
		try {
			await studio.checkAccess();
		} catch (error) {
			if (error instanceof AccessError) throw new Refused(reply(accessBody(error), error.status));
			throw error;
		}
		return key;
	}
	async function run(
		request: Request,
		work: (fields: Record<string, unknown>) => Promise<Response>,
	) {
		try {
			return await work(await body(request));
		} catch (error) {
			if (error instanceof Refused) return error.response;
			if (error instanceof AccessError) return message(error.message, error.status);
			throw error;
		}
	}
	return {
		challenge: (request: Request) =>
			run(request, async ({ purpose }) => {
				if (!isKeyPurpose(purpose)) return message("Unknown purpose.", 400);
				const nonce = challenges.issue(purpose);
				return nonce ? reply({ nonce }) : message("Too many attempts. Try again in a minute.", 429);
			}),
		claim: (request: Request) =>
			run(request, async (fields) => {
				const key = await verified("claim", fields, () => "");
				return issued(
					await access.claim(
						string(fields.token, 256) ?? "",
						string(fields.username) ?? "",
						string(fields.password, 8192) ?? "",
						key,
					),
				);
			}),
		signIn: (request: Request) =>
			run(request, async (fields) => {
				const key = await verified("sign-in", fields, () => "");
				const result = await access.signIn(
					string(fields.username) ?? "",
					string(fields.password, 8192) ?? "",
					key,
				);
				return result.kind === "pending" ? reply({ proof: result.token }) : issued(result);
			}),
		factor: (request: Request) =>
			run(request, async (fields) => {
				const proof = string(fields.proof, 64);
				const key = await verified("factor", fields, () => (proof ? sessionDigest(proof) : null));
				if (!proof) return forbidden();
				if (fields.cancel === true) {
					await access.security.cancel(proof, key);
					return reply({ cancelled: true });
				}
				return issued(await access.security.complete(proof, key, string(fields.code, 64) ?? ""));
			}),
		resume: (request: Request) =>
			run(request, async (fields) => {
				const key = await verified("resume", fields, (spki) => spki);
				const result = await access.resume(key, fields.previous);
				if (result) return issued(result);
				return reply(
					{
						message: "Your session ended. Sign in again.",
						location: (await studio.hasOwner()) ? "/sign-in" : "/setup",
					},
					401,
				);
			}),
		signOut: (request: Request) =>
			run(request, async (fields) => {
				const loginId = string(fields.loginId, 64);
				const key = await verified("sign-out", fields, () => loginId);
				const outcome = await access.signOut(key, loginId ?? "");
				return outcome === "other"
					? message("This browser signed in again since.", 409)
					: reply({ signedOut: true });
			}),
	};
}
export type BrowserSessions = ReturnType<typeof createBrowserSessions>;
