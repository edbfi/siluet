import { css } from "#styled-system/css";

export const skipLink = css({
	position: "absolute",
	top: "0",
	left: "1rem",
	transform: "translateY(-130%)",
	background: "surface",
	color: "ink",
	padding: "0.6rem 1rem",
	zIndex: 5,
	"&:focus": { transform: "none" },
});
