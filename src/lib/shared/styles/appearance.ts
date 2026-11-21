export function applyAppearance(appearance: string | null) {
	const { dataset } = document.documentElement;
	if (appearance === "light" || appearance === "dark") {
		dataset.appearance = appearance;
	} else {
		delete dataset.appearance;
	}
}
