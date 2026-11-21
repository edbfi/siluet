import { defineConfig, defineRecipe } from "@pandacss/dev";

// Explicit token conditions keep the palette and native controls on the same appearance in production.
function appearanceColor(light: string, dark: string) {
	return { value: { base: light, _osDark: dark, _studioLight: light, _studioDark: dark } };
}

export default defineConfig({
	presets: ["@pandacss/preset-base"],
	preflight: false,
	include: ["./src/**/*.{ts,svelte}"],
	importMap: "#styled-system",
	outdir: "styled-system",
	conditions: {
		extend: {
			studioLight: '&[data-appearance="light"]',
			studioDark: '&[data-appearance="dark"]',
		},
	},
	theme: {
		extend: {
			semanticTokens: {
				colors: {
					canvas: appearanceColor("#f2f5fa", "#151e2e"),
					surface: appearanceColor("#fff", "#1d293b"),
					ink: appearanceColor("#182537", "#eff3fc"),
					muted: appearanceColor("#55647a", "#b5c1d6"),
					border: appearanceColor("#8591a2", "#7b8ba3"),
					line: appearanceColor("#d9e1ec", "#3c4b61"),
					accent: appearanceColor("#234bc3", "#a9bdff"),
					accentSurface: appearanceColor("#e8eeff", "#293d63"),
					danger: appearanceColor("#992c28", "#ffb7ae"),
					warning: appearanceColor("#953528", "#ffb7ae"),
					success: appearanceColor("#205c45", "#97dfc1"),
					successSurface: appearanceColor("#e4f4ec", "#1d3e33"),
					stale: appearanceColor("#754716", "#f2cc8a"),
					staleSurface: appearanceColor("#fff2d9", "#493a25"),
					rail: appearanceColor("#111d33", "#101827"),
					railInk: { value: "#f1f5ff" },
					railMuted: { value: "#b5c1d6" },
					railHover: { value: "#1e2d48" },
					railCurrent: { value: "#26385e" },
					railCurrentBorder: { value: "#374c76" },
					railCurrentInk: { value: "#fff" },
					railFocus: { value: "#f4c461" },
				},
			},
			recipes: {
				studioPanel: defineRecipe({
					className: "studio-panel",
					base: {
						background: "surface",
						border: "1px solid {colors.line}",
						borderRadius: "15px",
					},
				}),
				studioButton: defineRecipe({
					className: "studio-button",
					variants: {
						appearance: {
							secondary: {
								color: "ink",
								background: "surface",
								borderColor: "border",
							},
						},
					},
				}),
			},
		},
	},
	globalCss: {
		":root": {
			colorScheme: "light dark",
			color: "ink",
			background: "canvas",
			font: "400 100% / 1.5 system-ui, sans-serif",
		},
		':root[data-appearance="light"]': { colorScheme: "light" },
		':root[data-appearance="dark"]': { colorScheme: "dark" },
		"*": { boxSizing: "border-box" },
		body: { margin: "0" },
		"h1, h2, p": { margin: "0" },
		"h1, h2": {
			font: "normal 2.7rem / 1.08 Georgia, serif",
			letterSpacing: "-0.035em",
			textWrap: "balance",
		},
		h1: {
			"@media (max-width: 700px)": { fontSize: "2.2rem" },
		},
		h2: { fontSize: "1.65rem" },
		"button, select, input": {
			font: "inherit",
			border: "1px solid {colors.border}",
			borderRadius: "7px",
			padding: "0.62rem 0.8rem",
		},
		"button, select": { cursor: "pointer" },
		"input, select": { background: "surface", color: "ink" },
		button: {
			background: "#234bc3",
			color: "white",
			fontWeight: "650",
			borderColor: "transparent",
		},
		":focus-visible": {
			outline: "3px solid {colors.accent}",
			outlineOffset: "3px",
		},
	},
});
