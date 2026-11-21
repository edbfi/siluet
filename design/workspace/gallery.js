(() => {
	const formats = {
		"image/jpeg": ["jpg", "jpeg"],
		"image/png": ["png"],
		"image/avif": ["avif"],
		"image/gif": ["gif"],
		"image/webp": ["webp"],
		"video/mp4": ["mp4"],
		"video/webm": ["webm"],
	};
	const accept = Object.entries(formats)
		.flatMap(([mime, extensions]) => [mime, ...extensions.map((extension) => `.${extension}`)])
		.join(",");
	const pageSize = 8;
	const dateLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

	const icons = {
		add: '<path d="M12 5v14M5 12h14"/>',
		arrowLeft: '<path d="m14 6-6 6 6 6"/>',
		arrowRight: '<path d="m10 6 6 6-6 6"/>',
		close: '<path d="m6 6 12 12M18 6 6 18"/>',
		download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
		external: '<path d="M13 5h6v6m0-6-9 9m0-8H5v13h13v-5"/>',
		expand: '<path d="M9 5H5v4m10-4h4v4m0 6v4h-4M5 15v4h4"/>',
		image:
			'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
		minus: '<path d="M5 12h14"/>',
		play: '<path d="m9 5 11 7-11 7z"/>',
		upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>',
	};

	function icon(name) {
		return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
	}

	function validateAsset(asset) {
		if (!asset || typeof asset.id !== "string" || typeof asset.src !== "string") return null;
		const mime = typeof asset.mime === "string" ? asset.mime.toLowerCase() : "";
		if (!Object.hasOwn(formats, mime) || mime.split("/")[0] !== asset.kind) return null;

		try {
			const url = new URL(asset.src, document.baseURI);
			if (url.protocol === "data:") {
				const header = asset.src.slice(0, asset.src.indexOf(",")).toLowerCase();
				if (header !== `data:${mime};base64`) return null;
			} else if (url.protocol === "blob:") {
				const localBlob = location.protocol === "file:" && url.origin === "null";
				if (!localBlob && url.origin !== location.origin) return null;
			} else {
				const localFile = url.protocol === "file:" && location.protocol === "file:" && !url.host;
				const sameSite =
					["http:", "https:"].includes(url.protocol) && url.origin === location.origin;
				const extension = url.pathname.toLowerCase().split(".").pop();
				if ((!localFile && !sameSite) || !formats[mime].includes(extension)) return null;
			}

			return {
				...asset,
				mime,
				src: url.href,
				title: typeof asset.title === "string" && asset.title.trim() ? asset.title : "Untitled",
			};
		} catch {
			return null;
		}
	}

	function downloadName(mime) {
		const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		return `siluet-${new Date().toISOString().slice(0, 10)}-${suffix}.${formats[mime][0]}`;
	}

	function createThumbnail(asset) {
		const card = document.createElement("button");
		card.className = "studio-gallery-card";
		card.type = "button";
		card.setAttribute("aria-haspopup", "dialog");

		const preview = document.createElement("span");
		preview.className = "studio-gallery-preview";
		preview.innerHTML = `<span class="studio-gallery-unavailable">${icon(asset.kind === "image" ? "image" : "play")}<span>Preview unavailable</span></span><span class="studio-gallery-preview-badge" aria-hidden="true">${icon(asset.kind === "video" ? "play" : "expand")}</span>`;

		const media = document.createElement(asset.kind === "image" ? "img" : "video");
		media.setAttribute("aria-hidden", "true");
		if (media instanceof HTMLImageElement) {
			media.alt = "";
			media.loading = "lazy";
			media.decoding = "async";
		} else {
			media.preload = "metadata";
			media.muted = true;
			media.playsInline = true;
		}
		media.addEventListener(
			"error",
			() => {
				media.remove();
				preview.classList.add("has-error");
			},
			{ once: true },
		);
		media.src = asset.src;
		preview.prepend(media);

		const info = document.createElement("span");
		info.className = "studio-gallery-card-info";
		const title = document.createElement("span");
		title.className = "studio-gallery-card-title";
		title.textContent = asset.title;
		const timestamp = new Date(asset.createdAt);
		const details = document.createElement("span");
		details.className = "studio-gallery-card-details";
		const format = asset.mime === "image/jpeg" ? "JPEG" : formats[asset.mime][0].toUpperCase();
		details.textContent = Number.isNaN(timestamp.getTime())
			? format
			: `${format} / ${dateLabel.format(timestamp)}`;
		info.append(title, details);
		card.append(preview, info);
		return card;
	}

	window.StudioViews ??= {};
	window.StudioViews.gallery = (root) => {
		const studio = window.Studio;
		const section = document.createElement("section");
		section.className = "studio-gallery";
		section.innerHTML = `
			<header class="studio-gallery-heading">
				<h1>Gallery</h1>
				<p>Preview and download your saved images and videos.</p>
			</header>
			<div class="studio-gallery-import">
				<span class="studio-gallery-import-icon">${icon("upload")}</span>
				<div class="studio-gallery-import-copy">
					<strong>Drop images or videos here</strong>
					<p id="gallery-import-description">Files stay on this device and clear when you reload or close this tab.</p>
				</div>
				<button type="button" class="studio-gallery-button studio-gallery-import-button" aria-describedby="gallery-import-description">${icon("add")} Add files</button>
				<input type="file" aria-label="Add images and videos" multiple hidden>
			</div>
			<p class="studio-gallery-import-status" role="status"></p>
			<div class="studio-gallery-toolbar">
				<div class="studio-gallery-filters" role="group" aria-label="Filter media">
					<button type="button" data-filter="all" aria-pressed="true">All media <span></span></button>
					<button type="button" data-filter="image" aria-pressed="false">Images <span></span></button>
					<button type="button" data-filter="video" aria-pressed="false">Videos <span></span></button>
				</div>
				<span class="studio-gallery-range" role="status"></span>
			</div>
			<ul class="studio-gallery-grid" aria-label="Media" role="list"></ul>
			<div class="studio-gallery-empty" hidden>
				${icon("image")}
				<p></p>
			</div>
			<nav class="studio-gallery-pagination" aria-label="Gallery pages" hidden>
				<button type="button" class="studio-gallery-button" aria-label="Previous page">${icon("arrowLeft")} <span>Previous</span></button>
				<span class="studio-gallery-page"></span>
				<button type="button" class="studio-gallery-button" aria-label="Next page"><span>Next</span> ${icon("arrowRight")}</button>
			</nav>
			<dialog class="studio-gallery-viewer" aria-labelledby="gallery-viewer-title">
				<div class="studio-gallery-viewer-header">
					<div class="studio-gallery-viewer-summary">
						<h2 id="gallery-viewer-title"></h2>
						<p class="studio-gallery-viewer-position" aria-live="polite"></p>
					</div>
					<div class="studio-gallery-viewer-navigation" role="group" aria-label="Browse previews">
						<button type="button" class="studio-gallery-icon-button" aria-label="Previous media">${icon("arrowLeft")}</button>
						<button type="button" class="studio-gallery-icon-button" aria-label="Next media">${icon("arrowRight")}</button>
						<button type="button" class="studio-gallery-icon-button" aria-label="Close viewer" autofocus>${icon("close")}</button>
					</div>
				</div>
				<div class="studio-gallery-stage" role="group" aria-label="Media preview"></div>
				<div class="studio-gallery-viewer-actions">
					<div class="studio-gallery-zoom" role="group" aria-label="Image zoom">
						<button type="button" class="studio-gallery-icon-button" aria-label="Zoom out">${icon("minus")}</button>
						<button type="button" class="studio-gallery-button studio-gallery-fit" aria-label="Reset zoom to fit">Fit</button>
						<button type="button" class="studio-gallery-icon-button" aria-label="Zoom in">${icon("add")}</button>
						<span class="studio-gallery-hint" id="gallery-pan-help">Drag or use arrow keys to pan</span>
					</div>
					<div class="studio-gallery-viewer-files">
						<a class="studio-gallery-button" target="_blank" rel="noopener noreferrer">${icon("external")} Open in new tab</a>
						<a class="studio-gallery-button" download>${icon("download")} Download</a>
					</div>
					<p class="studio-gallery-download-note" role="status"></p>
				</div>
			</dialog>`;
		root.append(section);

		const find = (selector) => section.querySelector(selector);
		const input = find("input");
		input.accept = accept;
		const addFiles = find(".studio-gallery-import-button");
		const importStatus = find(".studio-gallery-import-status");
		const filters = section.querySelectorAll("[data-filter]");
		const range = find(".studio-gallery-range");
		const grid = find(".studio-gallery-grid");
		const empty = find(".studio-gallery-empty");
		const pagination = find(".studio-gallery-pagination");
		const [previousPage, nextPage] = pagination.querySelectorAll("button");
		const pageLabel = find(".studio-gallery-page");
		const viewer = find("dialog");
		const viewerTitle = find("#gallery-viewer-title");
		const viewerPosition = find(".studio-gallery-viewer-position");
		const [previousMedia, nextMedia, closeViewer] = find(
			".studio-gallery-viewer-navigation",
		).querySelectorAll("button");
		const stage = find(".studio-gallery-stage");
		const zoomControls = find(".studio-gallery-zoom");
		const [zoomOut, zoomFit, zoomIn] = zoomControls.querySelectorAll("button");
		const openLink = find("a[target]");
		const downloadLink = find("a[download]");
		const downloadNote = find(".studio-gallery-download-note");

		let page = 0;
		let filter = "all";
		let assets = [];
		let visibleAssets = [];
		let selectedId = null;
		let opener = null;
		let openerId = null;
		let image = null;
		let imageScale = 1;
		let offsetX = 0;
		let offsetY = 0;
		let drag = null;
		let dragDepth = 0;
		let importing = false;
		let disposed = false;
		const cards = new Map();
		const objectUrls = new Map();

		function selectFilter(value) {
			filter = value;
			page = 0;
			renderGrid();
		}

		function renderGrid() {
			const focused = [...cards].find(([, button]) => button === document.activeElement)?.[0];
			visibleAssets = filter === "all" ? assets : assets.filter((asset) => asset.kind === filter);
			const pageCount = Math.max(1, Math.ceil(visibleAssets.length / pageSize));
			page = Math.min(page, pageCount - 1);
			const start = page * pageSize;
			const pageAssets = visibleAssets.slice(start, start + pageSize);
			const images = assets.filter((asset) => asset.kind === "image").length;
			const counts = { all: assets.length, image: images, video: assets.length - images };
			for (const button of filters) {
				button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
				button.querySelector("span").textContent = counts[button.dataset.filter];
			}

			const count = visibleAssets.length;
			range.textContent = count
				? `${start + 1}–${start + pageAssets.length} of ${count}`
				: "0 items";
			grid.hidden = count === 0;
			empty.hidden = count > 0;
			empty.querySelector("p").textContent =
				filter === "all"
					? "Add files to start your gallery."
					: `No ${filter === "image" ? "images" : "videos"} in your gallery yet.`;
			pagination.hidden = pageCount === 1;
			previousPage.disabled = page === 0;
			nextPage.disabled = page === pageCount - 1;
			pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;

			cards.clear();
			const items = pageAssets.map((asset) => {
				const item = document.createElement("li");
				const card = createThumbnail(asset);
				card.addEventListener("click", () => openViewer(asset.id, card));
				cards.set(asset.id, card);
				item.append(card);
				return item;
			});
			grid.replaceChildren(...items);
			if (focused) (cards.get(focused) ?? addFiles).focus();
		}

		function refreshAssets() {
			const byId = new Map();
			for (const item of studio.assets()) {
				const asset = validateAsset(item);
				if (asset && !byId.has(asset.id)) byId.set(asset.id, asset);
			}
			assets = [...byId.values()].sort(
				(left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0),
			);
			renderGrid();
			if (viewer.open) {
				const asset = assets.find((item) => item.id === selectedId);
				if (asset) updateViewerPosition(asset);
				else viewer.close();
			}
		}

		function changePage(delta) {
			const button = delta < 0 ? previousPage : nextPage;
			if (button.disabled) return;
			page += delta;
			renderGrid();
			if (button.disabled) (delta < 0 ? nextPage : previousPage).focus();
		}

		function updatePan() {
			const { clientWidth: width, clientHeight: height } = stage;
			if (!image?.naturalWidth || !width || !height) return;
			const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
			const limitX = Math.max(0, (image.naturalWidth * fit * imageScale - width) / 2);
			const limitY = Math.max(0, (image.naturalHeight * fit * imageScale - height) / 2);
			offsetX = Math.min(limitX, Math.max(-limitX, offsetX));
			offsetY = Math.min(limitY, Math.max(-limitY, offsetY));
			image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${imageScale})`;
		}

		function setZoom(value) {
			imageScale = Math.max(1, Math.min(value, 4));
			stage.classList.toggle("is-zoomed", imageScale > 1);
			stage.tabIndex = imageScale > 1 ? 0 : -1;
			if (imageScale > 1) stage.setAttribute("aria-describedby", "gallery-pan-help");
			else {
				stage.removeAttribute("aria-describedby");
				if (document.activeElement === stage) zoomFit.focus();
			}
			zoomOut.disabled = imageScale === 1;
			zoomIn.disabled = imageScale === 4;
			zoomFit.textContent = imageScale === 1 ? "Fit" : `${imageScale * 100}%`;
			updatePan();
		}

		function originalLink(asset) {
			if (!asset.src.startsWith("data:")) return asset.src;
			if (!objectUrls.has(asset.src)) {
				const encoded = asset.src.slice(asset.src.indexOf(",") + 1);
				const bytes =
					typeof Uint8Array.fromBase64 === "function"
						? Uint8Array.fromBase64(encoded)
						: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
				objectUrls.set(asset.src, URL.createObjectURL(new Blob([bytes], { type: asset.mime })));
			}
			return objectUrls.get(asset.src);
		}

		function clearDrag() {
			if (!drag) return;
			const { pointerId } = drag;
			drag = null;
			stage.classList.remove("is-panning");
			if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
		}

		function updateViewerPosition(asset) {
			const index = visibleAssets.findIndex((item) => item.id === asset.id);
			const kind = asset.kind === "image" ? "Image" : "Video";
			viewerPosition.textContent =
				index === -1 ? kind : `${kind} / ${index + 1} of ${visibleAssets.length}`;
			previousMedia.setAttribute("aria-disabled", String(index <= 0));
			nextMedia.setAttribute(
				"aria-disabled",
				String(index < 0 || index >= visibleAssets.length - 1),
			);
		}

		function displayMedia(asset) {
			selectedId = asset.id;
			viewerTitle.textContent = asset.title;
			downloadNote.textContent = "";
			updateViewerPosition(asset);
			clearDrag();
			offsetX = 0;
			offsetY = 0;
			stage.replaceChildren();
			const isImage = asset.kind === "image";
			const media = document.createElement(isImage ? "img" : "video");
			image = isImage ? media : null;
			zoomControls.hidden = !isImage;
			setZoom(1);

			try {
				const href = originalLink(asset);
				openLink.href = href;
				downloadLink.href = href;
				downloadLink.download = downloadName(asset.mime);
			} catch {
				openLink.removeAttribute("href");
				downloadLink.removeAttribute("href");
			}
			media.addEventListener(
				"error",
				() => {
					if (stage.firstChild !== media) return;
					const message = document.createElement("p");
					message.className = "studio-gallery-viewer-error";
					message.textContent = "This file could not be previewed.";
					stage.replaceChildren(message);
					image = null;
					zoomControls.hidden = true;
					stage.classList.remove("is-zoomed");
					stage.removeAttribute("aria-describedby");
					stage.tabIndex = -1;
				},
				{ once: true },
			);

			if (isImage) {
				media.alt = asset.title;
				media.draggable = false;
				media.addEventListener("load", updatePan, { once: true });
			} else {
				media.controls = true;
				media.playsInline = true;
				media.preload = "metadata";
				media.setAttribute("aria-label", asset.title);
			}
			media.src = asset.src;
			stage.append(media);
		}

		function openViewer(id, trigger) {
			const asset = assets.find((item) => item.id === id);
			if (!asset) return;
			opener = trigger;
			openerId = id;
			displayMedia(asset);
			trigger?.focus({ preventScroll: true });
			viewer.showModal();
		}

		function moveViewer(delta) {
			const index = visibleAssets.findIndex((asset) => asset.id === selectedId);
			if (index === -1) return;
			const next = visibleAssets[index + delta];
			if (next) displayMedia(next);
		}

		async function importMedia(files) {
			if (importing || !files.length) return;
			importing = true;
			addFiles.disabled = true;
			importStatus.textContent = "Checking files…";
			try {
				const supported = files
					.filter(
						(file) =>
							!file.type ||
							file.type === "application/octet-stream" ||
							Object.hasOwn(formats, file.type),
					)
					.map((file) =>
						file.type === "application/octet-stream"
							? new File([file], file.name, { lastModified: file.lastModified })
							: file,
					);
				const result = supported.length
					? await studio.importFiles(supported)
					: { added: 0, rejected: 0 };
				if (disposed) return;
				const skipped = files.length - supported.length + result.rejected;
				const addedLabel = `${result.added} ${result.added === 1 ? "file" : "files"} added.`;
				const skippedLabel = `${skipped} ${skipped === 1 ? "file" : "files"} skipped.`;
				importStatus.textContent = skipped
					? `${addedLabel} ${skippedLabel} Choose JPEG, PNG, WebP, AVIF, GIF, MP4, or WebM files.`
					: addedLabel;
				if (result.added) {
					filter = "all";
					page = 0;
					refreshAssets();
				}
			} catch {
				if (!disposed)
					importStatus.textContent = "Files could not be added. Choose the files and try again.";
			} finally {
				importing = false;
				addFiles.disabled = false;
			}
		}

		for (const button of filters) {
			button.addEventListener("click", () => selectFilter(button.dataset.filter));
		}
		previousPage.addEventListener("click", () => changePage(-1));
		nextPage.addEventListener("click", () => changePage(1));
		addFiles.addEventListener("click", () => input.click());
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			input.value = "";
			void importMedia(files);
		});
		const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
		section.addEventListener("dragenter", (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			dragDepth += 1;
			section.classList.add("is-dropping");
		});
		section.addEventListener("dragover", (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = importing ? "none" : "copy";
		});
		section.addEventListener("dragleave", (event) => {
			if (!hasFiles(event)) return;
			dragDepth = Math.max(0, dragDepth - 1);
			if (!dragDepth) section.classList.remove("is-dropping");
		});
		section.addEventListener("drop", (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			dragDepth = 0;
			section.classList.remove("is-dropping");
			void importMedia(Array.from(event.dataTransfer.files));
		});

		previousMedia.addEventListener("click", () => moveViewer(-1));
		nextMedia.addEventListener("click", () => moveViewer(1));
		closeViewer.addEventListener("click", () => viewer.close());
		zoomOut.addEventListener("click", () => {
			setZoom(imageScale - 0.5);
			if (zoomOut.disabled) zoomFit.focus();
		});
		zoomIn.addEventListener("click", () => {
			setZoom(imageScale + 0.5);
			if (zoomIn.disabled) zoomFit.focus();
		});
		zoomFit.addEventListener("click", () => setZoom(1));
		downloadLink.addEventListener("click", (event) => {
			if (location.protocol === "file:" && downloadLink.href.startsWith("file:")) {
				event.preventDefault();
				downloadNote.textContent =
					"From the repository root, run bun design/workspace/export.js. Open design/workspace/workspace.html to download this file.";
				return;
			}
			const asset = assets.find((item) => item.id === selectedId);
			if (asset) downloadLink.download = downloadName(asset.mime);
		});

		viewer.addEventListener("close", () => {
			if (viewer.open) return;
			clearDrag();
			stage.replaceChildren();
			image = null;
			selectedId = null;
			if (
				!disposed &&
				(document.activeElement === document.body || viewer.contains(document.activeElement))
			) {
				const returnTo = opener?.isConnected ? opener : (cards.get(openerId) ?? addFiles);
				returnTo.focus();
			}
			opener = null;
			openerId = null;
		});

		const directions = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		};
		viewer.addEventListener("keydown", (event) => {
			if (
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.target instanceof HTMLVideoElement
			)
				return;
			if (event.target === stage && imageScale > 1 && Object.hasOwn(directions, event.key)) {
				const [x, y] = directions[event.key];
				event.preventDefault();
				offsetX += x * 32;
				offsetY += y * 32;
				updatePan();
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				moveViewer(event.key === "ArrowLeft" ? -1 : 1);
			} else if (image && ["+", "=", "-", "0"].includes(event.key)) {
				event.preventDefault();
				if (event.key === "0") setZoom(1);
				else setZoom(imageScale + (event.key === "-" ? -0.5 : 0.5));
			}
		});

		stage.addEventListener("pointerdown", (event) => {
			if (!image || imageScale === 1 || event.button !== 0 || drag) return;
			drag = { pointerId: event.pointerId, x: event.clientX - offsetX, y: event.clientY - offsetY };
			stage.setPointerCapture(event.pointerId);
			stage.classList.add("is-panning");
		});
		stage.addEventListener("pointermove", (event) => {
			if (drag?.pointerId !== event.pointerId) return;
			offsetX = event.clientX - drag.x;
			offsetY = event.clientY - drag.y;
			updatePan();
		});
		for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
			stage.addEventListener(type, (event) => {
				if (drag?.pointerId === event.pointerId) clearDrag();
			});
		}

		const resize = new ResizeObserver(updatePan);
		resize.observe(stage);
		const unsubscribe = studio.subscribe((topic) => {
			if (topic === "assets") refreshAssets();
		});
		refreshAssets();
		const pending = studio.consumeAsset();
		const index = assets.findIndex((asset) => asset.id === pending);
		if (index >= 0) {
			page = Math.floor(index / pageSize);
			renderGrid();
			openViewer(pending, cards.get(pending));
		}

		return () => {
			disposed = true;
			unsubscribe();
			resize.disconnect();
			clearDrag();
			if (viewer.open) viewer.close();
			for (const url of objectUrls.values()) URL.revokeObjectURL(url);
			section.remove();
		};
	};
})();
