export const signOutNoticeValue = "1";

export function signOutNoticeName({ port, protocol }: Pick<URL, "port" | "protocol">): string {
	return `siluet_signout_${port || (protocol === "https:" ? "443" : "80")}`;
}

export function watchSignOut(discardDraft: () => void): () => void {
	const name = signOutNoticeName(location);
	const notice = `${name}=${signOutNoticeValue}`;
	const checkCookie = () => {
		if (document.cookie.split(";").some((cookie) => cookie.trim() === notice)) discardDraft();
	};
	checkCookie();

	const store = globalThis.cookieStore;
	if (!store) {
		const interval = window.setInterval(checkCookie, 1000);
		return () => window.clearInterval(interval);
	}

	const onChange = ({ changed }: CookieChangeEvent) => {
		if (changed.some((cookie) => cookie.name === name && cookie.value === signOutNoticeValue)) {
			discardDraft();
		}
	};
	store.addEventListener("change", onChange);
	return () => store.removeEventListener("change", onChange);
}
