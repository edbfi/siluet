(() => {
	const studio = window.Studio;
	const views = window.StudioViews;
	const catalog = window.SiluetModels;
	const routeNames = {
		dashboard: "Dashboard",
		image: "Image Studio",
		video: "Video Studio",
		gallery: "Gallery",
		jobs: "Jobs",
		settings: "Settings",
	};
	const statusNames = {
		queued: "Queued",
		running: "Running",
		completed: "Completed",
		cancelled: "Cancelled",
		failed: "Failed",
		uncertain: "Submission uncertain",
		"download-failed": "Download failed",
	};
	const readFormat = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
	const amountFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 21 });
	const usdFormat = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
	const walletSearchThreshold = 6;

	const main = document.getElementById("workspace-main");
	const sidebar = document.querySelector(".shell-sidebar");
	const content = document.querySelector(".shell-content");
	const locationLabel = document.querySelector(".shell-location-current");
	const navLinks = document.querySelectorAll("[data-shell-route]");
	const walletTriggers = document.querySelectorAll("[data-wallet-trigger]");
	const walletSummaries = document.querySelectorAll("[data-wallet-summary]");
	const walletDialog = document.getElementById("wallet-dialog");
	const walletClose = walletDialog.querySelector(".wallet-dialog-close");
	const walletSearch = walletDialog.querySelector(".wallet-search input");
	const walletResults = walletDialog.querySelector(".wallet-results");
	const walletList = walletDialog.querySelector(".wallet-providers");
	const walletNoMatch = walletDialog.querySelector(".wallet-no-match");
	const walletEmpty = walletDialog.querySelector(".wallet-empty");
	const opener = document.querySelector(".shell-open");
	const closer = document.querySelector(".shell-close");
	const scrim = document.querySelector(".shell-scrim");
	const skip = document.querySelector(".shell-skip");
	const mobile = window.matchMedia("(max-width: 760px)");
	const dashboard = document.getElementById("shell-dashboard");
	let route;
	let cleanup;
	let dashboardData;
	let walletOpener;

	function makeElement(tag, className, text) {
		const element = document.createElement(tag);
		if (className) element.className = className;
		if (text !== undefined) element.textContent = text;
		return element;
	}

	function icon(name) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", "shell-icon");
		svg.setAttribute("aria-hidden", "true");
		const use = document.createElementNS(svg.namespaceURI, "use");
		use.setAttribute("href", `#shell-icon-${name}`);
		svg.append(use);
		return svg;
	}

	function formatBalance(value, unit) {
		if (unit === "USD" || unit === "$") return usdFormat.format(value);
		return [amountFormat.format(value), unit].filter(Boolean).join(" ");
	}

	function walletRow({ id, name, amount, asOf }) {
		const row = makeElement("li", "wallet-provider");
		row.dataset.walletProvider = id;
		const identity = makeElement("div", "wallet-provider-identity");
		const label = makeElement("span", "wallet-provider-name", name);
		const read = makeElement("span", "wallet-provider-time", "No balance read yet");
		const lastRead = asOf == null ? null : new Date(asOf);
		if (lastRead && Number.isFinite(lastRead.getTime())) {
			const time = makeElement("time", "", readFormat.format(lastRead));
			time.dateTime = lastRead.toISOString();
			read.replaceChildren("Last read ", time);
		}
		identity.append(label, read);

		const balance = makeElement("span", "wallet-provider-balance", amount ?? "Unavailable");
		balance.dataset.walletBalance = "";
		row.dataset.available = String(amount !== null);
		row.append(identity, balance);
		return row;
	}

	function filterWallets() {
		const query = walletSearch.value.trim().toLocaleLowerCase();
		let visible = 0;
		for (const row of walletList.children) {
			const name = row.querySelector(".wallet-provider-name").textContent;
			row.hidden = !name.toLocaleLowerCase().includes(query);
			if (!row.hidden) visible++;
		}
		walletNoMatch.textContent = visible === 0 && query ? "No providers match your search." : "";
		walletResults.scrollTop = 0;
	}

	function updateWallets() {
		const { keys } = studio.settings();
		const balances = [];
		for (const [id, name] of Object.entries(catalog.providers)) {
			if (!Object.hasOwn(keys, id) || !keys[id]) continue;
			const { value, unit, asOf } = studio.balance(id);
			const amount = Number.isFinite(value) ? formatBalance(value, unit) : null;
			balances.push({ id, name, amount, asOf });
		}
		const firstBalance = balances.find(({ amount }) => amount !== null);
		const preview = firstBalance
			? `${firstBalance.name} ${firstBalance.amount}`
			: "No saved balance";
		for (const summary of walletSummaries) {
			if (summary.textContent !== preview) summary.textContent = preview;
		}

		const showSearch = balances.length >= walletSearchThreshold;
		if (!showSearch) walletSearch.value = "";
		walletSearch.closest("label").hidden = !showSearch;
		walletEmpty.hidden = balances.length > 0;
		walletResults.hidden = balances.length === 0;
		walletList.replaceChildren(...balances.map(walletRow));
		filterWallets();
	}

	function recent(records, count) {
		return [...records]
			.sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
			.slice(0, count);
	}

	function assetCard(asset) {
		const link = makeElement("a", "dash-asset");
		link.href = "#gallery";
		link.dataset.assetId = asset.id;

		const media = makeElement("div", "dash-asset-media");
		const isVideo = asset.kind === "video";
		if (isVideo) {
			const video = makeElement("video");
			video.src = asset.src;
			video.muted = true;
			video.playsInline = true;
			video.preload = "metadata";
			video.setAttribute("aria-hidden", "true");
			const marker = makeElement("span", "dash-asset-marker");
			marker.append(icon("video"));
			media.append(video, marker);
		} else {
			const image = makeElement("img");
			image.src = asset.src;
			image.alt = "";
			image.decoding = "async";
			media.append(image);
		}

		const caption = makeElement("div", "dash-asset-caption");
		caption.append(
			makeElement("span", "dash-asset-name", asset.title),
			makeElement("span", "dash-asset-type", isVideo ? "Video" : "Image"),
		);
		link.append(media, caption);
		return link;
	}

	function jobRow(job) {
		const item = makeElement("li", "dash-job");
		const jobIcon = makeElement("span", "dash-job-icon");
		jobIcon.append(icon(job.kind === "video" ? "video" : "image"));
		const info = makeElement("div", "dash-job-info");
		info.append(
			makeElement("span", "dash-job-name", job.title),
			makeElement("span", "dash-job-provider", catalog.providers[job.provider] ?? job.provider),
		);
		const status = makeElement(
			"span",
			"dash-job-status",
			statusNames[job.status] ?? "Status unavailable",
		);
		status.dataset.status = job.status;
		item.append(jobIcon, info, status);
		return item;
	}

	function updateDashboard() {
		const assets = recent(studio.assets(), 3);
		const assetKey = JSON.stringify(assets);
		if (dashboardData.assetKey !== assetKey) {
			const currentAsset = dashboardData.work.contains(document.activeElement)
				? document.activeElement.dataset.assetId
				: null;
			const cards = assets.map(assetCard);
			if (cards.length) {
				dashboardData.work.replaceChildren(...cards);
			} else {
				dashboardData.work.replaceChildren(
					makeElement("p", "dash-empty", "Your results will appear here after you make a study."),
				);
			}
			if (currentAsset) {
				const replacement = cards.find((card) => card.dataset.assetId === currentAsset);
				(replacement ?? main.querySelector('.dash-link[href="#gallery"]')).focus({
					preventScroll: true,
				});
			}
			dashboardData.assetKey = assetKey;
		}

		const jobs = recent(studio.jobs(), 4);
		const jobKey = JSON.stringify(
			jobs.map(({ id, title, kind, provider, status }) => [id, title, kind, provider, status]),
		);
		if (dashboardData.jobKey === jobKey) return;
		if (jobs.length) {
			const list = makeElement("ul", "dash-job-list");
			list.append(...jobs.map(jobRow));
			dashboardData.jobs.replaceChildren(list);
		} else {
			dashboardData.jobs.replaceChildren(
				makeElement("p", "dash-empty", "Jobs appear here when you submit a study."),
			);
		}
		dashboardData.jobKey = jobKey;
	}

	function mountDashboard() {
		main.append(dashboard.content.cloneNode(true));
		dashboardData = {
			work: main.querySelector("[data-dash-work]"),
			jobs: main.querySelector("[data-dash-jobs]"),
		};
		updateDashboard();
		return () => {
			dashboardData = null;
		};
	}

	function focusPage() {
		const heading = main.querySelector("h1") ?? main;
		if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
		heading.focus({ preventScroll: true });
	}

	function setDrawer(open, restoreFocus = false) {
		const wasOpen = opener.getAttribute("aria-expanded") === "true";
		const isOpen = mobile.matches && open;
		opener.setAttribute("aria-expanded", String(isOpen));
		scrim.hidden = !isOpen;
		document.body.classList.toggle("shell-drawer-open", isOpen);
		sidebar.inert = mobile.matches && !isOpen;
		content.inert = isOpen;
		skip.inert = isOpen;
		if (isOpen) {
			sidebar.setAttribute("role", "dialog");
			sidebar.setAttribute("aria-modal", "true");
			if (!wasOpen) closer.focus();
		} else {
			sidebar.removeAttribute("role");
			sidebar.removeAttribute("aria-modal");
			if (wasOpen && restoreFocus) opener.focus({ preventScroll: true });
		}
	}

	function mountRoute(next, focus = false) {
		if (next === route) {
			setDrawer(false, true);
			return;
		}

		setDrawer(false);
		cleanup?.();
		route = next;
		main.replaceChildren();
		locationLabel.textContent = routeNames[route];
		document.title = `${routeNames[route]} | Siluet`;
		for (const link of navLinks) {
			if (link.dataset.shellRoute === route) link.setAttribute("aria-current", "page");
			else link.removeAttribute("aria-current");
		}
		if (focus) window.scrollTo(0, 0);
		const previousFocus = document.activeElement;

		const renderers = {
			dashboard: mountDashboard,
			image: views.studios,
			video: views.studios,
			gallery: views.gallery,
			jobs: views.operations,
			settings: views.operations,
		};
		const render = renderers[route];
		if (typeof render === "function") {
			const dispose = render(main, route);
			cleanup = typeof dispose === "function" ? dispose : undefined;
		} else {
			main.append(
				makeElement("h1", "", routeNames[route]),
				makeElement("p", "", "This view is unavailable."),
			);
			cleanup = undefined;
		}

		if (focus && document.activeElement === previousFocus) focusPage();
	}

	function pageFor(fragment) {
		if (typeof fragment !== "string") return undefined;
		if (fragment.startsWith("settings/")) return "settings";
		return Object.hasOwn(routeNames, fragment) ? fragment : undefined;
	}

	studio.go = function go(next) {
		const page = pageFor(next);
		if (!page) return;
		if (window.location.hash !== `#${next}`) window.location.hash = next;
		mountRoute(page, true);
	};

	window.addEventListener("hashchange", () => {
		const page = pageFor(window.location.hash.slice(1)) ?? "dashboard";
		if (page !== route) mountRoute(page, true);
	});

	opener.addEventListener("click", () => setDrawer(true));
	closer.addEventListener("click", () => setDrawer(false, true));
	scrim.addEventListener("click", () => setDrawer(false, true));
	for (const trigger of walletTriggers) {
		trigger.addEventListener("click", () => {
			walletOpener = trigger;
			walletSearch.value = "";
			updateWallets();
			walletDialog.showModal();
		});
	}
	walletSearch.addEventListener("input", filterWallets);
	walletClose.addEventListener("click", () => walletDialog.close());
	walletDialog.addEventListener("close", () => {
		if (walletDialog.open || !walletOpener) return;
		const returnTo = walletOpener.getClientRects().length
			? walletOpener
			: Array.from(walletTriggers).find((trigger) => trigger.getClientRects().length);
		returnTo?.focus({ preventScroll: true });
		walletOpener = undefined;
	});
	walletEmpty.querySelector("a").addEventListener("click", (event) => {
		if (!isPrimaryClick(event)) return;
		event.preventDefault();
		const alreadyInSettings = route === "settings";
		walletOpener = undefined;
		walletDialog.close();
		studio.go(event.currentTarget.hash.slice(1));
		if (alreadyInSettings) focusPage();
	});
	mobile.addEventListener("change", () => {
		const focusWasInSidebar = sidebar.contains(document.activeElement);
		const focusWasOnMenu = document.activeElement === opener;
		setDrawer(false);
		if (mobile.matches && focusWasInSidebar) opener.focus({ preventScroll: true });
		if (!mobile.matches && (focusWasOnMenu || document.activeElement === closer)) {
			sidebar.querySelector('[aria-current="page"]').focus({ preventScroll: true });
		}
	});

	document.addEventListener("keydown", (event) => {
		if (opener.getAttribute("aria-expanded") !== "true") return;
		if (event.key === "Escape") {
			event.preventDefault();
			setDrawer(false, true);
		}
		if (event.key === "Tab") {
			const [first, last] = [sidebar.querySelector(".shell-brand"), navLinks[navLinks.length - 1]];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	});

	function isPrimaryClick(event) {
		return (
			event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
		);
	}

	skip.addEventListener("click", (event) => {
		if (!isPrimaryClick(event)) return;
		event.preventDefault();
		main.focus();
	});

	document.addEventListener("click", (event) => {
		if (!isPrimaryClick(event)) return;
		const link = event.target.closest('.shell-sidebar a[href^="#"]');
		if (!link) return;
		event.preventDefault();
		studio.go(link.hash.slice(1));
	});

	main.addEventListener("click", (event) => {
		if (route !== "dashboard" || !isPrimaryClick(event)) return;
		const link = event.target.closest('a[href^="#"]');
		if (!link) return;
		event.preventDefault();
		if (link.dataset.assetId && typeof studio.openAsset === "function")
			studio.openAsset(link.dataset.assetId);
		else studio.go(link.hash.slice(1));
	});

	setDrawer(false);
	updateWallets();
	mountRoute(pageFor(window.location.hash.slice(1)) ?? "dashboard");
	studio.subscribe((topic) => {
		if (topic === "settings") updateWallets();
		if (dashboardData) updateDashboard();
	});
	views.onboarding?.();
})();
