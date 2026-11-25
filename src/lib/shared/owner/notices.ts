/**
 * Hints that another tab of this origin changed the owner's session. They only prompt a
 * check; the server's answer decides. A BroadcastChannel carries them, and localStorage
 * covers browsers or moments where the channel is unavailable.
 */
export type NoticeKind = "claim" | "sign-in" | "factor" | "security" | "sign-out";
export type Notice = { id: string; kind: NoticeKind; sessionId: string | null };

const kinds: readonly string[] = ["claim", "sign-in", "factor", "security", "sign-out"];
const isNotice = (value: unknown): value is Notice =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Notice).id === "string" &&
	kinds.includes((value as Notice).kind) &&
	((value as Notice).sessionId === null || typeof (value as Notice).sessionId === "string");

export function createNotices(installation: string, receive: (notice: Notice) => void) {
	const name = `siluet-owner-${installation}`;
	const seen = new Set<string>();
	const accept = (value: unknown) => {
		if (!isNotice(value) || seen.has(value.id)) return;
		seen.add(value.id);
		receive(value);
	};
	let channel: BroadcastChannel | null = null;
	try {
		channel = new BroadcastChannel(name);
		channel.onmessage = (event) => accept(event.data);
	} catch {}
	const onStorage = (event: StorageEvent) => {
		if (event.key !== name || !event.newValue) return;
		try {
			accept(JSON.parse(event.newValue));
		} catch {}
	};
	addEventListener("storage", onStorage);
	return {
		post(kind: NoticeKind, sessionId: string | null) {
			const notice: Notice = { id: crypto.randomUUID(), kind, sessionId };
			seen.add(notice.id);
			try {
				channel?.postMessage(notice);
			} catch {}
			try {
				localStorage.setItem(name, JSON.stringify(notice));
			} catch {}
		},
		close() {
			channel?.close();
			removeEventListener("storage", onStorage);
		},
	};
}
