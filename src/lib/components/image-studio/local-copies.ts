/**
 * Plain coordination for the attached files of one draft: one copy per File however many
 * slots use it, preparations one at a time in the order asked, and deletions a later
 * preparation waits for. The reactive copies live in `local-copy.svelte.ts`.
 */

export type SlotFile = { key: number; file: File };
export type FileSlot<C> = { position: number; key: number; copy: C };

/** One copy per attached File, refcounted by the slots that use it. */
export class SlotFiles<C> {
	#copies = new Map<File, { copy: C; slots: number }>();
	#slots: FileSlot<C>[] = [];
	#create: (file: File) => C;
	#dispose: (copy: C) => void;

	constructor(create: (file: File) => C, dispose: (copy: C) => void) {
		this.#create = create;
		this.#dispose = dispose;
	}

	/** File slots in reference order, by their 1-based position. */
	get files(): readonly FileSlot<C>[] {
		return this.#slots;
	}

	/**
	 * Match the draft: one entry per reference, null for a URL. New Files get a copy in
	 * reference order; a File no slot uses any more is disposed.
	 */
	sync(references: readonly (SlotFile | null)[]) {
		const next = new Map<File, { copy: C; slots: number }>();
		const slots: FileSlot<C>[] = [];
		for (const [index, reference] of references.entries()) {
			if (!reference) continue;
			let entry = next.get(reference.file);
			if (!entry) {
				const kept = this.#copies.get(reference.file);
				entry = { copy: kept?.copy ?? this.#create(reference.file), slots: 0 };
				next.set(reference.file, entry);
			}
			entry.slots++;
			slots.push({ position: index + 1, key: reference.key, copy: entry.copy });
		}
		for (const [file, { copy }] of this.#copies) if (!next.has(file)) this.#dispose(copy);
		this.#copies = next;
		this.#slots = slots;
	}

	clear() {
		this.sync([]);
	}

	/** Positions that share a copy, or a value `same` reports for two copies. */
	duplicates(same?: (copy: C) => string | null | undefined) {
		return duplicatePositions(this.#slots, same);
	}
}

/** Positions in `slots` that share a copy, or a value `same` reports for two copies. */
export function duplicatePositions<C>(
	slots: readonly FileSlot<C>[],
	same?: (copy: C) => string | null | undefined,
) {
	const seen = new Map<unknown, number>();
	const positions = new Set<number>();
	for (const { position, copy } of slots) {
		const keys: unknown[] = [copy];
		const value = same?.(copy);
		if (value) keys.push(`value ${value}`);
		for (const key of keys) {
			const first = seen.get(key);
			if (first === undefined) seen.set(key, position);
			else positions.add(first).add(position);
		}
	}
	return [...positions].sort((a, b) => a - b);
}

/** Run each piece of work after the one asked for before it settles. */
export function oneAtATime() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(work: () => Promise<T>) => {
		const result = tail.then(work);
		tail = result.catch(() => {});
		return result;
	};
}

/** Deletions in flight, so preparing again after a flip finds their scratch space free. */
export class PendingDeletes {
	#pending = new Set<Promise<unknown>>();

	track(deletion: Promise<unknown>) {
		const settled = deletion.catch(() => {});
		this.#pending.add(settled);
		void settled.then(() => this.#pending.delete(settled));
	}

	async settled() {
		while (this.#pending.size) await Promise.all(this.#pending);
	}
}
