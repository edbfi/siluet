import type { SeedreamProvider } from "./seedream";

export type LocalReference = { kind: "file"; file: File };
export type RemoteReference = { kind: "url"; url: string; hostname: string };
export type SeedreamReference = LocalReference | RemoteReference;

export const maxSeedreamReferences = 10;
export const publicReferenceUrlError =
	"Enter a public HTTP or HTTPS URL without a username or password.";

const fileTypes = {
	jpeg: { mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
	png: { mime: "image/png", extensions: [".png"] },
	webp: { mime: "image/webp", extensions: [".webp"] },
	gif: { mime: "image/gif", extensions: [".gif"] },
};

const stillFormats = ["jpeg", "png", "webp"] as const;
const referenceLimits = {
	poyo: {
		formats: stillFormats,
		maxBytes: 10_000_000,
		description: "JPEG, PNG or WebP up to 10 MB",
	},
	toapis: {
		formats: [...stillFormats, "gif"],
		maxBytes: 30_000_000,
		description: "JPEG, PNG, WebP or GIF up to 30 MB",
	},
} as const;

export function referenceFileAccept(provider: SeedreamProvider): string {
	return referenceLimits[provider].formats
		.flatMap((format) => {
			const { mime, extensions } = fileTypes[format];
			return [mime, ...extensions];
		})
		.join(",");
}

export function referenceFileHelp(provider: SeedreamProvider): string {
	return referenceLimits[provider].description;
}

function fileFormat(provider: SeedreamProvider, file: Pick<File, "name" | "type">) {
	const type = file.type.toLowerCase();
	const name = file.name.toLowerCase();
	return referenceLimits[provider].formats.find((format) => {
		const { mime, extensions } = fileTypes[format];
		return type && type !== "application/octet-stream"
			? type === mime
			: extensions.some((extension) => name.endsWith(extension));
	});
}

export function referenceFileError(
	provider: SeedreamProvider,
	file: Pick<File, "name" | "size" | "type">,
): string | null {
	const { maxBytes, description } = referenceLimits[provider];
	return fileFormat(provider, file) && file.size > 0 && file.size <= maxBytes
		? null
		: `Choose a non-empty image. Supported files are ${description}.`;
}

export async function checkReferenceFile(
	provider: SeedreamProvider,
	file: File,
): Promise<string | null> {
	const error = referenceFileError(provider, file);
	if (error) return error;

	let header: Uint8Array;
	try {
		header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	} catch {
		return "Could not read this file. Choose it again.";
	}
	return imageFormat(header) === fileFormat(provider, file)
		? null
		: `Choose a valid ${referenceFileHelp(provider)}.`;
}

function imageFormat(bytes: Uint8Array): keyof typeof fileTypes | undefined {
	const startsWith = (...signature: number[]) =>
		signature.every((byte, index) => bytes[index] === byte);
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (startsWith(137, 80, 78, 71, 13, 10, 26, 10) && tag(12) === "IHDR") return "png";
	if (startsWith(0xff, 0xd8, 0xff)) return "jpeg";
	const gifVersion = String.fromCharCode(...bytes.subarray(0, 6));
	if (bytes.length >= 13 && (gifVersion === "GIF87a" || gifVersion === "GIF89a")) return "gif";
	if (tag(0) === "RIFF" && tag(8) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(tag(12))) {
		return "webp";
	}
}

// The browser can rule out local names and non-public address literals without DNS or requests.
function isPublicHostname(hostname: string): boolean {
	const host = hostname.replace(/\.$/, "");
	if (host.startsWith("[")) {
		return /^\[[23][0-9a-f]{3}:/.test(host) && !/^\[(?:2001:db8:|3fff:)/.test(host);
	}
	const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
	if (ipv4) {
		const [, first, second, third] = ipv4.map(Number);
		return !(
			first === 0 ||
			first === 10 ||
			first === 127 ||
			first >= 224 ||
			(first === 100 && second >= 64 && second <= 127) ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			(first === 192 && second === 0 && (third === 0 || third === 2)) ||
			(first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
			(first === 203 && second === 0 && third === 113)
		);
	}
	return (
		host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
		host.includes(".") &&
		![".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => host.endsWith(suffix))
	);
}

export function parseReferenceUrl(value: string): RemoteReference | null {
	const url = value.trim();
	const authority = /^https?:\/\/([^/?#\\]+)/i.exec(url)?.[1];
	if (!authority || authority.includes("@") || /[\s\\\p{Cc}]/u.test(url)) {
		return null;
	}
	const parsed = URL.parse(url);
	if (!parsed || !isPublicHostname(parsed.hostname)) return null;
	return { kind: "url", url, hostname: parsed.hostname };
}
