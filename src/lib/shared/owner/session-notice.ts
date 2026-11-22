export function signOutNoticeName({ port, protocol }: Pick<URL, "port" | "protocol">): string {
	return `siluet_signout_${port || (protocol === "https:" ? "443" : "80")}`;
}

export const securityNoticeName = (url: Pick<URL, "port" | "protocol">) =>
	signOutNoticeName(url).replace("signout", "security");

export function watchNotice(
	name: string,
	generation: string | null,
	discardDraft: () => void,
): () => void {
	const prefix = `${name}=`;
	const checkCookie = () => {
		const notice = document.cookie
			.split(";")
			.map((cookie) => cookie.trim())
			.find((cookie) => cookie.startsWith(prefix));
		const next = notice?.slice(prefix.length) ?? null;
		if (next !== generation) {
			generation = next;
			discardDraft();
		}
	};

	const listeners = new AbortController();
	const { signal } = listeners;
	window.addEventListener("focus", checkCookie, { signal });
	window.addEventListener("pageshow", checkCookie, { signal });
	document.addEventListener("visibilitychange", checkCookie, { signal });
	const store = globalThis.cookieStore;
	store?.addEventListener(
		"change",
		({ changed, deleted }) => {
			if (
				changed.some((cookie) => cookie.name === name) ||
				deleted.some((cookie) => cookie.name === name)
			) {
				checkCookie();
			}
		},
		{ signal },
	);
	const interval = store ? undefined : window.setInterval(checkCookie, 1000);
	checkCookie();
	return () => {
		listeners.abort();
		if (interval !== undefined) window.clearInterval(interval);
	};
}
