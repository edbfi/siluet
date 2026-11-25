/**
 * Cookie sessions before browser-key sessions (D1). Siluet never authenticates with a cookie;
 * documents only expire this installation's old cookies at their original paths, reading the
 * names in the request and never their values.
 */
export function legacyCookieDeletions(
	cookieHeader: string | null,
	installation: string,
	origin: Pick<URL, "port" | "protocol">,
) {
	if (!cookieHeader) return [];
	// The old notice cookies named a default port explicitly.
	const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
	const id = installation.replace(/[^0-9a-f-]/g, "");
	const rules: [RegExp, string][] = [
		[new RegExp(`^siluet_${id}$`), "/"],
		[new RegExp(`^siluet_(?:signout|security)_${port}$`), "/"],
		[new RegExp(`^siluet_${id}_pending(?:_[0-9a-f]{64})?$`), "/sign-in"],
		[new RegExp(`^siluet_${id}_setup_[0-9a-f]{64}_[0-9a-f]{64}$`), "/settings/security"],
	];
	const deletions = new Set<string>();
	for (const pair of cookieHeader.split(";")) {
		const name = pair.split("=", 1)[0].trim();
		const path = rules.find(([pattern]) => pattern.test(name))?.[1];
		if (path) deletions.add(`${name}=; Path=${path}; Max-Age=0; SameSite=Lax`);
	}
	return [...deletions];
}
