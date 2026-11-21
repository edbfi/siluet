import { css, cx } from "#styled-system/css";
import { studioPanel } from "#styled-system/recipes";

export const styles = {
	page: css({ maxWidth: "64rem" }),
	intro: css({ marginTop: "0.45rem", color: "muted" }),
	list: cx(
		studioPanel(),
		css({ marginBlockStart: "1.5rem", paddingInline: "clamp(1rem, 3vw, 1.5rem)" }),
	),
	job: css({
		display: "grid",
		gap: "0.75rem",
		paddingBlock: "1.25rem",
		minWidth: 0,
		scrollMarginBlockStart: "1rem",
		"& + article": { borderBlockStart: "1px solid {colors.line}" },
	}),
	header: css({
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: "0.4rem 1rem",
	}),
	heading: css({ font: "650 1.125rem / 1.35 system-ui, sans-serif", letterSpacing: "-0.02em" }),
	state: css({
		fontSize: "0.875rem",
		fontWeight: 650,
		color: "accent",
		"&[data-state=completed]": { color: "success" },
		"&:is([data-state=unknown], [data-state=failed], [data-state=rejected])": { color: "warning" },
	}),
	meta: css({
		color: "muted",
		fontSize: "0.875rem",
		fontVariantNumeric: "tabular-nums",
		overflowWrap: "anywhere",
	}),
	note: css({ maxWidth: "72ch", fontSize: "0.875rem" }),
	billing: css({
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))",
		gap: "0.7rem 1.25rem",
		margin: 0,
		paddingBlock: "0.75rem",
		borderBlock: "1px solid {colors.line}",
		fontSize: "0.875rem",
		fontVariantNumeric: "tabular-nums",
		"& dt": { color: "muted" },
		"& dd": { margin: 0, overflowWrap: "anywhere" },
	}),
	actions: css({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }),
	button: css({
		minHeight: "44px",
		fontSize: "0.875rem",
		_disabled: { color: "muted", background: "canvas", cursor: "not-allowed" },
	}),
	link: css({
		display: "inline-flex",
		alignItems: "center",
		width: "fit-content",
		minHeight: "44px",
		color: "accent",
		fontWeight: 650,
		textUnderlineOffset: "0.18em",
	}),
};
