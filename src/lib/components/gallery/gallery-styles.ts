import { css } from "#styled-system/css";

export const page = css({ display: "grid", gap: "1.25rem", minWidth: 0, alignContent: "start" });
export const meta = css({ color: "muted", fontSize: "0.9rem", fontVariantNumeric: "tabular-nums" });
export const link = css({ color: "accent", textUnderlineOffset: "0.2em", width: "fit-content" });
export const actions = css({
	display: "flex",
	gap: "0.7rem 1.25rem",
	alignItems: "center",
	flexWrap: "wrap",
});
export const grid = css({
	display: "grid",
	gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
	gap: "1rem",
	listStyle: "none",
	padding: 0,
	margin: 0,
});
export const tile = css({ display: "grid", gap: "0.5rem", alignContent: "start", minWidth: 0 });
export const card = css({
	display: "grid",
	overflow: "hidden",
	border: "1px solid {colors.line}",
	borderRadius: "12px",
	background: "surface",
	color: "ink",
	textDecoration: "none",
	_hover: { borderColor: "accent" },
});
export const preview = css({
	display: "grid",
	placeItems: "center",
	width: "100%",
	aspectRatio: "4 / 3",
	background: "canvas",
	borderBottom: "1px solid {colors.line}",
	color: "muted",
	overflow: "hidden",
	"& img": { width: "100%", height: "100%", objectFit: "cover" },
});
export const caption = css({ display: "grid", gap: "0.15rem", padding: "0.75rem 0.9rem" });
export const viewer = css({
	display: "block",
	objectFit: "contain",
	maxHeight: "70vh",
	maxWidth: "100%",
	width: "auto",
	height: "auto",
	borderRadius: "8px",
	background: "surface",
});
