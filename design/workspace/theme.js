(() => {
	const key = "siluet.workspace.appearance";
	const system = window.matchMedia("(prefers-color-scheme: dark)");
	let preference = "system";
	let storage;

	function normalize(value) {
		return value === "light" || value === "dark" ? value : "system";
	}

	try {
		storage = window.localStorage;
		preference = normalize(storage.getItem(key));
	} catch {
		// A sandboxed preview can use the theme for the current session.
	}

	function apply() {
		const systemTheme = system.matches ? "dark" : "light";
		document.documentElement.dataset.theme = preference === "system" ? systemTheme : preference;
	}

	window.StudioTheme = {
		get: () => preference,
		set(value) {
			preference = normalize(value);
			try {
				storage?.setItem(key, preference);
			} catch {
				// The selected appearance still applies if storage is unavailable.
			}
			apply();
			window.dispatchEvent(new Event("siluet-theme-change"));
		},
	};
	apply();
	system.addEventListener("change", apply);
	window.addEventListener("storage", (event) => {
		if (event.storageArea !== storage || (event.key !== key && event.key !== null)) return;
		preference = normalize(event.newValue);
		apply();
		window.dispatchEvent(new Event("siluet-theme-change"));
	});
})();
