import { expect, test } from "bun:test";
import type { CheckFetch } from "../../providers/connection-check";
import { uploadFile } from "./transfer";

const file = (size: number) => ({
	draft: crypto.randomUUID(),
	handle: crypto.randomUUID(),
	digest: "a".repeat(64),
	size,
	mime: "image/png" as const,
	transform: "none" as const,
	deadline: 1,
});
const accepted = (size: number) =>
	Response.json({
		success: true,
		code: 200,
		data: {
			file_id: "id",
			file_url: "https://storage.example.org/ref",
			file_size: size,
			mime_type: "image/png",
		},
	});
const multipartFile = (body: Uint8Array) => {
	const text = Buffer.from(body).toString("latin1");
	const start = text.indexOf("\r\n\r\n") + 4;
	return [...body.subarray(start, text.lastIndexOf("\r\n--"))];
};

test("a slow upload reads its own bytes, and a later file never reaches a body still being read", async () => {
	const buffer = new Uint8Array(200_000).fill(1);
	const received: Uint8Array[] = [];
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	// The transport answers after its first chunk and keeps the stream to read later. A
	// success before the provider can have received the whole file is no receipt.
	const early: CheckFetch = async (_url, init) => {
		reader = (init?.body as ReadableStream<Uint8Array> | undefined)?.getReader();
		if (!reader) throw new Error("No body");
		const first = await reader.read();
		if (first.value) received.push(first.value);
		return accepted(200_000);
	};
	expect(await uploadFile("poyo", "key", file(200_000), buffer, early)).toEqual({
		kind: "unknown",
	});
	// The dispatcher now reuses the buffer for a smaller second file.
	buffer.subarray(0, 3).set([7, 7, 7]);
	await expect(reader?.read()).rejects.toThrow();
	expect(received.flatMap((chunk) => [...chunk]).includes(7)).toBeFalse();

	// A slow, complete transfer receives exactly the reviewed bytes.
	const second = buffer.subarray(0, 3);
	let body: Uint8Array = new Uint8Array();
	const slow: CheckFetch = async (_url, init) => {
		const chunks: Uint8Array[] = [];
		for await (const chunk of (init?.body ?? new ReadableStream()) as ReadableStream<Uint8Array>) {
			await Bun.sleep(1);
			chunks.push(chunk);
		}
		body = Buffer.concat(chunks);
		return accepted(3);
	};
	expect(await uploadFile("poyo", "key", file(3), second, slow)).toMatchObject({ kind: "ready" });
	expect(multipartFile(body)).toEqual([7, 7, 7]);
});

test("a transport that fails before reading leaves no chunk to read later", async () => {
	const buffer = new Uint8Array([1, 2, 3]);
	let stream: ReadableStream<Uint8Array> | undefined;
	const failing: CheckFetch = async (_url, init) => {
		stream = init?.body as ReadableStream<Uint8Array>;
		throw new Error("reset");
	};
	expect(await uploadFile("toapis", "key", file(3), buffer, failing)).toEqual({ kind: "unknown" });
	const reader = stream?.getReader();
	const chunks: number[] = [];
	try {
		for (;;) {
			const { done, value } = (await reader?.read()) ?? { done: true };
			if (done) break;
			chunks.push(...(value ?? []));
		}
	} catch {
		// A stopped body errors.
	}
	expect(chunks).not.toContain(2);
});

test("an early refusal keeps its meaning, and a success after the whole body is a receipt", async () => {
	const buffer = new Uint8Array(200_000).fill(1);
	const refusing: CheckFetch = async (_url, init) => {
		await (init.body as ReadableStream<Uint8Array>).getReader().read();
		return Response.json(
			{ success: false, code: 401, error: { message: "bad key" } },
			{ status: 401 },
		);
	};
	expect(await uploadFile("poyo", "key", file(200_000), buffer, refusing)).toMatchObject({
		kind: "rejected",
	});
	const complete: CheckFetch = async (_url, init) => {
		await new Response(init.body as ReadableStream<Uint8Array>).arrayBuffer();
		return accepted(200_000);
	};
	expect(await uploadFile("poyo", "key", file(200_000), buffer, complete)).toEqual({
		kind: "ready",
		url: "https://storage.example.org/ref",
	});
});

test("a success that arrived before the whole body is no receipt, even if the body ends while its JSON is read", async () => {
	const late: CheckFetch = async (_url, init) => {
		const reader = (init?.body as ReadableStream<Uint8Array> | undefined)?.getReader();
		if (!reader) throw new Error("No body");
		await reader.read();
		const answer = accepted(3);
		// The rest of the body is drained only while the response body is parsed.
		return Object.assign(answer, {
			json: async () => {
				while (!(await reader.read()).done);
				return Response.prototype.json.call(answer);
			},
		});
	};
	expect(await uploadFile("poyo", "key", file(3), new Uint8Array([1, 2, 3]), late)).toEqual({
		kind: "unknown",
	});
});
