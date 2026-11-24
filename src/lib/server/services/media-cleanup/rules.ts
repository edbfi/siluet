/**
 * The version of the rules a staged copy was prepared under, signed into file Review
 * terms. A change stales unconsumed Reviews. `cleaned-sdr-v2` re-encodes rotated JPEGs
 * (D7) and drops unknown ancillary PNG chunks; `original-v1` checks and sends the
 * attached bytes unchanged (D10).
 */
export const cleanupRules = { cleaned: "cleaned-sdr-v2", original: "original-v1" } as const;
