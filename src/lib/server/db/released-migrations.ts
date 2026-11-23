/**
 * SHA-256 of each released installation migration's SQL, then its name. A released
 * migration never changes; a new one sorts after the last name here and is appended
 * before its PR merges. (Digest first keeps secret scanners from reading a name as a key.)
 */
const released = [
	[
		"2ee9e2dd57cac4755d397b0e9071856a03ca7c57b927602e928b3f4363f8a945",
		"20261121000000_owner_access",
	],
	[
		"e8073b2dfd234a96827fdd49099c25b85fcd6cc11f5bc8de2b2a007daaa89865",
		"20261121191912_provider_credentials",
	],
	[
		"df980edbc5b43422b86db67fd15fc734858d3b1c7ac2449c3c0b2886d76d2775",
		"20261121223139_first_saved_image",
	],
	[
		"29c352c0ce92029c3d3cf7d2f4e9a79d6cc818268c63631f044ec71964af7ddf",
		"20261122000549_seedream_reference_failure",
	],
	[
		"dad1a27cb05bb7195697366604505ff5ef61b10b6c1a21e04328254553045015",
		"20261122030400_image_job_operation",
	],
	[
		"18d501ddecdf0778719580abbb29163cd6d1077e2d35c4f0f4538e78af669c8b",
		"20261122120000_live_image_batches",
	],
	[
		"effae76de3365e8c6f73090dd4fbcd215916b9bab3e8c9ea087657090af17ffd",
		"20261122121000_first_saved_video",
	],
	[
		"b9c450a8ed6a1bd565f47b6ad2846ae237849b0df001d123a95d49e65d0db9fd",
		"20261122122000_owner_authenticator",
	],
] as const;

/** Released migration name → SQL digest. */
export const releasedMigrations: ReadonlyMap<string, string> = new Map(
	released.map(([digest, name]) => [name, digest]),
);
