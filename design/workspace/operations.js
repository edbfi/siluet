(() => {
	window.StudioViews ??= {};
	const views = window.StudioViews;
	const providers = [
		{ id: "poyo", name: "Poyo.ai", mark: "P", key: "demo_poyo_••••7F29" },
		{ id: "toapis", name: "ToAPIs", mark: "T", key: "demo_toapis_••••4C81" },
	];
	const statuses = {
		queued: "Queued locally",
		running: "Active at provider",
		completed: "Completed",
		failed: "Failed",
		uncertain: "Acceptance unknown",
		"download-failed": "Download failed",
		cancelled: "Cancelled",
	};
	const escaped = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const html = (value) =>
		String(value ?? "").replace(/[&<>"']/g, (character) => escaped[character]);
	const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
	const formatTime = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "medium",
	});

	function date(value) {
		const parsed = value === null || value === undefined ? null : new Date(value);
		return parsed && Number.isFinite(parsed.getTime()) ? formatTime.format(parsed) : "";
	}

	function providerName(id) {
		return providers.find((provider) => provider.id === id)?.name ?? id;
	}

	function jobSubtitle(job) {
		const catalogEntry = window.SiluetModels?.[job.kind]?.find(
			(model) => model.provider === job.provider && model.id === job.model,
		);
		return [providerName(job.provider), catalogEntry?.name ?? job.model]
			.filter(Boolean)
			.join(" / ");
	}

	function action(name, label, options = {}) {
		const { primary = false, id } = options;
		return `<button type="button" class="studio-ops__button${primary ? " studio-ops__button--primary" : ""}" data-action="${name}" ${id ? `data-id="${html(id)}"` : ""}>${html(label)}</button>`;
	}

	function statusBadge(status) {
		return `<span class="studio-ops__status" data-status="${html(status)}">${html(statuses[status] ?? status)}</span>`;
	}

	function bindTabs(tablist, fragmentFor) {
		const tabs = [...tablist.querySelectorAll('[role="tab"]')];
		const sections = tabs.map((tab) =>
			tablist.parentElement.querySelector(`#${tab.getAttribute("aria-controls")}`),
		);
		let activeIndex = -1;

		function select(id) {
			const index = tabs.findIndex((tab) => tab.dataset.tab === id);
			if (index < 0 || index === activeIndex) return;
			const focused = document.activeElement;
			const restoreFocus =
				tabs[activeIndex] === focused || sections[activeIndex]?.contains(focused);
			activeIndex = index;
			for (const [position, tab] of tabs.entries()) {
				const selected = position === activeIndex;
				tab.setAttribute("aria-selected", String(selected));
				tab.tabIndex = selected ? 0 : -1;
				sections[position].hidden = !selected;
			}
			if (restoreFocus) tabs[activeIndex].focus();
		}

		tablist.addEventListener("click", ({ target }) => {
			const index = tabs.indexOf(target.closest('[role="tab"]'));
			if (index === -1 || index === activeIndex) return;
			const id = tabs[index].dataset.tab;
			select(id);
			window.location.hash = fragmentFor(id);
		});

		tablist.addEventListener("keydown", (event) => {
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			const index = tabs.indexOf(event.target);
			if (index === -1) return;
			let next;
			switch (event.key) {
				case "ArrowLeft":
					next = (index + tabs.length - 1) % tabs.length;
					break;
				case "ArrowRight":
					next = (index + 1) % tabs.length;
					break;
				case "Home":
					next = 0;
					break;
				case "End":
					next = tabs.length - 1;
					break;
				default:
					return;
			}
			event.preventDefault();
			if (next === activeIndex) return;
			const id = tabs[next].dataset.tab;
			select(id);
			const url = new URL(window.location.href);
			url.hash = fragmentFor(id);
			window.history.replaceState(window.history.state, "", url.href);
		});

		return { select };
	}

	function mountSettings(panel) {
		const studio = window.Studio;
		const categories = {
			providers: "Providers",
			generation: "Generation",
			privacy: "Privacy",
			appearance: "Appearance",
		};
		panel.innerHTML = `
			<header class="studio-ops__heading">
				<h1>Settings</h1>
			</header>
			<div class="studio-ops__settings">
				<div class="studio-ops__settings-tabs" role="tablist" aria-label="Settings categories">
					${Object.entries(categories)
						.map(
							([id, label]) => `
						<button type="button" class="studio-ops__settings-tab" id="ops-tab-${id}" role="tab"
							data-tab="${id}" aria-controls="ops-panel-${id}" aria-selected="false" tabindex="-1">${label}</button>`,
						)
						.join("")}
				</div>
				<section class="studio-ops__group studio-ops__group--providers" id="ops-panel-providers" role="tabpanel" aria-labelledby="ops-tab-providers" tabindex="0" hidden>
					<header class="studio-ops__group-head">
						<h2>Provider connections</h2>
						${action("setup", "Replay setup")}
						<p>Use either provider or both. The studio uses fictional keys for these connections.</p>
					</header>
					<div class="studio-ops__provider-tabs" role="tablist" aria-label="Provider connections">
						${providers
							.map(
								({ id, name, mark }) => `
							<button type="button" class="studio-ops__provider-tab" id="ops-provider-tab-${id}" role="tab"
								data-tab="${id}" aria-controls="ops-provider-panel-${id}" aria-selected="false" tabindex="-1">
								<span class="studio-ops__provider-mark" aria-hidden="true">${mark}</span>${name}
							</button>`,
							)
							.join("")}
					</div>
					${providers
						.map(
							({ id }) => `
						<section class="studio-ops__provider" id="ops-provider-panel-${id}" role="tabpanel"
							data-provider="${id}" aria-labelledby="ops-provider-tab-${id}" tabindex="0" hidden>
							<div class="studio-ops__provider-head">
								<h3>Connection status</h3>
								<span class="studio-ops__status" data-connection></span>
							</div>
							<div class="studio-ops__setting-row">
								<div><strong>Model key</strong><p data-key></p><small data-remove-effect hidden>Removing this key stops queued requests and future automatic retries for this provider.</small></div>
								${action("key", "Set demo key", { id })}
							</div>
							<div class="studio-ops__setting-row">
								<div><strong>Demo balance</strong><p data-balance></p><small data-balance-date></small></div>
							</div>
							${
								id === "toapis"
									? `
								<label class="studio-ops__setting-row studio-ops__control-row">
									<span><strong id="ops-wallet-label">Show ToAPIs balance</strong><small id="ops-wallet-help">A real account balance requires a separate system access token. The model key is enough to run generation jobs.</small></span>
									<input type="checkbox" role="switch" class="studio-ops__switch" data-wallet aria-labelledby="ops-wallet-label" aria-describedby="ops-wallet-help">
								</label>`
									: ""
							}
						</section>`,
						)
						.join("")}
				</section>
				<section class="studio-ops__group" id="ops-panel-generation" role="tabpanel" aria-labelledby="ops-tab-generation" tabindex="0" hidden>
					<header class="studio-ops__group-head">
						<h2>Job retries</h2>
						<p>Opt in to additional attempts after a confirmed temporary provider error. Each attempt may use more credits, even when it fails.</p>
					</header>
					<label class="studio-ops__setting-row studio-ops__control-row">
						<span><strong id="ops-retry-label">Automatic retries</strong><small id="ops-retry-help">Each job keeps the limit in effect at submission. Turning retries off stops pending and future automatic retries.</small></span>
						<input type="checkbox" role="switch" class="studio-ops__switch" data-retry aria-labelledby="ops-retry-label" aria-describedby="ops-retry-help">
					</label>
					<label class="studio-ops__setting-row studio-ops__control-row">
						<span><strong id="ops-limit-label">Additional attempts per job</strong><small id="ops-limit-help">The default is three additional attempts.</small></span>
						<select class="studio-ops__select" data-limit aria-labelledby="ops-limit-label" aria-describedby="ops-limit-help">${[0, 1, 2, 3].map((count) => `<option value="${count}">${count}</option>`).join("")}</select>
					</label>
					<p class="studio-ops__section-note">Content rejections and submissions with unknown acceptance stay in Jobs for review.</p>
				</section>
				<section class="studio-ops__group" id="ops-panel-privacy" role="tabpanel" aria-labelledby="ops-tab-privacy" tabindex="0" hidden>
					<header class="studio-ops__group-head">
						<h2>Network privacy</h2>
						<p>Siluet sends no telemetry. Gallery and job history stay local.</p>
					</header>
					<div class="studio-ops__setting-row">
						<div><strong>Outgoing IP</strong><p role="status" data-ip-status>Not checked</p></div>
						${action("ip", "Check outgoing IP (demo)")}
					</div>
					<dl class="studio-ops__metadata studio-ops__ip-data" data-ip-result hidden>
						<div><dt>Family</dt><dd>IPv4</dd></div>
						<div><dt>Source</dt><dd>Local demo diagnostic fixture</dd></div>
						<div><dt>Last check</dt><dd><time data-ip-time></time></dd></div>
					</dl>
					<p class="studio-ops__section-note">The demo runs locally with no network request. A real check would contact an external observer from the local Siluet server, such as <code>api64.ipify.org</code>. A provider may see a different IP if its requests take a different route.</p>
				</section>
				<section class="studio-ops__group" id="ops-panel-appearance" role="tabpanel" aria-labelledby="ops-tab-appearance" tabindex="0" hidden>
					<header class="studio-ops__group-head">
						<h2 id="ops-theme-title">Theme</h2>
						<p id="ops-theme-help">System follows your device’s appearance.</p>
					</header>
					<div class="studio-ops__theme-options" role="radiogroup" aria-labelledby="ops-theme-title" aria-describedby="ops-theme-help">
						${["System", "Light", "Dark"]
							.map(
								(label) => `
							<label>
								<span class="studio-ops__theme-swatch" data-theme-swatch="${label.toLowerCase()}" aria-hidden="true"></span>
								<span class="studio-ops__theme-choice">
									<input type="radio" name="studio-theme" value="${label.toLowerCase()}">
									${label}
								</span>
							</label>`,
							)
							.join("")}
					</div>
				</section>
			</div>`;

		const themeOptions = [...panel.querySelectorAll('input[name="studio-theme"]')];
		const providerRows = [...panel.querySelectorAll("[data-provider]")];
		const wallet = panel.querySelector("[data-wallet]");
		const retry = panel.querySelector("[data-retry]");
		const limit = panel.querySelector("[data-limit]");
		const ipResult = panel.querySelector("[data-ip-result]");
		const ipStatus = panel.querySelector("[data-ip-status]");
		const ipTime = panel.querySelector("[data-ip-time]");
		const keys = studio.settings().keys;
		const defaultProvider = providers.find(({ id }) => keys[id])?.id ?? providers[0].id;
		let selectedProvider = defaultProvider;
		const categoryTabs = bindTabs(panel.querySelector(".studio-ops__settings-tabs"), (id) =>
			id === "providers" ? `settings/providers/${selectedProvider}` : `settings/${id}`,
		);
		const providerTabs = bindTabs(panel.querySelector(".studio-ops__provider-tabs"), (id) => {
			selectedProvider = id;
			return `settings/providers/${id}`;
		});

		function selectFromHash() {
			const [, category, providerId] = window.location.hash.split("/");
			const name = Object.hasOwn(categories, category) ? category : "providers";
			categoryTabs.select(name);
			if (name === "providers") {
				selectedProvider = providers.some(({ id }) => id === providerId)
					? providerId
					: defaultProvider;
				providerTabs.select(selectedProvider);
			}
		}

		function updateTheme() {
			const preference = window.StudioTheme?.get() ?? "system";
			for (const option of themeOptions) option.checked = option.value === preference;
		}

		function update() {
			const settings = studio.settings();
			for (const [index, row] of providerRows.entries()) {
				const { id, name, key } = providers[index];
				const connected = Boolean(settings.keys[id]);
				const flag = row.querySelector("[data-connection]");
				flag.textContent = connected ? "Connected" : "Missing";
				flag.dataset.status = connected ? "completed" : "idle";
				row.querySelector("[data-key]").textContent = connected ? key : "No demo key configured";
				const keyButton = row.querySelector('[data-action="key"]');
				row.querySelector("[data-remove-effect]").hidden = !connected;
				keyButton.textContent = connected ? "Remove demo key" : "Set demo key";
				keyButton.setAttribute("aria-label", `${keyButton.textContent} for ${name}`);

				const balance = studio.balance(id);
				const hasBalance = Number.isFinite(balance?.value);
				const amount = row.querySelector("[data-balance]");
				const timestamp = row.querySelector("[data-balance-date]");
				amount.textContent = hasBalance
					? `${formatNumber.format(balance.value)} ${balance.unit}`
					: connected
						? "Balance access is off"
						: "Connect a demo key to see a balance";
				timestamp.textContent =
					hasBalance && date(balance.asOf) ? `Sample as of ${date(balance.asOf)}` : "";
			}
			wallet.checked = Boolean(settings.wallet.toapis);
			retry.checked = Boolean(settings.retryEnabled);
			limit.options[0].disabled = retry.checked;
			limit.value = String(Math.max(retry.checked ? 1 : 0, Math.min(3, settings.retryLimit)));
		}

		panel.addEventListener("click", ({ target }) => {
			const button = target.closest("button[data-action]");
			if (!button) return;
			switch (button.dataset.action) {
				case "setup":
					views.onboarding?.(true);
					break;
				case "key": {
					const id = button.dataset.id;
					studio.configure({ keys: { [id]: !studio.settings().keys[id] } });
					break;
				}
				case "ip": {
					const checkedAt = new Date();
					ipStatus.textContent = "203.0.113.42 (simulated)";
					ipTime.dateTime = checkedAt.toISOString();
					ipTime.textContent = date(checkedAt);
					ipResult.hidden = false;
					break;
				}
			}
		});

		panel.addEventListener("change", ({ target }) => {
			if (target === wallet) studio.configure({ wallet: { toapis: wallet.checked } });
			if (target === retry) {
				studio.configure({
					retryEnabled: retry.checked,
					retryLimit: retry.checked && limit.value === "0" ? 3 : Number(limit.value),
				});
			}
			if (target === limit) studio.configure({ retryLimit: Number(limit.value) });
			if (themeOptions.includes(target)) window.StudioTheme?.set(target.value);
		});

		providerTabs.select(defaultProvider);
		selectFromHash();
		update();
		updateTheme();
		window.addEventListener("hashchange", selectFromHash);
		window.addEventListener("siluet-theme-change", updateTheme);
		const unsubscribe = studio.subscribe((topic) => {
			if (topic === "settings" || topic === "wallet") update();
		});
		return () => {
			unsubscribe();
			window.removeEventListener("hashchange", selectFromHash);
			window.removeEventListener("siluet-theme-change", updateTheme);
		};
	}

	function jobReason(job) {
		return typeof job.reason === "string" ? job.reason : (job.reason?.message ?? "");
	}

	function jobOutcome(job) {
		switch (job.status) {
			case "queued":
				return ["Waiting to submit", "Siluet is holding this request locally."];
			case "running":
				return ["In progress", "The provider is processing this request."];
			case "completed":
				return ["Result saved", "The provider completed the request and Siluet saved the output."];
			case "uncertain":
				return [
					"Acceptance unknown",
					"The provider may have accepted the request and charged for it.",
				];
			case "download-failed":
				return [
					"Result needs saving",
					"The provider completed the job. You can retry the local download of the same result.",
				];
			case "cancelled":
				return ["Cancelled locally", "The queued request was stopped before it was sent."];
			case "failed": {
				const reason = jobReason(job);
				if (reason === "The demo provider rejected the content.") {
					return [
						"Content rejection",
						"The provider rejected these inputs. Review them in the studio before starting another generation.",
					];
				}
				if (reason === "The demo provider confirmed a temporary technical failure.") {
					return ["Temporary technical failure", "The provider reported a temporary failure."];
				}
				if (
					reason === "A source is no longer available in this session. Add it to a new request." ||
					reason === "The demo provider was disconnected before the request started."
				) {
					return ["Stopped before submission", "Siluet could not send the request."];
				}
				return ["Confirmed provider failure", "The provider reported that the attempt failed."];
			}
			default:
				return ["Job status", ""];
		}
	}

	function metadata(label, value) {
		return `<div><dt>${html(label)}</dt><dd>${html(value)}</dd></div>`;
	}

	function rootId(job) {
		return job.rootId ?? job.parentId ?? job.id;
	}

	function collectBatches(jobs) {
		const batches = new Map();
		for (const job of jobs) {
			if (!job.batchId || rootId(job) !== job.id) continue;
			if (!batches.has(job.batchId)) batches.set(job.batchId, []);
			batches.get(job.batchId).push(job);
		}
		for (const members of batches.values()) {
			members.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		}
		return batches;
	}

	function batchPosition(job, members) {
		const index = members.findIndex((member) => member.id === rootId(job));
		return index >= 0 && members.length > 1 ? `${index + 1}/${members.length}` : "";
	}

	function batchLabel(job, members) {
		const position = batchPosition(job, members);
		return position ? `Batch ${job.batchId.slice(0, 8)}, ${position}` : "";
	}

	function attemptLabel(job) {
		return `Attempt ${job.attempt ?? 1}`;
	}

	function linkGroup(title, jobs, label) {
		if (!jobs.length) return "";
		return `<section class="studio-ops__detail-section">
			<h3>${title}</h3>
			<ul class="studio-ops__references">
				${jobs.map((job) => `<li>${action("job", label(job), { id: job.id })}${statusBadge(job.status)}</li>`).join("")}
			</ul>
		</section>`;
	}

	function estimateLabel(estimate) {
		if (estimate?.status === "known") {
			if (estimate.unit === "toapis_credit") {
				return window.SiluetPricing.toapisImageAmount(estimate.perRequest, estimate.usd.perRequest);
			}
			return `${estimate.perRequest} Poyo.ai credits estimated`;
		}
		return estimate ? "Estimate unavailable" : "No estimate recorded";
	}

	function rateSourceLabel(estimate) {
		if (estimate?.unit === "poyo_credit") {
			return `Rates dated ${estimate.sourceDate.slice(0, 10)} · ${estimate.revision.slice(0, 12)}`;
		}
		const observed =
			estimate?.unit === "toapis_credit"
				? estimate.sourceDate
				: estimate?.advertisedUnitRate?.sourceDate;
		return observed ? `Public rates observed ${observed.slice(0, 10)}` : "";
	}

	function estimateDetails(estimate) {
		const unitRate = estimate?.advertisedUnitRate;
		return [
			estimateLabel(estimate),
			unitRate && window.SiluetPricing.toapisTokenRate(unitRate),
			rateSourceLabel(estimate),
		]
			.filter(Boolean)
			.join(" · ");
	}

	function renderJob(job, jobs, assets, batch, retryEstimate, message) {
		const [outcome, note] = jobOutcome(job);
		const reason = jobReason(job);
		const attempts = jobs
			.filter((other) => other.id !== job.id && rootId(job) === rootId(other))
			.sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
		const batchName = batchLabel(job, batch);
		const siblings = batch.filter((other) => other.id !== rootId(job));
		const child = attempts.find(({ parentId }) => parentId === job.id);
		const retryPending = Boolean(job.retryPending);
		const canResubmit =
			["failed", "uncertain"].includes(job.status) &&
			outcome !== "Content rejection" &&
			!job.sourceUnavailable &&
			!child &&
			!retryPending;
		const canStop = typeof window.Studio.stopQueued === "function";
		const canStopRetries =
			!job.autoRetriesRevoked &&
			(retryPending || (job.status === "running" && job.retryLimit >= (job.attempt ?? 1)));
		const sources = (job.sources ?? [])
			.map(
				(source) =>
					`<li><span>${html(source.title)}${source.available ? "" : " (unavailable)"}</span></li>`,
			)
			.join("");
		const modelInputs = Object.entries(job.options ?? {})
			.map(([key, value]) =>
				metadata(
					key,
					value !== null && typeof value === "object" ? JSON.stringify(value) : (value ?? "—"),
				),
			)
			.join("");
		const summary =
			job.status === "completed" && job.assetId && !assets.has(job.assetId)
				? "The provider completed the job. The saved output is unavailable in this session."
				: note;
		const confirming = retryEstimate !== undefined;

		return `
			<header class="studio-ops__detail-head">
				${action("list", "Back to job list")}
				<div>${statusBadge(job.status)}<span>${attemptLabel(job)}</span></div>
				<h2 id="ops-job-title" tabindex="-1">${html(job.title)}</h2>
				<p>${html(jobSubtitle(job))}</p>
				${batchName ? `<p class="studio-ops__batch-label">${html(batchName)}</p>` : ""}
			</header>
			<section class="studio-ops__outcome" data-status="${html(job.status)}" aria-label="Job outcome">
				<h3>${html(outcome)}</h3>
				<p>${html(summary)}</p>
				${reason ? `<p>${html(reason)}</p>` : ""}
				${date(job.nextEligibleAt) ? `<p>Next eligible at ${html(date(job.nextEligibleAt))}</p>` : ""}
				${retryPending ? "<p>An automatic retry is scheduled.</p>" : ""}
				${canStopRetries && job.status === "running" ? "<p>This attempt will continue at the provider if you stop retries.</p>" : ""}
				${job.autoRetriesRevoked ? "<p>Automatic retries are stopped for this job.</p>" : ""}
				${job.status === "completed" && assets.has(job.assetId) ? action("asset", "Open saved output", { id: job.assetId, primary: true }) : ""}
				${job.status === "download-failed" ? action("download", "Retry local download", { primary: true }) : ""}
				${canStop && job.status === "queued" ? action("stop", "Stop queued work") : ""}
				${canStop && canStopRetries ? action("stop", "Stop retries") : ""}
				${job.status === "failed" && outcome === "Content rejection" ? action("studio", `Open ${job.kind === "video" ? "Video Studio" : "Image Studio"}`, { id: job.kind }) : ""}
				${canResubmit && !confirming ? action("review", "Review new submission") : ""}
				${
					canResubmit && confirming
						? `
					<div class="studio-ops__approval">
						<h4 tabindex="-1" data-approval>Authorize a new attempt</h4>
						<p>${job.status === "uncertain" ? "The original request may already have used credits. A new request can charge you again." : "The provider may charge for the new request, even if it fails."} The demo uses the same prompt, sources and model options.</p>
						<p>${html(retryEstimate ? estimateDetails(retryEstimate) : "Estimate unavailable")}</p>
						<div>${action("dismiss", "Cancel")}${action("retry", "Approve new submission", { primary: true })}</div>
					</div>`
						: ""
				}
				${message ? `<p role="status" class="studio-ops__action-message">${html(message)}</p>` : ""}
			</section>
			<section class="studio-ops__detail-section" aria-label="Billing">
				<h3>Billing</h3>
				<dl class="studio-ops__metadata">
					${metadata("Estimate at submission", estimateLabel(job.estimate))}
					${job.estimate?.advertisedUnitRate ? metadata("Advertised unit rate", window.SiluetPricing.toapisTokenRate(job.estimate.advertisedUnitRate)) : ""}
					${rateSourceLabel(job.estimate) ? metadata("Rate source", rateSourceLabel(job.estimate)) : ""}
					${metadata("Settled charge", "Unknown")}
				</dl>
			</section>
			<section class="studio-ops__detail-section">
				<h3>Request details</h3>
				<dl class="studio-ops__metadata">
					${metadata("Job ID", job.id)}
					${metadata("Created", date(job.createdAt) || "—")}
					${metadata("Operation", [job.kind, job.operation].filter(Boolean).join(" / "))}
					${metadata("Retries authorized", job.retryLimit ?? 0)}
					${job.batchId ? metadata("Batch ID", job.batchId) : ""}
				</dl>
				${
					job.prompt || modelInputs
						? `<details class="studio-ops__inputs"><summary>Prompt and model options</summary>
					${job.prompt ? `<p>${html(job.prompt)}</p>` : ""}
					${modelInputs ? `<dl class="studio-ops__metadata">${modelInputs}</dl>` : ""}
				</details>`
						: ""
				}
			</section>
			${
				sources
					? `<section class="studio-ops__detail-section">
				<h3>Source media</h3>
				${job.sourceUnavailable ? "<p>Select the source again in the studio to make a new request.</p>" : ""}
				<ul class="studio-ops__references">${sources}</ul>
			</section>`
					: ""
			}
			${linkGroup("Linked attempts", attempts, attemptLabel)}
			${linkGroup("Other jobs in this batch", siblings, (item) => `${item.title} (${batchPosition(item, batch)})`)}
		`;
	}

	function mountJobs(panel) {
		const studio = window.Studio;
		panel.innerHTML = `
			<header class="studio-ops__heading">
				<h1>Jobs</h1>
				<p>Follow each attempt from the local queue to the gallery.</p>
			</header>
			<div class="studio-ops__jobs">
				<section class="studio-ops__queue" aria-labelledby="ops-queue-title">
					<header class="studio-ops__queue-head">
						<h2 id="ops-queue-title">All attempts</h2>
						<label><span class="studio-ops__sr">Filter by status</span><select class="studio-ops__select" data-filter>
							<option value="">All statuses</option>
							${Object.entries(statuses)
								.map(([value, label]) => `<option value="${value}">${label}</option>`)
								.join("")}
						</select></label>
					</header>
					<ul class="studio-ops__job-list" aria-label="Job attempts"></ul>
					<p class="studio-ops__empty" data-empty hidden></p>
				</section>
				<section class="studio-ops__detail"></section>
			</div>
			<p class="studio-ops__sr" data-announcement role="status"></p>`;

		const filter = panel.querySelector("[data-filter]");
		const list = panel.querySelector(".studio-ops__job-list");
		const detail = panel.querySelector(".studio-ops__detail");
		const empty = panel.querySelector("[data-empty]");
		const announcement = panel.querySelector("[data-announcement]");
		const rows = new Map();
		let selectedId;
		let retryEstimate;
		let message = "";
		let lastDetail = "";
		let lastStatus;
		let previousSelection;

		function update() {
			const jobs = studio.jobs();
			const batches = collectBatches(jobs);
			const visible = filter.value ? jobs.filter((job) => job.status === filter.value) : jobs;
			const selected = jobs.find(({ id }) => id === selectedId) ?? visible[0];
			const selectedChanged = previousSelection !== selected?.id;
			selectedId = selected?.id;
			const focused = document.activeElement;
			const assets = new Map(studio.assets().map((asset) => [asset.id, asset]));
			const visibleIds = new Set(visible.map(({ id }) => id));
			for (const [id, row] of rows) {
				if (visibleIds.has(id)) continue;
				if (row.contains(focused)) filter.focus({ preventScroll: true });
				row.remove();
				rows.delete(id);
			}
			for (const [index, job] of visible.entries()) {
				let row = rows.get(job.id);
				if (!row) {
					row = document.createElement("li");
					const button = document.createElement("button");
					button.type = "button";
					button.dataset.action = "row";
					button.dataset.id = job.id;
					button.innerHTML = `<span class="studio-ops__job-name">
						<strong></strong><small></small><small class="studio-ops__batch-label" data-batch hidden></small>
					</span><span class="studio-ops__status"></span>`;
					row.append(button);
					rows.set(job.id, row);
				}
				const button = row.firstElementChild;
				const [title, subtitle, batchLine] = button.firstElementChild.children;
				const batchName = batchLabel(job, batches.get(job.batchId) ?? []);
				title.textContent = job.title;
				subtitle.textContent = jobSubtitle(job);
				batchLine.hidden = !batchName;
				batchLine.textContent =
					batchName && job.attempt > 1 ? `${batchName}, ${attemptLabel(job)}` : batchName;
				button.lastElementChild.textContent = statuses[job.status] ?? job.status;
				button.lastElementChild.dataset.status = job.status;
				if (job.id === selectedId) button.setAttribute("aria-current", "true");
				else button.removeAttribute("aria-current");
				const current = list.children[index];
				if (row !== current) {
					list.insertBefore(row, current ?? null);
					if (row.contains(focused)) focused.focus({ preventScroll: true });
				}
			}
			empty.hidden = visible.length > 0;
			empty.textContent = jobs.length
				? "No jobs match this status."
				: "Jobs will appear here after your first submission.";
			const selectedBatch = batches.get(selected?.batchId) ?? [];
			const nextDetail = selected
				? renderJob(selected, jobs, assets, selectedBatch, retryEstimate, message)
				: `
				<header class="studio-ops__detail-head"><h2 id="ops-job-title" tabindex="-1">Inspect a job</h2>
				<p>Choose a job to see its inputs, outcome and related attempts.</p></header>`;
			if (lastDetail !== nextDetail) {
				const hadFocus = detail.contains(focused);
				const openInputs = !selectedChanged && detail.querySelector("details")?.open;
				detail.innerHTML = nextDetail;
				detail.setAttribute("aria-labelledby", "ops-job-title");
				lastDetail = nextDetail;
				if (openInputs && detail.querySelector("details"))
					detail.querySelector("details").open = true;
				if (hadFocus) {
					const target = focused.matches("summary")
						? detail.querySelector("summary")
						: [...detail.querySelectorAll("button")].find(
								(button) =>
									button.dataset.action === focused.dataset.action &&
									button.dataset.id === focused.dataset.id,
							);
					(target ?? detail.querySelector("h2")).focus({ preventScroll: true });
				}
			}
			if (selected && !selectedChanged && lastStatus !== selected.status) {
				announcement.textContent = [
					selected.title,
					batchLabel(selected, selectedBatch),
					statuses[selected.status],
				]
					.filter(Boolean)
					.join(". ");
			}
			lastStatus = selected?.status;
			previousSelection = selectedId;
		}

		function select(id, focus = false) {
			selectedId = id;
			retryEstimate = undefined;
			message = "";
			update();
			if (focus) detail.querySelector("h2").focus();
		}

		filter.addEventListener("change", () => select(undefined));

		panel.addEventListener("click", ({ target }) => {
			const button = target.closest("button[data-action]");
			if (!button) return;
			const { action: name, id } = button.dataset;
			const job = studio.jobs().find((entry) => entry.id === selectedId);
			try {
				switch (name) {
					case "row": {
						const back = detail.querySelector('[data-action="list"]');
						select(id, back && getComputedStyle(back).display !== "none");
						break;
					}
					case "job":
						select(id, true);
						break;
					case "list":
						(rows.get(selectedId)?.firstElementChild ?? filter).focus();
						break;
					case "asset":
						studio.openAsset(id);
						break;
					case "studio":
						studio.go(id);
						break;
					case "review":
						if (!job) return;
						retryEstimate = studio.retryEstimate(job.id);
						message = "";
						update();
						detail.querySelector("details")?.setAttribute("open", "");
						detail.querySelector("[data-approval]")?.focus();
						break;
					case "dismiss":
						retryEstimate = undefined;
						message = "";
						update();
						detail.querySelector('[data-action="review"]')?.focus();
						break;
					case "retry":
						if (retryEstimate === undefined || !job) return;
						select(studio.retry(job.id, retryEstimate), true);
						break;
					case "download":
						if (!job) return;
						studio.recoverDownload(job.id);
						message =
							studio.jobs().find((entry) => entry.id === job.id)?.status === "completed"
								? "Output saved for this attempt."
								: "The output is still unavailable.";
						update();
						break;
					case "stop":
						if (!job) return;
						studio.stopQueued(job.id);
						update();
						break;
				}
			} catch (error) {
				message = error instanceof Error ? error.message : "The job could not be updated.";
				if (name === "retry" && job) retryEstimate = studio.retryEstimate(job.id);
				update();
			}
		});

		update();
		return studio.subscribe((topic) => {
			if (topic === "jobs" || topic === "assets") update();
		});
	}

	views.operations = (root, route) => {
		const panel = document.createElement("div");
		panel.className = "studio-ops";
		root.replaceChildren(panel);
		const unsubscribe = route === "settings" ? mountSettings(panel) : mountJobs(panel);
		return () => {
			unsubscribe();
			panel.remove();
		};
	};
})();
