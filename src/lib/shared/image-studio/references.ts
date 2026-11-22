import {
	localImageLimit,
	localImageLimitRefusal,
	maxLocalImageBytes,
} from "../media-staging/limits";
import { hasCompleteGifStream } from "./gif";
import { isPublicIpv6 } from "./ipv6";
import type { SeedreamProvider } from "./seedream";

export type LocalReference = { kind: "file"; file: File };
export type RemoteReference = { kind: "url"; url: string; hostname: string };
export type SeedreamReference = LocalReference | RemoteReference;

export const maxSeedreamReferences = 10;
export const publicReferenceUrlError =
	"Enter a public HTTP or HTTPS URL without a username or password.";

export function duplicateReferenceSlots(
	references: readonly SeedreamReference[],
): [first: number, duplicate: number] | null {
	const seen = new Map<string, number>();
	for (const [index, reference] of references.entries()) {
		if (reference.kind !== "url") continue;
		const url = reference.url.trim();
		const slot = index + 1;
		const first = seen.get(url);
		if (first !== undefined) return [first, slot];
		seen.set(url, slot);
	}
	return null;
}

const fileTypes = {
	jpeg: { name: "JPEG", mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
	png: { name: "PNG", mime: "image/png", extensions: [".png"] },
	webp: { name: "WebP", mime: "image/webp", extensions: [".webp"] },
	gif: { name: "GIF", mime: "image/gif", extensions: [".gif"] },
};

const stillFormats = ["jpeg", "png", "webp"] as const;
// Before a provider is connected, only a local copy can be prepared for offline Review.
const localLimits = {
	formats: ["jpeg", "png"],
	maxBytes: maxLocalImageBytes,
	description: localImageLimit,
} as const;
// A JPEG or PNG is always prepared locally first, under the shared source limit.
// `maxBytes` applies to the WebP or GIF a provider accepts as it is.
const referenceLimits = {
	poyo: {
		formats: stillFormats,
		maxBytes: 10_000_000,
		description: `${localImageLimit}, or WebP up to 10 MB`,
	},
	toapis: {
		formats: [...stillFormats, "gif"],
		maxBytes: 30_000_000,
		description: `${localImageLimit}, or WebP or GIF up to 30 MB`,
	},
} as const;

const limitsFor = (provider: SeedreamProvider | null) =>
	provider ? referenceLimits[provider] : localLimits;

export function referenceFileAccept(provider: SeedreamProvider | null): string {
	return limitsFor(provider)
		.formats.flatMap((format) => {
			const { mime, extensions } = fileTypes[format];
			return [mime, ...extensions];
		})
		.join(",");
}

export function referenceFileHelp(provider: SeedreamProvider | null): string {
	return limitsFor(provider).description;
}

function fileFormat(provider: SeedreamProvider | null, file: Pick<File, "name" | "type">) {
	const type = file.type.toLowerCase();
	const name = file.name.toLowerCase();
	return limitsFor(provider).formats.find((format: keyof typeof fileTypes) => {
		const { mime, extensions } = fileTypes[format];
		return type && type !== "application/octet-stream"
			? type === mime
			: extensions.some((extension) => name.endsWith(extension));
	});
}

export function referenceFileError(
	provider: SeedreamProvider | null,
	file: Pick<File, "name" | "size" | "type">,
): string | null {
	const { maxBytes, description } = limitsFor(provider);
	const format = fileFormat(provider, file);
	if (!format || file.size < 1)
		return `Choose a non-empty image. Supported files are ${description}.`;
	// A JPEG or PNG is prepared locally first. Its cleaned size is checked again later.
	if (format === "jpeg" || format === "png")
		return file.size > maxLocalImageBytes ? localImageLimitRefusal.join(" ") : null;
	return file.size > maxBytes
		? `Choose a non-empty image. Supported files are ${description}.`
		: null;
}

export async function checkReferenceFile(
	provider: SeedreamProvider | null,
	file: File,
): Promise<string | null> {
	const error = referenceFileError(provider, file);
	if (error) return error;

	const format = fileFormat(provider, file);
	let bytes: Uint8Array;
	try {
		const source = format === "gif" ? file : file.slice(0, 16);
		bytes = new Uint8Array(await source.arrayBuffer());
	} catch {
		return "Could not read this file. Choose it again.";
	}
	if (imageFormat(bytes) !== format) {
		const names = limitsFor(provider).formats.map((name) => fileTypes[name].name);
		return `Choose a valid ${names.slice(0, -1).join(", ")} or ${names.at(-1)} image.`;
	}
	if (format === "gif" && !hasCompleteGifStream(bytes)) return "Choose a complete GIF file.";
	return null;
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

// These TLDs are reserved for local, non-DNS or infrastructure use.
// https://www.iana.org/assignments/special-use-domain-names
// https://www.iana.org/domains/arpa
const nonPublicTlds = new Set([
	"alt",
	"arpa",
	"example",
	"internal",
	"invalid",
	"local",
	"localhost",
	"onion",
	"test",
]);

// The browser can rule out local names and non-public address literals without DNS or requests.
function isPublicHostname(hostname: string): boolean {
	const host = hostname.replace(/\.$/, "");
	if (host.startsWith("[")) return isPublicIpv6(host);
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
			(first === 192 && second === 88 && third === 99) ||
			(first === 192 && second === 0 && (third === 0 || third === 2)) ||
			(first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
			(first === 203 && second === 0 && third === 113)
		);
	}
	const labels = host.split(".");
	return (
		labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
		labels.length > 1 &&
		!nonPublicTlds.has(labels[labels.length - 1])
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
