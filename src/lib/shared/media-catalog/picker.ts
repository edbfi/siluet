import projection from "./poyo-picker.json";

/** A derived Poyo.ai row the picker lists as Review-only, with the one reason it cannot queue. */
export type ReviewOnlyRow = {
	model: string;
	media: "image" | "video";
	operations: string[];
	reason: string;
};

const rows = projection.rows as ReviewOnlyRow[];

/** The contract family a derived row belongs to, as the picker groups it. */
export const reviewOnlyFamily = (media: ReviewOnlyRow["media"]) => `Poyo.ai ${media}`;

export const reviewOnlyImageRows = rows.filter((row) => row.media === "image");
export const reviewOnlyVideoRows = rows.filter((row) => row.media === "video");
