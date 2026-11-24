import { check } from "./errors";
import { contentCredentialsByteLimit } from "./limits";
import { fields } from "./mp4-boxes";

// A C2PA manifest box in ISO BMFF (C2PA 2.2 §A.5.1.2): a top-level `uuid` FullBox whose
// `manifest` data is a Merkle offset and a JUMBF manifest store (§11.1.4.2). Siluet checks its
// framing and keeps the store itself opaque (D6).

const extendedType = Buffer.from("d8fec3d61b0e483c92975828877ec481", "hex");
const storeType = Buffer.from("6332706100110010800000aa00389b71", "hex");
const purpose = "manifest\0";
// A `jumd` with only the requestable and label toggles, and the label "c2pa".
const description = { size: 8 + 16 + 1 + 5, toggles: 3, label: "c2pa\0" };

/** Enough bytes for the widest accepted headers: box 16, FullBox fields 37, `jumb` 16, `jumd` 30. */
export const contentCredentialsPrefix = 128;

/**
 * Check a top-level `uuid` box of `size` bytes with a `header`-byte header from `prefix`, its
 * first `contentCredentialsPrefix` bytes or fewer. Any `uuid` other than one framed C2PA
 * manifest store that fills its box is refused.
 */
export function checkContentCredentials(prefix: Buffer, header: number, size: number) {
	const read = fields(prefix);
	check(read.bytes(header, 16).equals(extendedType), "uuid at the top level");
	check(size <= contentCredentialsByteLimit, "content credentials over 1 MiB");
	check(read.u32(header + 16) === 0, "content credentials version");
	check(read.latin1(header + 20, purpose.length) === purpose, "content credentials purpose");
	const merkle = header + 20 + purpose.length;
	check(read.u64(merkle) === 0, "content credentials Merkle offset");
	const store = merkle + 8;
	check(read.latin1(store + 4, 4) === "jumb", "content credentials store");
	const wide = read.u32(store) === 1;
	const length = wide ? read.u64(store + 8) : read.u32(store);
	const storeHeader = wide ? 16 : 8;
	check(length >= storeHeader + description.size, "content credentials store size");
	check(store + length === size, "content credentials store must fill its box");
	const at = store + storeHeader;
	check(
		read.u32(at) === description.size &&
			read.latin1(at + 4, 4) === "jumd" &&
			read.bytes(at + 8, 16).equals(storeType) &&
			read.u8(at + 24) === description.toggles &&
			read.latin1(at + 25, description.label.length) === description.label,
		"content credentials description",
	);
}
