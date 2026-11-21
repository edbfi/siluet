(() => {
	const catalog = window.SiluetModels;
	const providerOrder = Object.keys(catalog.providers);
	const providerSelectId = "studio-api-provider";
	const providerSelectMinimum = 3;
	const drafts = new Map();
	const fileFormats = {
		jpeg: ["image/jpeg", ".jpg", ".jpeg"],
		png: ["image/png", ".png"],
		webp: ["image/webp", ".webp"],
		gif: ["image/gif", ".gif"],
		mp4: ["video/mp4", ".mp4"],
		mov: ["video/quicktime", ".mov"],
	};
	const cases = [
		["success", "Successful result"],
		["transient", "Transient provider failure"],
		["rate-limit", "Provider rate limit and cooldown"],
		["content", "Content filter rejection"],
		["uncertain", "Submission acknowledgement lost"],
		["download", "Local download failure"],
		["failure", "Confirmed provider failure"],
	];
	const tideStudy = {
		id: "tide-study",
		kind: "image",
		title: "Tide study",
		src: "../studio/media/tide-study.webp",
	};
	const afterLight = { id: "after-light", title: "After light" };
	const tideLoop = {
		id: "tide-loop",
		kind: "video",
		title: "Tide loop",
		src: "../studio/media/tide-loop.webm",
	};
	const examples = {
		image: {
			generate: [
				tideStudy,
				"An amber signal lamp on a rocky tidal shelf at blue hour. Dark coastal hills silhouette the horizon over rippling water.",
			],
			edit: [
				afterLight,
				"Warm the horizon to copper and keep the amber lamp in place. Let the warmer light reflect across the water.",
			],
		},
		video: {
			generate: [
				tideLoop,
				"Hold on an amber signal lamp on a rocky shelf at blue hour as the tide ripples past.",
			],
			animate: [
				tideLoop,
				"Hold the signal lamp and rocky shelf steady as the tide moves past at blue hour.",
			],
			interpolate: [
				tideLoop,
				"Ease from the first frame to the last. Keep the amber lamp steady while the tide ripples past.",
			],
			edit: [
				tideLoop,
				"Keep the amber lamp, rocky shore, and timing. Give the tide and sky a cool blue-hour grade.",
			],
		},
	};
	function previewFixture(fallback) {
		return window.SiluetFixtures?.find(({ id }) => id === fallback.id) ?? fallback;
	}
	const previews = { image: previewFixture(tideStudy), video: previewFixture(tideLoop) };
	const filterFields = new Map([
		["poyo", "enable_safety_checker"],
		["toapis", "disable_nsfw"],
	]);

	function escapeHtml(value) {
		return String(value)
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	}

	function option(value, label, current) {
		return `<option value="${escapeHtml(value)}"${String(value) === String(current) ? " selected" : ""}>${escapeHtml(label)}</option>`;
	}

	function select(id, label, choices, current, attributes = "") {
		return `<div class="studio-field"><label for="${id}">${label}</label>
			<select id="${id}" ${attributes}>${choices.map(([value, name]) => option(value, name, current)).join("")}</select>
		</div>`;
	}

	function number(id, label, value, attributes = "") {
		return `<div class="studio-field"><label for="${id}">${label}</label>
			<input id="${id}" type="number" step="1" value="${escapeHtml(value ?? "")}" ${attributes}>
		</div>`;
	}

	function list(values) {
		return values.map((value) => [value, value]);
	}

	function ratioButton(value, label, current) {
		const isRatio = value.includes(":");
		const [width, height] = isRatio ? value.split(":").map(Number) : [1, 1];
		const scale = 31 / Math.max(width, height);
		return `<button class="studio-ratio${isRatio ? "" : " studio-ratio--word"}" type="button" data-ratio="${value}" aria-pressed="${current === value}">
			${isRatio ? `<span class="studio-ratio-frame" style="--frame-width:${width * scale}px;--frame-height:${height * scale}px" aria-hidden="true"></span>` : ""}
			<span>${label}</span>
		</button>`;
	}

	function media(asset) {
		const src = escapeHtml(asset.src);
		const title = escapeHtml(asset.title);
		const poster =
			asset.src === previews.video.src ? ` poster="${escapeHtml(previews.image.src)}"` : "";
		return asset.kind === "image"
			? `<img src="${src}" alt="${title}">`
			: `<video src="${src}"${poster} controls playsinline preload="metadata" aria-label="${title}"></video>`;
	}

	function pixelDimensions({ minPixels, maxPixels, maxRatio }, values) {
		const width = Number(values.width);
		const height = Number(values.height);
		const pixels = width * height;
		if (
			!Number.isInteger(width) ||
			!Number.isInteger(height) ||
			width < 1 ||
			height < 1 ||
			pixels < minPixels ||
			pixels > maxPixels ||
			Math.max(width / height, height / width) > maxRatio
		)
			return null;
		return [width, height];
	}

	function providerOptions(model, operation, values, kind) {
		const options = { [filterFields.get(model.provider)]: false, ...operation.fixed };
		if (operation.ratios && values.ratio !== "auto") {
			const ratio =
				values.ratio === "custom"
					? `${Number(values.ratioWidth)}:${Number(values.ratioHeight)}`
					: values.ratio;
			options[kind === "image" ? "size" : "aspect_ratio"] = ratio;
		}
		if (model.sizes) {
			if (values.sizeMode === "pixels") {
				const dimensions = pixelDimensions(model.customSize, values);
				if (!dimensions) {
					const { minPixels, maxPixels, maxRatio } = model.customSize;
					throw new Error(
						`Use whole pixel dimensions totaling ${minPixels.toLocaleString("en-US")} to ${maxPixels.toLocaleString("en-US")} pixels, with a ratio from 1:${maxRatio} to ${maxRatio}:1.`,
					);
				}
				options.size = dimensions.join("x");
			} else {
				options.size = values.size;
			}
		}
		if (model.resolutions) options.resolution = values.resolution;
		if (operation.duration ?? model.duration) options.duration = Number(values.duration);
		for (const field of model.advanced) {
			const value = values[field.key];
			if ((field.requires && !values[field.requires]) || value === "" || value === undefined)
				continue;
			if (field.metadata) options.metadata ??= {};
			const output = field.metadata ? options.metadata : options;
			output[field.key] = field.input === "number" ? Number(value) : value;
		}
		return options;
	}

	function studios(root, kind) {
		const studio = window.Studio;
		const models = catalog[kind];
		const isImage = kind === "image";
		const draft = drafts.get(kind) ?? {
			modelKey: models[0].modelKey,
			operations: {},
			values: new Map(),
			prompt: "",
			count: 1,
			outcome: "success",
		};
		drafts.set(kind, draft);

		let connectedModels;
		let modelChoices;
		let providerChoices;
		let model;
		let operation;
		let values;
		let sourcesCleared = false;
		const pending = new Map();
		let previewKey;
		const controller = new AbortController();
		const listen = { signal: controller.signal };

		function loadSelection(keys) {
			connectedModels = models.filter(({ provider }) => keys?.[provider]);
			modelChoices = connectedModels.length ? connectedModels : models;
			const listed =
				modelChoices.find(({ modelKey }) => modelKey === draft.modelKey) ?? modelChoices[0];
			providerChoices = connectedModels
				.filter(({ modelKey }) => modelKey === listed.modelKey)
				.sort((a, b) => providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider));
			model =
				providerChoices.find(({ provider }) => provider === draft.provider) ??
				providerChoices[0] ??
				listed;
			draft.modelKey = model.modelKey;
			draft.provider = providerChoices.length ? model.provider : undefined;

			const route = `${model.provider}/${model.id}`;
			const previous = draft.selection;
			const operationId =
				draft.operations[route] ??
				(previous?.model.modelKey === model.modelKey ? previous?.operation.id : undefined);
			operation = model.operations.find(({ id }) => id === operationId) ?? model.operations[0];
			const routeChanged = previous?.model !== model || previous?.operation !== operation;
			if (routeChanged) {
				pending.clear();
				for (const asset of draft.sources ?? []) {
					if (!asset) continue;
					studio.unstageSource(asset.id);
					sourcesCleared = true;
				}
				draft.sources = [];
				draft.slotCount = operation.source?.roles?.length ?? operation.source?.min ?? 0;
				draft.preview = undefined;
			}
			draft.selection = { model, operation };

			const key = `${route}/${operation.id}`;
			if (!draft.values.has(key)) {
				draft.values.set(key, {
					ratio: operation.ratioDefault ?? operation.ratios?.[0],
					ratioWidth: 3,
					ratioHeight: 2,
					sizeMode: "tier",
					size: model.sizeDefault,
					width: 2048,
					height: 2048,
					resolution: model.resolutionDefault,
					duration: (operation.duration ?? model.duration)?.default,
					...Object.fromEntries(model.advanced.map((field) => [field.key, field.default])),
				});
			}
			values = draft.values.get(key);
			return routeChanged;
		}

		loadSelection(studio.settings().keys);

		const simulationControls = `<details class="studio-disclosure studio-disclosure--simulation">
			<summary>Simulation controls</summary>
			${select("studio-outcome", "Simulated outcome", cases, draft.outcome)}
		</details>`;

		root.innerHTML = `
			<section class="studio-workspace" aria-labelledby="studio-title">
				<header class="studio-heading">
					<div>
						<h1 id="studio-title">${isImage ? "Image Studio" : "Video Studio"}</h1>
						<p>${isImage ? "Create a still or edit an image from your device." : "Build a clip from a prompt, keyframes, or an existing video."}</p>
						<a class="studio-review-jump" href="#studio-review-title">Review request</a>
					</div>
				</header>
				<form class="studio-layout">
					<div class="studio-recipe">
						<div class="studio-section-title"><h2>Request</h2></div>
						<div class="studio-routing" data-studio-models></div>
						<div class="studio-sources" data-studio-sources hidden></div>
						<div class="studio-prompt">
							<div class="studio-label-row">
								<label for="studio-prompt">Prompt</label>
								<button class="studio-text-button" type="button" data-action="example">Use example</button>
							</div>
							<textarea id="studio-prompt" rows="4" required placeholder="${isImage ? "Describe the subject, light, and what should change." : "Describe the movement, framing, and sound."}">${escapeHtml(draft.prompt)}</textarea>
						</div>
						<div class="studio-output" data-studio-output></div>
						<details class="studio-disclosure" data-studio-advanced>
							<summary>Advanced options</summary>
							<div class="studio-advanced-inner" data-studio-advanced-inner></div>
						</details>
					</div>

					<div class="studio-inspect">
						<figure class="studio-stage" data-studio-stage tabindex="-1"></figure>
						<section class="studio-review" aria-labelledby="studio-review-title">
							<div class="studio-section-title"><h2 id="studio-review-title" tabindex="-1">Review request</h2></div>
							${
								isImage
									? imageReview()
									: `<div data-studio-summary></div>
									<details class="studio-disclosure" data-studio-wire>
										<summary>Outgoing request</summary>
										<div class="studio-wire" data-studio-wire-inner></div>
									</details>
									${simulationControls}`
							}
							<div class="studio-actions">
								<button class="studio-submit" type="submit"></button>
								<button class="studio-text-button" data-action="jobs" type="button">View jobs</button>
							</div>
							<p class="studio-status" role="status" aria-live="polite"></p>
						</section>
					</div>
				</form>
			</section>`;

		const form = root.querySelector(".studio-layout");
		const prompt = form.querySelector("#studio-prompt");
		const output = form.querySelector("[data-studio-output]");
		const summary = form.querySelector("[data-studio-summary]");
		const wire = form.querySelector("[data-studio-wire]");
		const wireBody = form.querySelector("[data-studio-wire-inner]");
		const reviewTabs = [...form.querySelectorAll(".studio-review-tabs button")];
		const reviewPanels = reviewTabs.map((tab) =>
			form.querySelector(`#${tab.getAttribute("aria-controls")}`),
		);
		const imageRetries = form.querySelector("[data-studio-retries]");
		const submitExposure = form.querySelector("#studio-submit-exposure");
		const sourceFields = form.querySelector("[data-studio-sources]");
		const stage = form.querySelector("[data-studio-stage]");
		const advancedDisclosure = form.querySelector("[data-studio-advanced]");
		const advanced = form.querySelector("[data-studio-advanced-inner]");
		const modelFields = form.querySelector("[data-studio-models]");
		const status = form.querySelector(".studio-status");
		const submit = form.querySelector(".studio-submit");

		function imageReview() {
			const panels = [
				["summary", "Review", "<div data-studio-summary></div>"],
				[
					"batch",
					"Batch",
					`${batchField()}
					<div class="studio-exposure">
						<span data-studio-retries></span>
						<button type="button" id="studio-retry-settings" class="studio-text-button" data-action="settings/generation">Retry settings</button>
					</div>
					${simulationControls}
					<p class="studio-help studio-local">Simulation only. Nothing leaves this workspace.</p>`,
				],
				["wire", "Outgoing request", '<div class="studio-wire" data-studio-wire-inner></div>'],
			];
			return `
				<div class="studio-review-tabs" role="tablist" aria-labelledby="studio-review-title">
					${panels.map(([id, label], index) => `<button type="button" role="tab" id="studio-review-tab-${id}" aria-controls="studio-review-panel-${id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join("")}
				</div>
				${panels.map(([id, , content], index) => `<div id="studio-review-panel-${id}" class="studio-review-panel" role="tabpanel" aria-labelledby="studio-review-tab-${id}" tabindex="0"${index === 0 ? "" : " hidden"}${id === "wire" ? " data-studio-wire" : ""}>${content}</div>`).join("")}
				<p class="studio-submit-exposure" id="studio-submit-exposure" hidden></p>`;
		}

		function selectReviewTab(active) {
			for (const [index, tab] of reviewTabs.entries()) {
				const selected = tab === active;
				tab.setAttribute("aria-selected", String(selected));
				tab.tabIndex = selected ? 0 : -1;
				reviewPanels[index].hidden = !selected;
			}
			active.focus({ preventScroll: true });
			renderWire();
		}

		function sourceLabel(index) {
			return operation.source.roles?.[index] ?? `Reference image ${index + 1}`;
		}

		function selectedSources() {
			return draft.sources.flatMap((asset, index) =>
				asset ? [{ ...asset, slot: index, label: sourceLabel(index) }] : [],
			);
		}

		function renderStage() {
			const sources = selectedSources();
			const active = sources.find(({ id }) => id === draft.preview) ?? sources[0];
			const asset = active ?? (operation.source ? null : previews[kind]);
			const label = active?.label ?? (asset ? "Sample preview" : "Source preview");
			const key = [asset?.id, label, operation.source?.kind];
			if (previewKey?.every((value, i) => value === key[i])) return;
			previewKey = key;
			const preview = active
				? active.origin === "local" && active.src?.startsWith("blob:")
					? media(active)
					: '<p class="studio-stage-message">Preview available for local files.</p>'
				: asset
					? media(asset)
					: `<p class="studio-stage-message">Choose ${operation.source.kind === "video" ? "a video" : "an image"} to preview it here.</p>`;
			stage.innerHTML = `
				<div class="studio-stage-media">${preview}<p class="studio-stage-message" data-preview-error hidden>Preview unavailable for this file.</p></div>
				<figcaption><strong>${escapeHtml(asset?.title ?? "No source selected")}</strong><span>${label}</span></figcaption>`;
		}

		function sourceFormats(source) {
			return source.formats.map((format) => format.toUpperCase()).join(", ");
		}

		function renderSourceSlot(row, index) {
			const source = operation.source;
			const label = sourceLabel(index);
			const asset = draft.sources[index];
			const accept = source.formats.flatMap((format) => fileFormats[format]).join(",");
			const urlLabel = source.protocols?.length > 1 ? "HTTP or HTTPS" : "HTTPS";
			row.innerHTML = `
				<div class="studio-source-heading">
					<label for="studio-source-file-${index}">${label}</label>
					${index >= source.min ? "<span>Optional</span>" : source.roles ? "<span>Required</span>" : ""}
				</div>
				<div class="studio-source-picker">
					<span class="studio-source-pick-label" aria-hidden="true">${asset?.origin === "local" ? "Replace file" : "Choose file"}</span>
					${asset?.origin === "local" ? `<span class="studio-source-filename" id="studio-source-filename-${index}">${escapeHtml(asset.title)}</span>` : ""}
					<input id="studio-source-file-${index}" type="file" accept="${accept}" data-source-file="${index}" aria-label="${asset?.origin === "local" ? "Replace" : "Choose"} ${label.toLowerCase()} file" aria-describedby="studio-source-formats studio-source-status-${index}${asset?.origin === "local" ? ` studio-source-filename-${index}` : ""}">
				</div>
				${
					asset
						? `<div class="studio-source-current">
					${asset.origin === "remote" ? `<span>${escapeHtml(asset.title)} (URL hidden)</span>` : ""}
					<button type="button" class="studio-text-button" data-preview="${index}" aria-label="Preview ${label.toLowerCase()}">Preview</button>
					<button type="button" class="studio-text-button" data-remove-source="${index}" aria-label="Remove ${label.toLowerCase()}">Remove</button>
				</div>`
						: ""
				}
				${
					source.protocols?.length
						? `<details class="studio-source-url">
					<summary>Use a URL</summary>
					<div class="studio-field">
						<label for="studio-source-url-${index}">${urlLabel} URL for ${label.toLowerCase()}</label>
						<div class="studio-source-link">
							<input type="text" inputmode="url" id="studio-source-url-${index}" data-source-url autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="studio-source-status-${index}">
							<button type="button" class="studio-text-button" data-add-url="${index}">Use URL</button>
						</div>
					</div>
				</details>`
						: ""
				}
				<p class="studio-source-status" id="studio-source-status-${index}" data-source-status role="status"></p>`;
		}

		function renderSources() {
			const source = operation.source;
			sourceFields.hidden = !source;
			sourceFields.replaceChildren();
			if (!source) return;

			const legend = source.max === 1 ? "Source" : source.roles ? "Keyframes" : "Reference images";
			sourceFields.innerHTML = `<fieldset class="studio-source-group">
				<legend>${legend}</legend>
				<p class="studio-help" id="studio-source-formats">${source.roles ? "" : `Choose ${source.min}–${source.max} images. `}${sourceFormats(source)}${source.maxSize ? ` up to ${source.maxSize} per file` : ""}.</p>
			</fieldset>`;
			for (let index = 0; index < draft.slotCount; index++) appendSourceSlot(index);
		}

		function appendSourceSlot(index) {
			const row = document.createElement("div");
			row.className = "studio-source-row";
			row.dataset.sourceSlot = index;
			renderSourceSlot(row, index);
			sourceFields.querySelector("fieldset").append(row);
		}

		function reportSource(row, message, error = false) {
			const feedback = row.querySelector("[data-source-status]");
			feedback.textContent = message;
			feedback.classList.toggle("studio-status--error", error);
		}

		function setSource(row, index, asset) {
			const previous = draft.sources[index];
			draft.sources[index] = asset;
			draft.preview = asset?.id ?? (draft.preview === previous?.id ? undefined : draft.preview);
			renderSourceSlot(row, index);
			if (asset && index === draft.slotCount - 1 && draft.slotCount < operation.source.max) {
				appendSourceSlot(draft.slotCount++);
			}
			renderStage();
			renderSummary();
			renderWire();
			if (previous) studio.unstageSource(previous.id);
		}

		async function attachFile(input) {
			const file = input.files[0];
			input.value = "";
			if (!file) return;
			const row = input.closest("[data-source-slot]");
			const index = Number(input.dataset.sourceFile);
			const source = operation.source;
			const mime = file.type.toLowerCase();
			const extensionsOnly = !mime || mime === "application/octet-stream";
			const name = file.name.toLowerCase();
			const format = source.formats.find((format) => {
				const [type, ...extensions] = fileFormats[format];
				return extensionsOnly ? extensions.some((suffix) => name.endsWith(suffix)) : type === mime;
			});
			const urlButton = row.querySelector("[data-add-url]");
			if (!format || !file.size || (source.maxBytes && file.size > source.maxBytes)) {
				pending.delete(index);
				if (urlButton) urlButton.disabled = false;
				reportSource(
					row,
					`Choose a non-empty ${sourceFormats(source)} file${source.maxSize ? ` up to ${source.maxSize}` : ""}.`,
					true,
				);
				return;
			}

			const token = {};
			pending.set(index, token);
			if (urlButton) urlButton.disabled = true;
			// Keep the picker focusable while the current file is staged. A newer choice supersedes it.
			reportSource(row, "Preparing file…");
			let asset;
			try {
				asset = await studio.stageFile(file, source.kind, [fileFormats[format][0]]);
			} catch {
				if (pending.get(index) !== token) return;
				pending.delete(index);
				if (urlButton) urlButton.disabled = false;
				reportSource(
					row,
					`Could not read this file. Choose a valid ${sourceFormats(source)} file.`,
					true,
				);
				return;
			}

			if (pending.get(index) !== token) {
				studio.unstageSource(asset.id);
				return;
			}
			pending.delete(index);
			const hadFocus = row.contains(document.activeElement);
			setSource(row, index, asset);
			if (hadFocus) focus(input.id);
			reportSource(row, "File selected.");
		}

		function attachUrl(button) {
			const row = button.closest("[data-source-slot]");
			const input = row.querySelector("[data-source-url]");
			const index = Number(button.dataset.addUrl);
			const source = operation.source;
			if (pending.has(index)) {
				reportSource(row, "Wait for the selected file to finish preparing.", true);
				return;
			}
			const value = input.value.trim();
			const url = URL.parse(value);
			if (
				!url ||
				!/^https?:\/\//i.test(value) ||
				!source.protocols.includes(url.protocol) ||
				url.username ||
				url.password
			) {
				const protocols = source.protocols.length > 1 ? "HTTP or HTTPS" : "HTTPS";
				reportSource(row, `Enter a public ${protocols} URL without a username or password.`, true);
				input.focus();
				return;
			}
			let asset;
			try {
				asset = studio.stageUrl(value, source.kind);
			} catch {
				reportSource(row, "Could not use the URL. Check the address and try again.", true);
				return;
			}
			setSource(row, index, {
				id: asset.id,
				origin: "remote",
				kind: source.kind,
				title: url.hostname,
			});
			focus(`studio-source-file-${index}`);
			reportSource(row, "URL selected.");
		}

		function selectedPixelRatio() {
			if (values.sizeMode !== "pixels") return;
			const dimensions = pixelDimensions(model.customSize, values);
			if (!dimensions) return;
			const [width, height] = dimensions;
			return Object.keys(model.sizePresets).find((ratio) => {
				const [presetWidth, presetHeight] = model.sizePresets[ratio];
				return width * presetHeight === height * presetWidth;
			});
		}

		function renderOutput() {
			const duration = operation.duration ?? model.duration;
			const choices = model.sizePresets ? Object.keys(model.sizePresets) : operation.ratios;
			const selected = model.sizePresets ? selectedPixelRatio() : values.ratio;
			const ratios = choices && [
				...choices.map((ratio) => ratioButton(ratio, ratio, selected)),
				...(operation.autoRatio ? [ratioButton("auto", operation.autoRatio, selected)] : []),
				...(operation.customRatio ? [ratioButton("custom", "Custom ratio", selected)] : []),
			];
			const size = model.sizes
				? `
				<div class="studio-fields">
					${select(
						"studio-size-mode",
						"Size mode",
						[
							["tier", "Resolution tier"],
							["pixels", "Exact dimensions"],
						],
						values.sizeMode,
						'data-value="sizeMode"',
					)}
					${values.sizeMode === "tier" ? select("studio-size", "Resolution", list(model.sizes), values.size, 'data-value="size"') : ""}
				</div>
				${
					values.sizeMode === "pixels"
						? `<div class="studio-fields">
					${number("studio-width", "Width (px)", values.width, 'data-value="width" min="1" required aria-describedby="studio-size-help"')}
					${number("studio-height", "Height (px)", values.height, 'data-value="height" min="1" required aria-describedby="studio-size-help"')}
				</div><p class="studio-help" id="studio-size-help">${model.customSize.minPixels.toLocaleString("en-US")}–${model.customSize.maxPixels.toLocaleString("en-US")} pixels total. Ratio from 1:${model.customSize.maxRatio} to ${model.customSize.maxRatio}:1.</p>`
						: '<p class="studio-help">The provider chooses the ratio at this resolution.</p>'
				}
			`
				: "";
			output.innerHTML = `
				${ratios ? `<fieldset class="studio-frame-group"><legend>${model.sizePresets ? "Framing presets" : "Aspect ratio"}</legend><div class="studio-ratios">${ratios.join("")}</div></fieldset>` : ""}
				${
					values.ratio === "custom"
						? `<div class="studio-fields">
					${number("studio-ratio-width", "Ratio width", values.ratioWidth, 'data-value="ratioWidth" min="1" required')}
					${number("studio-ratio-height", "Ratio height", values.ratioHeight, 'data-value="ratioHeight" min="1" required')}
				</div>`
						: ""
				}
				${operation.framing ? `<div class="studio-inherited"><span>Framing</span><p>${operation.framing}</p></div>` : ""}
				${size}
				${
					model.resolutions || duration
						? `<div class="studio-fields">
					${model.resolutions ? select("studio-resolution", "Resolution", list(model.resolutions), values.resolution, 'data-value="resolution"') : ""}
					${duration ? number("studio-duration", "Duration (seconds)", values.duration, `data-value="duration" min="${duration.min}" max="${duration.max}" required`) : ""}
				</div>`
						: ""
				}
			`;
		}

		function renderAdvanced() {
			advancedDisclosure.hidden = !model.advanced.length;
			const fields = model.advanced.filter((field) => !field.requires || values[field.requires]);
			advanced.innerHTML = `<div class="studio-fields">
				${fields
					.map((field) => {
						const id = `studio-advanced-${field.key}`;
						const data = `data-value="${field.key}"`;
						if (field.values) {
							const choices = field.values.map((value, i) => [value, field.labels?.[i] ?? value]);
							return select(id, field.label, choices, values[field.key], data);
						}
						if (field.input === "number") return number(id, field.label, values[field.key], data);
						return `<label class="studio-check" for="${id}"><input type="checkbox" id="${id}" ${data}${values[field.key] ? " checked" : ""}>${field.label}</label>`;
					})
					.join("")}
			</div>`;
			if (values.background === "transparent") {
				const format = form.querySelector("#studio-advanced-output_format");
				format.querySelector('[value="jpeg"]').disabled = true;
			}
		}

		function batchField() {
			return `<div class="studio-batch">
				${select(
					"studio-count",
					"Batch count",
					[
						[1, "1 request"],
						[2, "2 requests"],
						[3, "3 requests"],
						[4, "4 requests"],
						[5, "5 requests"],
					],
					draft.count,
					'aria-describedby="studio-batch-help"',
				)}
				<p class="studio-help" id="studio-batch-help">Each request runs independently.</p>
			</div>`;
		}

		function retryLimit(settings) {
			return settings.retryEnabled ? (settings.retryLimit ?? 3) : 0;
		}

		function renderPrice({ retry = retryLimit(studio.settings()), options } = {}) {
			const price = summary.querySelector("[data-studio-price]");
			if (!price) return false;
			const estimate = window.SiluetPricing?.estimate;
			let label = "Unknown";
			if (estimate && !submit.disabled) {
				try {
					const sources = selectedSources();
					label =
						estimate({
							provider: model.provider,
							model: model.id,
							operation: operation.id,
							options: options ?? providerOptions(model, operation, values, kind),
							sourceCount: sources.length,
							sourceKinds: sources.map(({ kind }) => kind),
							count: draft.count,
							retryLimit: retry,
						}) ?? label;
				} catch {
					// An incomplete draft can have invalid provider options.
				}
			}
			if (price.textContent === label) return false;
			price.textContent = label;
			return true;
		}

		function renderSummary() {
			const settings = studio.settings();
			const retry = retryLimit(settings);
			const attempts = draft.count * (1 + retry);
			const exposure = `${attempts} potentially billable ${attempts === 1 ? "attempt" : "attempts"}`;
			const retries = settings.retryEnabled
				? `Up to ${retry} additional ${retry === 1 ? "retry" : "retries"} per request.`
				: "Automatic retries are off.";
			const sources = selectedSources();
			const required = operation.source?.min ?? 0;
			const mediaSummary = sources.length
				? `<ul class="studio-review-sources">${sources
						.map(
							({ label, title, origin }) =>
								`<li>${label}: ${escapeHtml(title)}${origin === "remote" ? " (URL hidden)" : ""}</li>`,
						)
						.join("")}</ul>${sources.length < required ? "More sources required" : ""}`
				: required
					? "Source required"
					: "None";
			const provider = draft.provider ? catalog.providers[draft.provider] : undefined;
			const canSubmit = provider && filterFields.has(model.provider);
			const walletUnchecked = draft.provider === "toapis" && settings.wallet?.toapis === false;
			summary.innerHTML = `
				<dl class="studio-review-facts">
					<div><dt>API provider</dt><dd>${escapeHtml(provider ?? "None connected")}${isImage ? "" : ` <span class="studio-fact-note">${model.name}</span>`}</dd></div>
					<div><dt>Operation</dt><dd>${operation.exact}</dd></div>
					<div><dt>${canSubmit ? "Media sent" : "Source media"}</dt><dd>${mediaSummary}</dd></div>
					${canSubmit ? `<div><dt>Price</dt><dd><span data-studio-price>Unknown</span>${walletUnchecked ? ' <span class="studio-fact-note">Balance unchecked</span>' : ""}</dd></div>` : ""}
				</dl>
				${canSubmit && model.schemaWarning ? `<p class="studio-help">${escapeHtml(model.schemaWarning)}</p>` : ""}`;
			submit.textContent = `Queue ${draft.count} ${draft.count === 1 ? "request" : "requests"}`;
			submit.disabled = !canSubmit;
			renderPrice({ retry });
			if (isImage) {
				imageRetries.textContent = retries;
				submitExposure.hidden = !canSubmit || attempts === 1;
				submitExposure.textContent = submitExposure.hidden ? "" : `Up to ${exposure}.`;
				if (submitExposure.hidden) submit.removeAttribute("aria-describedby");
				else submit.setAttribute("aria-describedby", submitExposure.id);
			} else {
				summary.insertAdjacentHTML(
					"beforeend",
					`${batchField()}
					<p class="studio-exposure">${canSubmit ? `Up to <strong>${exposure}</strong>.` : ""}
						${retries}
						<button type="button" id="studio-retry-settings" class="studio-text-button" data-action="settings/generation">Retry settings</button>
					</p>
					<p class="studio-help studio-local">Simulation only. Nothing leaves this workspace.</p>`,
				);
			}
		}

		function renderWire() {
			if (!isImage) wire.hidden = !draft.provider;
			if (wire.hidden) {
				wireBody.replaceChildren();
				return;
			}
			if (!draft.provider) {
				wireBody.innerHTML =
					'<p class="studio-help">Connect an API provider to preview this request.</p>';
				return;
			}
			const filterField = filterFields.get(model.provider);
			if (!filterField) {
				wireBody.innerHTML =
					'<p class="studio-help">Request preview is unavailable for this API provider.</p>';
				return;
			}
			if (!isImage && !wire.open) return;
			const poyo = model.provider === "poyo";
			const url = poyo
				? "https://api.poyo.ai/api/generate/submit"
				: `https://toapis.com/v1/${isImage ? "images" : "videos"}/generations`;
			const filter = `${poyo ? "input." : ""}${filterField}`;
			const promptField = poyo ? "input.prompt" : "prompt";
			const source = operation.source;
			const sourceValues = selectedSources().map(({ origin, kind, slot }) => {
				const url = origin === "local" ? `[local ${kind}]` : "[remote URL hidden]";
				const role = source.wireRoles?.[slot] ?? source.wireRole;
				return role ? { url, role } : url;
			});
			if (isImage) {
				renderImageWire(url, poyo, sourceValues);
				return;
			}
			let optionDetails;
			try {
				const { [filterField]: _filter, ...other } = providerOptions(
					model,
					operation,
					values,
					kind,
				);
				optionDetails = Object.keys(other).length
					? `<p class="studio-wire-options"><strong>${poyo ? "Other input options" : "Other options"}</strong> <code>${escapeHtml(JSON.stringify(other))}</code></p>`
					: "";
			} catch {
				optionDetails = '<p class="studio-help">Enter valid dimensions to preview the size.</p>';
			}
			wireBody.innerHTML = `
				<p><code>POST ${url}</code></p>
				<p><code>model</code> ${model.id}</p>
				<p class="studio-wire-prompt"><code>${promptField}</code> ${escapeHtml(draft.prompt.trim() || "Add a prompt")}</p>
				${source ? `<p class="studio-wire-options"><code>${source.field}</code> ${sourceValues.length ? `<code>${escapeHtml(JSON.stringify(sourceValues))}</code>` : "Choose media"}</p>` : ""}
				<p><code>${filter} = false</code></p>
				${model.filterNote ? `<p class="studio-help">${model.filterNote}</p>` : ""}
				${optionDetails}
				<p><a class="studio-docs" href="${model.evidence}" target="_blank" rel="noopener noreferrer">Model documentation</a></p>`;
		}

		function renderImageWire(url, poyo, sourceValues) {
			let options;
			try {
				options = providerOptions(model, operation, values, kind);
			} catch {
				wireBody.innerHTML =
					'<p class="studio-help">Enter valid dimensions to preview this request.</p>';
				return;
			}
			const input = {
				prompt: draft.prompt.trim().replace(/https?:\/\/[^\s<>"']+/gi, "[URL hidden]"),
				...options,
			};
			const source = operation.source;
			if (sourceValues.length) input[source.field.replace(/^input\./, "")] = sourceValues;
			const payload = poyo ? { model: model.id, input } : { model: model.id, ...input };
			wireBody.innerHTML = `
				<p><code>POST ${escapeHtml(url)}</code></p>
				<pre class="studio-wire-json" tabindex="0" aria-label="JSON request body"><code>${escapeHtml(JSON.stringify(payload, null, 2))}</code></pre>
				${sourceValues.length < (source?.min ?? 0) ? '<p class="studio-help">Choose source media to complete this request.</p>' : ""}
				${model.filterNote ? `<p class="studio-help">${model.filterNote}</p>` : ""}
				<p><a class="studio-docs" href="${model.evidence}" target="_blank" rel="noopener noreferrer">Model documentation</a></p>`;
		}

		function providerField() {
			const choices = providerChoices.map(({ provider }) => [
				provider,
				catalog.providers[provider],
			]);
			if (choices.length >= providerSelectMinimum) {
				return select(providerSelectId, "API provider", choices, draft.provider);
			}
			const radios = choices.map(([provider, name]) => {
				const id = escapeHtml(`studio-provider-${provider}`);
				return `
					<label class="studio-provider-option" for="${id}">
						<input type="radio" name="studio-provider" id="${id}" value="${escapeHtml(provider)}"${provider === draft.provider ? " checked" : ""}>
						<span>${escapeHtml(name)}</span>
					</label>`;
			});
			return `
				<fieldset class="studio-provider-group">
					<legend>API provider</legend>
					${
						radios.length
							? `<div class="studio-provider-options">${radios.join("")}</div>`
							: `
						<div class="studio-provider-empty">
							<p>Connect a provider to queue requests.</p>
							<button type="button" id="studio-provider-settings" class="studio-text-button" data-action="settings/providers/${escapeHtml(model.provider)}">Open settings</button>
						</div>`
					}
				</fieldset>`;
		}

		function renderRouting() {
			const families = new Map();
			for (const { family, modelKey, name } of modelChoices) {
				if (!families.has(family)) families.set(family, new Map());
				families.get(family).set(modelKey, name);
			}
			const choices = [...families]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([family, members]) =>
						`<optgroup label="${escapeHtml(family)}">${[...members].map(([key, name]) => option(key, name, draft.modelKey)).join("")}</optgroup>`,
				);
			modelFields.innerHTML = `
				<div class="studio-field">
					<div class="studio-model-heading">
						<label for="studio-model">Model</label>
						<span class="studio-model-family" id="studio-model-family">${escapeHtml(model.family)}</span>
					</div>
					<select id="studio-model" aria-describedby="studio-model-family">${choices.join("")}</select>
				</div>
				<div class="studio-fields">
					${providerField()}
					${select("studio-operation", "Operation", operationList(), operation.id)}
				</div>`;
		}

		function renderSelection(routeChanged = true) {
			renderRouting();
			if (routeChanged) {
				if (model.promptMin) prompt.minLength = model.promptMin;
				else prompt.removeAttribute("minlength");
				if (model.promptMax) prompt.maxLength = model.promptMax;
				else prompt.removeAttribute("maxlength");
				renderSources();
				renderStage();
				renderOutput();
				renderAdvanced();
			}
			renderSummary();
			renderWire();
			if (sourcesCleared) {
				report("Source media cleared. Choose it again for this request.");
				sourcesCleared = false;
			}
		}

		function operationList() {
			return model.operations.map((item) => [item.id, item.label]);
		}

		function focus(id) {
			form.querySelector(`#${CSS.escape(id)}`)?.focus({ preventScroll: true });
		}

		function restoreFocus(control) {
			let { id } = control;
			if (id === providerSelectId && providerChoices.length < providerSelectMinimum) {
				id = draft.provider ? `studio-provider-${draft.provider}` : "studio-model";
			} else if (
				control.name === "studio-provider" &&
				providerChoices.length >= providerSelectMinimum
			) {
				id = providerSelectId;
			}
			if (id) focus(id);
			if (!form.contains(document.activeElement)) focus("studio-model");
		}

		function report(message, error = false) {
			status.textContent = message;
			status.classList.toggle("studio-status--error", error);
		}

		function clearError() {
			if (status.classList.contains("studio-status--error")) report("");
		}

		root.querySelector(".studio-review-jump").addEventListener(
			"click",
			(event) => {
				event.preventDefault();
				const heading = form.querySelector("#studio-review-title");
				heading.focus({ preventScroll: true });
				heading.scrollIntoView({ block: "start" });
			},
			listen,
		);

		form.addEventListener(
			"input",
			({ target }) => {
				clearError();
				if (target === prompt) draft.prompt = prompt.value;
				const key = target.dataset.value;
				if (target.type === "number" && key) {
					values[key] = target.value;
					renderPrice();
				}
				if (model.sizePresets && (key === "width" || key === "height")) {
					const selected = selectedPixelRatio();
					for (const button of output.querySelectorAll("[data-ratio]")) {
						button.setAttribute("aria-pressed", String(button.dataset.ratio === selected));
					}
				}
				renderWire();
			},
			listen,
		);

		form.addEventListener(
			"change",
			({ target }) => {
				clearError();
				const { id, dataset, value, checked, type } = target;
				const providerChanged =
					id === providerSelectId || (target.name === "studio-provider" && checked);
				if (id === "studio-model" || id === "studio-operation" || providerChanged) {
					if (id === "studio-model") draft.modelKey = value;
					else if (providerChanged) draft.provider = value;
					else draft.operations[`${model.provider}/${model.id}`] = value;
					report("");
					renderSelection(loadSelection(studio.settings().keys));
					restoreFocus(target);
					return;
				} else if (id === "studio-count") {
					draft.count = Number(value);
					renderSummary();
					if (!isImage) focus(id);
				} else if (id === "studio-outcome") {
					draft.outcome = value;
				} else if (dataset.sourceFile !== undefined) {
					void attachFile(target);
				} else if (dataset.value) {
					const key = dataset.value;
					values[key] = type === "checkbox" ? checked : value;
					if (key === "sizeMode") {
						renderOutput();
						focus(id);
					}
					if (key === "background" || model.advanced.some((field) => field.requires === key)) {
						if (key === "background" && value === "transparent") values.output_format = "png";
						renderAdvanced();
						focus(id);
					}
					renderPrice();
				}
				renderWire();
			},
			listen,
		);

		form.addEventListener(
			"click",
			(event) => {
				const button = event.target.closest("button");
				if (!button) return;
				if (reviewTabs.includes(button)) {
					selectReviewTab(button);
					return;
				}
				if (button === submit && event.detail > 1) {
					event.preventDefault();
					return;
				}
				const { action, ratio, preview, addUrl, removeSource } = button.dataset;
				if (ratio) {
					clearError();
					if (model.sizePresets) {
						const [width, height] = model.sizePresets[ratio];
						Object.assign(values, { width, height, sizeMode: "pixels" });
					} else {
						values.ratio = ratio;
					}
					renderOutput();
					output.querySelector(`[data-ratio="${ratio}"]`)?.focus({ preventScroll: true });
					renderPrice();
				} else if (addUrl !== undefined) {
					attachUrl(button);
				} else if (removeSource !== undefined) {
					const index = Number(removeSource);
					pending.delete(index);
					setSource(button.closest("[data-source-slot]"), index, undefined);
					focus(`studio-source-file-${index}`);
				} else if (preview !== undefined) {
					draft.preview = draft.sources[Number(preview)]?.id;
					renderStage();
					stage.focus({ preventScroll: true });
					stage.scrollIntoView({ block: "nearest" });
				} else if (action === "example") {
					clearError();
					prompt.value = examples[kind][operation.id][1];
					draft.prompt = prompt.value;
					prompt.focus();
				} else if (action) {
					studio.go(action);
				}
				renderWire();
			},
			listen,
		);
		form.addEventListener(
			"keydown",
			(event) => {
				const tab = reviewTabs.indexOf(event.target);
				if (tab >= 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
					const last = reviewTabs.length - 1;
					let next;
					switch (event.key) {
						case "ArrowLeft":
							next = tab === 0 ? last : tab - 1;
							break;
						case "ArrowRight":
							next = tab === last ? 0 : tab + 1;
							break;
						case "Home":
							next = 0;
							break;
						case "End":
							next = last;
							break;
						default:
							return;
					}
					event.preventDefault();
					selectReviewTab(reviewTabs[next]);
					return;
				}
				if (event.key === "Enter" && event.target.matches("[data-source-url]")) {
					event.preventDefault();
					if (!event.repeat)
						attachUrl(event.target.closest("[data-source-slot]").querySelector("[data-add-url]"));
					return;
				}
				if (!event.repeat) return;
				const onSubmit = event.target === submit;
				const implicitSubmit =
					event.key === "Enter" && event.target.matches('input[type="number"]');
				if (implicitSubmit || (onSubmit && (event.key === "Enter" || event.key === " "))) {
					event.preventDefault();
				}
			},
			listen,
		);
		if (!isImage) wire.addEventListener("toggle", renderWire, listen);
		stage.addEventListener(
			"error",
			({ target }) => {
				if (!target.matches("img, video")) return;
				target.remove();
				stage.querySelector("[data-preview-error]").hidden = false;
			},
			{ ...listen, capture: true },
		);

		form.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				if (!draft.provider || !studio.settings().keys?.[draft.provider]) {
					report("Connect an API provider before queuing a request.", true);
					return;
				}
				if (!filterFields.has(model.provider)) {
					report("Request simulation is unavailable for this API provider.", true);
					return;
				}
				if (pending.size) {
					report("Wait for the selected file to finish preparing.", true);
					return;
				}
				const source = operation.source;
				const missingRole =
					source?.roles?.findIndex((_, index) => index < source.min && !draft.sources[index]) ?? -1;
				if (selectedSources().length < (source?.min ?? 0) || missingRole >= 0) {
					const index = Math.max(missingRole, 0);
					report(`Choose ${sourceLabel(index).toLowerCase()} before queuing this request.`, true);
					form.querySelector(`#studio-source-file-${index}`)?.focus();
					return;
				}
				const text = prompt.value.trim();
				const { promptMin = 0, promptMax = Infinity } = model;
				let promptError;
				if (!text) promptError = "Enter a prompt before queuing your request.";
				else if (text.length < promptMin) {
					promptError = `Use at least ${promptMin.toLocaleString("en-US")} characters for this model.`;
				} else if (text.length > promptMax) {
					promptError = `Use at most ${promptMax.toLocaleString("en-US")} characters for this model.`;
				}
				if (promptError) {
					report(promptError, true);
					prompt.focus();
					return;
				}
				const [fixture, samplePrompt] = examples[kind][operation.id];
				const sample = text === samplePrompt ? fixture : null;
				const title = sample?.title ?? text.match(/^.{1,65}/su)?.[0] ?? text;
				try {
					const options = providerOptions(model, operation, values, kind);
					if (renderPrice({ options })) {
						if (isImage) {
							const reviewTab = reviewTabs[0];
							selectReviewTab(reviewTab);
							reviewTab.scrollIntoView({ block: "nearest" });
						} else {
							focus("studio-review-title");
							summary.scrollIntoView({ block: "nearest" });
						}
						report(
							"The price estimate changed. Review the updated price before queuing again.",
							true,
						);
						return;
					}
					const ids = studio.submit({
						provider: model.provider,
						model: model.id,
						kind,
						operation: operation.id,
						prompt: text,
						sourceIds: selectedSources().map(({ id }) => id),
						options,
						count: draft.count,
						outcome: draft.outcome,
						title,
						...(sample && { fixtureId: sample.id }),
					});
					if (ids.length)
						report(
							`Queued ${ids.length} ${ids.length === 1 ? "request" : "requests"}. Follow progress in Jobs.`,
						);
				} catch (error) {
					report(error instanceof Error ? error.message : "The request could not be queued.", true);
				}
			},
			listen,
		);

		renderSelection();
		const unsubscribe = studio.subscribe((topic, settings) => {
			if (topic !== "settings") return;
			const focused = document.activeElement;
			const wasInForm = form.contains(focused);
			const previousModels = connectedModels;
			const routeChanged = loadSelection(settings.keys);
			if (
				previousModels.length !== connectedModels.length ||
				previousModels.some((entry, index) => entry !== connectedModels[index])
			) {
				renderSelection(routeChanged);
			} else {
				renderSummary();
			}
			if (wasInForm && document.activeElement !== focused) {
				restoreFocus(focused);
			}
		});
		return () => {
			unsubscribe();
			controller.abort();
			pending.clear();
			root.querySelector(".studio-workspace")?.remove();
		};
	}

	window.StudioViews ??= {};
	window.StudioViews.studios = studios;
})();
