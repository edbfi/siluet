import { css, cx } from "#styled-system/css";
import { studioPanel } from "#styled-system/recipes";

export const panel = cx(
	studioPanel(),
	css({
		display: "grid",
		gap: "0.85rem",
		minWidth: 0,
		padding: "clamp(1rem, 2.25vw, 1.5rem)",
	}),
);

export const heading = css({
	font: "680 1.18rem / 1.2 system-ui, sans-serif",
	letterSpacing: "-0.02em",
	scrollMarginBlockStart: "0.85rem",
});

export const tabList = css({
	display: "flex",
	borderBlockEnd: "1px solid {colors.line}",
});

export const tab = css({
	minHeight: "44px",
	padding: "0.45rem 0.65rem",
	border: 0,
	borderRadius: 0,
	borderBlockEnd: "2px solid transparent",
	background: "transparent",
	color: "muted",
	fontSize: "0.87rem",
	lineHeight: 1.25,
	_hover: { color: "accent" },
	_selected: { color: "accent", borderBlockEndColor: "currentColor" },
	_focusVisible: { outlineOffset: "-4px" },
});

export const tabContent = css({
	minWidth: 0,
	marginBlockStart: "0.85rem",
	fontSize: "0.875rem",
});

export const facts = css({ display: "grid", gap: "0.45rem", margin: 0 });

export const fact = css({
	display: "grid",
	gridTemplateColumns: "minmax(4.5rem, 6rem) minmax(0, 1fr)",
	gap: "0.5rem",
});

export const term = css({ color: "muted" });
export const detail = css({ margin: 0, overflowWrap: "anywhere" });
export const mediaList = css({
	margin: 0,
	paddingInlineStart: "1.15rem",
	"& > li + li": { marginBlockStart: "0.25rem" },
});
export const note = css({ color: "muted", fontSize: "0.85rem" });

export const batch = css({
	display: "flex",
	flexWrap: "wrap",
	gap: "0.75rem",
	marginBlockEnd: "0.6rem",
});

export const batchLabel = css({ display: "grid", gap: "0.3rem" });
export const batchSelect = css({ minHeight: "44px" });

export const wire = css({
	padding: "0.65rem 0.75rem",
	borderRadius: "8px",
	background: "canvas",
	overflowWrap: "anywhere",
});

export const jsonScroller = css({ maxBlockSize: "14rem", margin: "0.45rem 0 0", overflow: "auto" });
export const json = css({ margin: 0, whiteSpace: "pre-wrap" });

export const actions = css({
	display: "flex",
	flexWrap: "wrap",
	alignItems: "center",
	gap: "0.4rem 0.85rem",
});

export const queue = css({
	minHeight: "44px",
	_disabled: {
		borderColor: "line",
		background: "canvas",
		color: "muted",
		cursor: "not-allowed",
	},
});

export const exposure = css({ fontSize: "0.85rem", fontWeight: 650 });

export const consent = css({
	display: "flex",
	alignItems: "center",
	gap: "0.6rem",
	minHeight: "44px",
	fontSize: "0.9rem",
	cursor: "pointer",
	"& input": { accentColor: "accent", flexShrink: 0 },
});
