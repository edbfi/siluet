import { bitReader } from "./bits";
import { check } from "./errors";
import { fields } from "./mp4-boxes";

// MPEG-4 audio in MP4: esds (ISO/IEC 14496-1 §7.2.6) to AudioSpecificConfig (14496-3 §1.6.2.1).

const rates = [
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const mpeg4Audio = 0x40;
const audioStream = 5;
const aacLc = 2;
const syncExtension = 0x2b7;
const sbr = 5;

/**
 * Read the rest of GASpecificConfig and any backward-compatible sync extension after it
 * (14496-3 §1.6.2.1, §4.4.1). Plain AAC-LC has no extension, or one with object type 5 that
 * declares SBR absent followed only by zero padding, which also rules out PS. Anything else,
 * including trailing bits that are not a sync extension, is not plain. Never refuses: D6 accepts these configurations.
 */
function plainLowComplexity(bits: ReturnType<typeof bitReader>) {
	const take = (count: number) => (bits.remaining() >= count ? bits.bits(count) : -1);
	const dependsOnCoreCoder = take(1);
	if (dependsOnCoreCoder === 1 && take(14) < 0) return false; // coreCoderDelay
	const extensionFlag = take(1);
	// extensionFlag3 = 1 announces reserved version-3 syntax, so the extension boundary is unknown.
	if (extensionFlag < 0 || (extensionFlag === 1 && take(1) !== 0)) return false;
	if (bits.remaining() < 16) return true;
	if (take(11) !== syncExtension || take(5) !== sbr || take(1) !== 0) return false;
	// PS is signalled only after SBR present, so only zero padding may follow SBR absent.
	while (bits.remaining() > 0) if (take(1) !== 0) return false;
	return true;
}

/**
 * Read the descriptors in an `esds` payload and accept only AAC-LC, ≤ 48 kHz, mono or stereo.
 * Returns the samples per access unit from GASpecificConfig's frameLengthFlag, and whether
 * the configuration is plain AAC-LC with no SBR or PS signalled.
 */
export function checkAacConfig(esds: Buffer) {
	const read = fields(esds);
	check(read.u32(0) === 0, "esds version");
	let at = 4;
	const descriptor = (tag: number) => {
		check(read.u8(at) === tag, `descriptor ${tag}`);
		at++;
		let length = 0;
		for (let i = 0; ; i++) {
			check(i < 4, "descriptor length");
			const byte = read.u8(at++);
			length = length * 128 + (byte & 0x7f);
			if (!(byte & 0x80)) break;
		}
		check(at + length <= read.length, "descriptor overruns esds");
		return length;
	};
	descriptor(0x03);
	at += 2; // ES_ID
	const flags = read.u8(at++);
	check(!(flags & 0x40), "external audio reference");
	if (flags & 0x80) at += 2;
	if (flags & 0x20) at += 2;
	descriptor(0x04);
	check(read.u8(at) === mpeg4Audio, "audio object type indication");
	check(read.u8(at + 1) >> 2 === audioStream, "audio stream type");
	at += 13;
	const length = descriptor(0x05);
	const bits = bitReader(read.bytes(at, length), "AudioSpecificConfig");
	let type = bits.bits(5);
	if (type === 31) type = 32 + bits.bits(6);
	check(type === aacLc, `audio object type ${type}`);
	const index = bits.bits(4);
	const sampleRate = index === 15 ? bits.bits(24) : (rates[index] ?? 0);
	check(sampleRate > 0 && sampleRate <= 48000, "audio sample rate");
	const channels = bits.bits(4);
	check(channels === 1 || channels === 2, "audio channel count");
	const frameLength = bits.bit() ? 960 : 1024;
	return { sampleRate, channels, frameLength, plain: plainLowComplexity(bits) };
}
