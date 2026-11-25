import { check } from "./errors";

/** A bounded MSB-first bit reader for codec configuration records. */
export function bitReader(bytes: Uint8Array, what: string) {
	let position = 0;
	const bit = () => {
		check(position < bytes.length * 8, `${what} ends early`);
		const value = (bytes[position >> 3] >> (7 - (position & 7))) & 1;
		position++;
		return value;
	};
	const bits = (count: number) => {
		let value = 0;
		for (let i = 0; i < count; i++) value = value * 2 + bit();
		return value;
	};
	/** Unsigned exp-Golomb, limited to 32-bit codes. */
	const ue = () => {
		let zeros = 0;
		while (!bit()) check(++zeros < 32, `${what} has an oversized code`);
		return 2 ** zeros - 1 + bits(zeros);
	};
	return {
		bit,
		bits,
		/** The bits left unread. */
		remaining: () => bytes.length * 8 - position,
		ue,
		se() {
			const code = ue();
			return code % 2 ? (code + 1) / 2 : -code / 2;
		},
	};
}
