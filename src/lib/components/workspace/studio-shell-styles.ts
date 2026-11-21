import { css, sva } from "#styled-system/css";

const railHover = {
	background: "railHover",
	color: "railInk",
};
const railFocus = { outlineColor: "railFocus" };

export const shell = {
	root: css({
		"--gutter": "clamp(1.25rem, 3vw, 2.625rem)",
		minHeight: "100dvh",
		display: "grid",
		gridTemplateColumns: "15rem minmax(0, 1fr)",
		"@media (max-width: 760px)": { display: "block" },
	}),
	rail: css({
		background: "rail",
		color: "railInk",
		padding: "1.625rem 1.0625rem",
		overflow: "auto",
	}),
	sidebar: css({
		position: "sticky",
		insetBlockStart: 0,
		height: "100dvh",
		"@media (max-width: 760px)": { display: "none" },
	}),
	identity: css({
		display: "inline-flex",
		alignItems: "center",
		gap: "0.625rem",
		margin: 0,
		color: "railInk",
		font: "650 1.43rem / 1.2 system-ui, sans-serif",
		letterSpacing: "-0.035em",
	}),
	navigation: css({
		display: "grid",
		gap: "0.25rem",
		marginBlockStart: "2.4375rem",
		"@media (max-width: 760px)": { marginBlockStart: "1.625rem" },
	}),
	navLink: css({
		display: "flex",
		alignItems: "center",
		gap: "0.6875rem",
		minHeight: "2.75rem",
		padding: "0.5rem 0.75rem",
		border: "1px solid transparent",
		borderRadius: "8px",
		color: "railMuted",
		fontSize: "0.875rem",
		fontWeight: 600,
		textDecoration: "none",
		"&:not([aria-current=page]):hover": railHover,
		_currentPage: {
			borderColor: "railCurrentBorder",
			background: "railCurrent",
			color: "railCurrentInk",
		},
		_focusVisible: railFocus,
	}),
	icon: css({
		width: "1.25rem",
		height: "1.25rem",
		flex: "none",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.65,
		strokeLinecap: "round",
		strokeLinejoin: "round",
	}),
	topbar: css({
		borderBlockEnd: "1px solid {colors.line}",
		background: "surface",
	}),
	frame: css({
		width: "min(100%, 96rem)",
		marginInline: "auto",
		paddingInline: "var(--gutter)",
	}),
	location: css({
		display: "flex",
		minHeight: "3.875rem",
		alignItems: "center",
		gap: "0.625rem",
		fontSize: "0.875rem",
		"@media (max-width: 760px)": { minHeight: "3.625rem" },
	}),
	locationParent: css({
		color: "muted",
		"@media (max-width: 760px)": { display: "none" },
	}),
	locationCurrent: css({ fontWeight: 650 }),
	content: css({
		paddingBlock: "2rem",
		"@media (max-width: 760px)": { paddingBlock: "1.5rem" },
	}),
	mobileMenu: css({
		display: "none",
		"@media (max-width: 760px)": {
			display: "flex",
			alignItems: "center",
			gap: "0.5rem",
			marginInlineStart: "-0.5rem",
		},
	}),
	drawerHeader: css({
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
	}),
	screenReaderText: css({ srOnly: true }),
};

const iconButton = {
	display: "grid",
	width: "2.75rem",
	height: "2.75rem",
	placeItems: "center",
	padding: 0,
	background: "transparent",
	color: "inherit",
};

const overlay = {
	position: "fixed",
	inset: 0,
	zIndex: 10,
};

const drawerStyles = sva({
	slots: ["trigger", "backdrop", "positioner", "content", "title", "closeTrigger"],
	base: {
		trigger: {
			...iconButton,
			_hover: { background: "canvas" },
		},
		backdrop: {
			...overlay,
			background: "rgb(10 20 40 / 54%)",
		},
		positioner: overlay,
		content: {
			width: "min(20rem, 90vw)",
			height: "100%",
		},
		title: { margin: 0 },
		closeTrigger: {
			...iconButton,
			_hover: railHover,
			_focusVisible: railFocus,
		},
	},
});

export const drawer = drawerStyles();
