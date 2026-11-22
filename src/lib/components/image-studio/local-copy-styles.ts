import { css, cx } from "#styled-system/css";
import { studioButton } from "#styled-system/recipes";

export const section = css({
	display: "grid",
	gap: "0.5rem",
	marginBlockStart: "0.85rem",
	paddingBlockStart: "0.85rem",
	borderBlockStart: "1px solid {colors.line}",
	minWidth: 0,
});

export const heading = css({ margin: 0, fontWeight: 650, fontSize: "0.95rem" });
export const subheading = css({ margin: 0, fontWeight: 650, fontSize: "0.875rem" });
export const note = css({ margin: 0, color: "muted", fontSize: "0.85rem" });

export const prepare = cx(
	studioButton({ appearance: "secondary" }),
	css({
		justifySelf: "start",
		minHeight: "44px",
		_disabled: { color: "muted", cursor: "progress" },
	}),
);

export const figure = css({ display: "grid", gap: "0.35rem", margin: 0 });

export const preview = css({
	display: "block",
	maxInlineSize: "100%",
	maxBlockSize: "16rem",
	inlineSize: "auto",
	blockSize: "auto",
	objectFit: "contain",
	borderRadius: "8px",
	border: "1px solid {colors.line}",
	background: "canvas",
});

export const disclosure = css({
	margin: 0,
	padding: "0.55rem 0.7rem",
	// The surface color disappears in forced colors. The border keeps the callout visible.
	border: "1px solid transparent",
	borderRadius: "8px",
	"@media (forced-colors: active)": { borderColor: "CanvasText" },
	background: "staleSurface",
	color: "stale",
	fontSize: "0.85rem",
});

export const list = css({
	margin: 0,
	paddingInlineStart: "1.15rem",
	listStyleType: "disc",
	fontSize: "0.85rem",
	"& > li + li": { marginBlockStart: "0.3rem" },
});
