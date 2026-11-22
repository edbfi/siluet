import type { EntropyReader, Huffman } from "./jpeg-entropy";
import { refuseJpeg } from "./jpeg-errors";

// Progressive Huffman scans, decoded as ITU-T T.81 Annex G.1.2 and libjpeg's
// jdphuff.c read them, so the walk ends exactly where the decoder stops.
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf

type Component = { index: number; dc: Huffman; ac: Huffman };
export type ProgressiveScan = {
	ss: number;
	se: number;
	ah: number;
	al: number;
	components: Component[];
};

/**
 * Per frame component: the Al each coefficient was last coded with (-1 before
 * its first scan), and two words per block marking its nonzero AC coefficients.
 */
export type Progression = { coded: Int8Array[]; nonzero: Uint32Array[] };

// G.1.1.1.1: DC before AC, one first scan per coefficient, then refinements one
// bit at a time. libjpeg warns otherwise, and refinement depends on that history.
function advance(progression: Progression, { ss, se, ah, al, components }: ProgressiveScan) {
	for (const { index } of components) {
		progression.coded[index] ??= new Int8Array(64).fill(-1);
		const coded = progression.coded[index];
		if (ss && coded[0] < 0) refuseJpeg("invalid");
		for (let k = ss; k <= se; k++) {
			if (ah ? coded[k] !== ah : coded[k] >= 0) refuseJpeg("invalid");
			coded[k] = al;
		}
	}
}

function ones(word: number) {
	let v = word - ((word >>> 1) & 0x55555555);
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/**
 * Read one progressive scan block by block. An AC scan codes a single component,
 * so its `block` index runs over that component's `blocks`.
 */
export function progressiveCoder(
	reader: EntropyReader,
	scan: ProgressiveScan,
	progression: Progression,
	blocks: number,
) {
	advance(progression, scan);
	const { ss, se, ah } = scan;
	if (ss === 0) {
		// G.1.2.1: a first DC scan codes a difference category and its bits; a
		// refinement codes one bit per block.
		const block = ({ dc }: Component) => {
			if (ah) {
				reader.read(1);
				return;
			}
			const size = reader.decode(dc);
			if (size > 11) refuseJpeg("invalid");
			reader.read(size);
		};
		return { restart() {}, block };
	}

	const [{ index, ac }] = scan.components;
	// The frame limits keep this under 253,000 blocks, 2 MiB, per component.
	progression.nonzero[index] ??= new Uint32Array(blocks * 2);
	const nonzero = progression.nonzero[index];
	const mark = (block: number, k: number) => {
		nonzero[block * 2 + (k >> 5)] |= 1 << (k & 31);
	};
	const isNonzero = (block: number, k: number) => (nonzero[block * 2 + (k >> 5)] >>> (k & 31)) & 1;
	// One correction bit per nonzero coefficient from k to Se, counted a word at a time.
	const correct = (block: number, k: number) => {
		let bits = 0;
		for (let word = k >> 5; word <= se >> 5; word++) {
			const low = word === k >> 5 ? k & 31 : 0;
			const high = word === se >> 5 ? se & 31 : 31;
			bits += ones(nonzero[block * 2 + word] & (0xffffffff >>> (31 - high)) & (-1 << low));
		}
		for (; bits > 15; bits -= 15) reader.read(15);
		reader.read(bits);
	};
	// G.1.2.2: EOBn starts a run of 2^n plus n more bits of blocks whose band ends here.
	let eobrun = 0;
	const endOfBands = (run: number) => (1 << run) + reader.read(run);

	// G.1.2.2: run/size pairs, ZRL and EOBn within the band Ss..Se.
	const first = (_: Component, block: number) => {
		if (eobrun) {
			eobrun--;
			return;
		}
		for (let k = ss; k <= se; k++) {
			const symbol = reader.decode(ac);
			const run = symbol >> 4;
			const size = symbol & 15;
			if (size) {
				k += run;
				if (k > se || size > 10) refuseJpeg("invalid");
				reader.read(size);
				mark(block, k);
			} else if (run === 15) {
				k += 15;
				if (k > se) refuseJpeg("invalid");
			} else {
				eobrun = endOfBands(run) - 1;
				return;
			}
		}
	};

	// G.1.2.3: a new coefficient is ±1 after `run` zero coefficients. Every
	// already-nonzero coefficient passed over, including those in an end-of-band
	// run, carries one correction bit.
	const refine = (_: Component, block: number) => {
		let k = ss;
		if (!eobrun) {
			for (; k <= se; k++) {
				const symbol = reader.decode(ac);
				let run = symbol >> 4;
				const size = symbol & 15;
				if (size) {
					if (size !== 1) refuseJpeg("invalid");
					reader.read(1);
				} else if (run !== 15) {
					eobrun = endOfBands(run);
					break;
				}
				for (; k <= se; k++) {
					if (isNonzero(block, k)) reader.read(1);
					else if (--run < 0) break;
				}
				if (k > se) refuseJpeg("invalid");
				if (size) mark(block, k);
			}
		}
		if (eobrun) {
			correct(block, k);
			eobrun--;
		}
	};

	return {
		restart() {
			eobrun = 0;
		},
		block: ah ? refine : first,
	};
}
