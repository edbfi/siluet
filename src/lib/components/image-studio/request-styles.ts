import { css } from "#styled-system/css";

export const requestFieldset = css({ minWidth: 0, margin: 0, padding: 0, border: 0 });
export const requestLegend = css({
	padding: 0,
	marginBottom: "0.35rem",
	fontSize: "0.85rem",
	fontWeight: 650,
});

export const requestFields = css({
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(min(8rem, 100%), 1fr))",
	gap: "0.75rem",
});
export const requestField = css({ display: "grid", minWidth: 0, gap: "0.35rem" });
export const requestLabel = css({ fontSize: "0.85rem", fontWeight: 650 });
export const requestControl = css({
	width: "100%",
	minWidth: 0,
	minHeight: "44px",
	fontWeight: 400,
});

const helpText = { fontSize: "0.8rem", fontWeight: 400 };
export const requestHelp = css(helpText, { color: "muted" });
export const requestError = css(helpText, { color: "danger" });

export const fieldHeading = css({
	display: "flex",
	flexWrap: "wrap",
	alignItems: "baseline",
	justifyContent: "space-between",
	gap: "0 0.5rem",
});

export const requestLink = {
	color: "accent",
	fontSize: "0.85rem",
	fontWeight: 650,
	textDecoration: "underline",
	textUnderlineOffset: "0.16em",
} as const;

export const referenceAction = css({
	minHeight: "44px",
	width: "fit-content",
	font: "inherit",
	fontWeight: 650,
	color: "accent",
	cursor: "pointer",
	border: 0,
	background: "transparent",
	paddingInline: 0,
	textDecoration: "underline",
	textUnderlineOffset: "0.16em",
	_disabled: { color: "muted", cursor: "default", textDecoration: "none" },
});
