import { type SeedreamProvider, seedreamProviderNames } from "./seedream";

const recipients = {
	poyo: "Poyo.ai and its upstream model services may process these inputs and fetch the referenced images.",
	toapis:
		"ToAPIs and its upstream model services may process these inputs and fetch the referenced images, including through a fallback for eligible accounts and regions.",
};

const retention = {
	poyo: "Poyo.ai displays input parameters in task history and retains generation history for three months. The retention period for fetched reference images is unknown.",
	toapis:
		"ToAPIs keeps API call logs for 90 days by default. Retention of submitted URLs and fetched reference images is unspecified.",
};

export function editDisclosure(provider: SeedreamProvider): readonly string[] {
	return [
		`Queue sends ${seedreamProviderNames[provider]} your prompt and every full reference URL, including its path, query with any signature, and fragment. ${recipients[provider]}`,
		"Keep each image reachable through processing without cookies or extra headers. A signed link may grant access until expiry. A recipient can keep a copy it has already fetched, even after the link expires.",
		retention[provider],
	];
}
