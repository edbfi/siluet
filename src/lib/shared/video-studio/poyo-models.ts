import { h3Max } from "./h3-max";

/** Reviewed Poyo video descriptors. Registry rows and the estimator read this list. */
export const poyoVideoModels = [h3Max] as const;

export function poyoVideoDescriptor(rateKey: string) {
	return poyoVideoModels.find((descriptor) => descriptor.rateKey === rateKey);
}
