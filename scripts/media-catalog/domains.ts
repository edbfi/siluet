// The documented and offered domains of one derived option on one operation: the reviewed
// value overrides, then the values a Siluet envelope withholds. Coverage, the queue rows and the
// verified options share it. It reads no derived rows and imports no deriver at runtime.
import {
	galleryEnvelope,
	type ReviewedOverride,
	reviewedOverrides,
} from "../../src/lib/shared/media-catalog/rules";
import type { DerivedOption, DerivedRow, Domain } from "./derive";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The documented domain of one option on one operation, after the reviewed value overrides. */
export function narrowedDomain(
	row: Pick<DerivedRow, "model" | "catalog">,
	option: DerivedOption,
	operation: string,
	overrides: readonly ReviewedOverride[] = reviewedOverrides,
): Domain {
	const excludes = overrides
		.filter(
			(override) =>
				override.model === row.model &&
				override.operation === operation &&
				override.field === option.field &&
				override.schemaSha256 === row.catalog,
		)
		.flatMap(({ excludes }) => excludes);
	if (!excludes.length || !option.domain.values) return option.domain;
	return {
		...option.domain,
		values: option.domain.values.filter((value) => !excludes.includes(value)),
	};
}

/** Values of one option that a Siluet envelope withholds until a later slice raises it. */
export function envelopeValues(
	row: Pick<DerivedRow, "media">,
	option: DerivedOption,
	domain: Domain,
) {
	if (
		row.media !== "image" ||
		!(galleryEnvelope.fields as readonly string[]).includes(option.field)
	)
		return [];
	return (domain.values ?? []).filter((value) =>
		(galleryEnvelope.values as readonly Json[]).includes(value),
	);
}

/** What the composer may offer on one operation: the narrowed domain, less envelope values. */
export function offeredDomain(
	row: Pick<DerivedRow, "model" | "catalog" | "media">,
	option: DerivedOption,
	operation: string,
): Domain {
	const domain = narrowedDomain(row, option, operation);
	const withheld = envelopeValues(row, option, domain);
	if (!withheld.length) return domain;
	return { ...domain, values: domain.values?.filter((value) => !withheld.includes(value)) };
}
