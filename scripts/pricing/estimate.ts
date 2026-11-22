import { parseArgs } from "node:util";
import {
	estimatePrice,
	isPriceSourceKind,
	type PriceInput,
} from "../../src/lib/shared/pricing/estimate";
import { isPricingProvider } from "../../src/lib/shared/pricing/feeds";
import { poyoVideoDescriptor } from "../../src/lib/shared/video-studio/poyo-models";
import { loadLocalPricing } from "./local-feed";

const usage = `Estimate published media rates offline.
bun run pricing:estimate --model <id> [--provider poyo|toapis] [--operation generate|edit|animate|interpolate]
  [--size 1:1|2K] [--resolution 2K|480p|768p] [--duration 5] [--references 2]
  [--source-kind image|video|audio|unknown ...] [--batch 5] [--retries 3]

Use --size 1K, 1.5K or 2K for ToAPIs Seedream 5.5 (doubao-seedream-5-5).
For Seedance 2.5 with inputs, repeat --source-kind for each reference.
A Poyo.ai video model such as h3-max starts from its reviewed Video Studio defaults.
The result gives the initial estimate and maximum number of submissions. It never submits a job.`;

function integerOption(value: string, flag: string) {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error(`--${flag} requires a whole number.`);
	}
	return Number(value);
}

export function readEstimateArgs(args: string[]): PriceInput {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			model: { type: "string" },
			provider: { type: "string", default: "poyo" },
			operation: { type: "string", default: "generate" },
			size: { type: "string" },
			resolution: { type: "string" },
			duration: { type: "string" },
			references: { type: "string" },
			"source-kind": { type: "string", multiple: true },
			batch: { type: "string", default: "1" },
			retries: { type: "string", default: "0" },
		},
	});
	if (!values.model) throw new Error("Choose a model with --model.");
	const sourceKinds = values["source-kind"]?.map((kind) => {
		if (!isPriceSourceKind(kind))
			throw new Error("--source-kind requires image, video, audio or unknown.");
		return kind;
	});
	const sourceCount =
		values.references === undefined
			? (sourceKinds?.length ?? 0)
			: integerOption(values.references, "references");
	if (sourceKinds && sourceKinds.length !== sourceCount) {
		throw new Error("--references must match the number of --source-kind arguments.");
	}
	const video = values.provider === "poyo" ? poyoVideoDescriptor(values.model) : undefined;
	const options: Record<string, string | number | boolean> = video
		? { ...video.defaults, [video.d4Field]: false }
		: {};
	if (values.duration !== undefined) options.duration = integerOption(values.duration, "duration");
	if (values.size !== undefined) options.size = values.size;
	if (values.resolution !== undefined) options.resolution = values.resolution;
	return {
		provider: values.provider,
		model: values.model,
		operation: values.operation,
		options,
		sourceCount,
		...(sourceKinds && { sourceKinds }),
		count: integerOption(values.batch, "batch"),
		retryLimit: integerOption(values.retries, "retries"),
	};
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log(usage);
	} else {
		try {
			const input = readEstimateArgs(args);
			const now = Date.now();
			const feed = isPricingProvider(input.provider)
				? await loadLocalPricing(now, { provider: input.provider })
				: undefined;
			console.log(JSON.stringify(estimatePrice(feed, input, now), null, 2));
		} catch (error) {
			console.error(error instanceof Error ? error.message : "Unable to read the estimate.");
			console.error(usage);
			process.exitCode = 1;
		}
	}
}
