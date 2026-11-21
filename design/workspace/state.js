(() => {
	const storageKey = "siluet.workspace.v1";
	const providers = ["poyo", "toapis"];
	const kinds = ["image", "video"];
	const outcomes = [
		"success",
		"transient",
		"content",
		"uncertain",
		"download",
		"failure",
		"rate-limit",
	];
	const statuses = [
		"queued",
		"running",
		"completed",
		"failed",
		"uncertain",
		"download-failed",
		"cancelled",
	];
	const fixtureBalances = {
		poyo: { value: 2480, unit: "credits", asOf: 1795255200000 },
		toapis: { value: 24.8, unit: "USD", asOf: 1795255200000 },
	};
	const activePerProvider = 2;
	const maxRetryLimit = 3;
	const enqueueDelay = 80;
	const retryAfter = 3000;
	const fixtureDuration = { image: 1100, video: 2300 };
	const resultStates = {
		transient: ["failed", "The demo provider confirmed a temporary technical failure."],
		content: ["failed", "The demo provider rejected the content."],
		uncertain: ["uncertain", "The demo acknowledgement was lost. Acceptance is unknown."],
		download: ["download-failed", "The demo provider finished, but saving the result failed."],
		failure: ["failed", "The demo provider confirmed a failure."],
	};
	const missingSourceReason =
		"A source is no longer available in this session. Add it to a new request.";

	const fixtureAssets = (window.SiluetFixtures ?? []).map((fixture) => ({
		...fixture,
		sourceIds: [],
	}));
	const fixtureById = new Map(fixtureAssets.map((asset) => [asset.id, asset]));
	const fixtureByKind = Object.fromEntries(
		kinds.map((kind) => [kind, fixtureAssets.filter((asset) => asset.kind === kind)]),
	);
	const importedAssets = new Map();
	const stagedSources = new Map();
	const listeners = new Set();
	const retryTimers = new Map();
	let pendingAsset = null;
	let pumpTimer = null;

	const saved = readStorage();
	const cooldowns = Object.fromEntries(
		providers.map((provider) => {
			const deadline = saved?.cooldowns?.[provider];
			return [
				provider,
				Number.isFinite(deadline) ? Math.min(deadline, Date.now() + retryAfter) : 0,
			];
		}),
	);
	const preferences = {
		onboarded: false,
		keys: { poyo: false, toapis: false },
		wallet: { poyo: false, toapis: false },
		retryEnabled: false,
		retryLimit: maxRetryLimit,
	};
	assignPreferences(saved?.settings ?? {});
	const hasWalletAccess = (provider) =>
		preferences.keys[provider] && (provider === "poyo" || preferences.wallet[provider]);
	const wallets = window.SiluetWallets?.create(
		saved?.walletObservations,
		fixtureBalances,
		hasWalletAccess,
	);
	const rows = Array.isArray(saved?.jobs) ? saved.jobs.map(restoreJob).filter(Boolean) : seedJobs();
	const byId = new Map(rows.map((job) => [job.id, job]));
	const childByParent = new Map(
		rows.filter((job) => job.parentId).map((job) => [job.parentId, job]),
	);
	let newestDate = rows.reduce((latest, job) => Math.max(latest, job.createdAt), 0);

	function readStorage() {
		try {
			const data = JSON.parse(window.localStorage.getItem(storageKey));
			return data?.version === 1 ? data : null;
		} catch {
			return null;
		}
	}

	function persist() {
		try {
			window.localStorage.setItem(
				storageKey,
				JSON.stringify({
					version: 1,
					settings: preferences,
					jobs: rows,
					cooldowns,
					walletObservations: wallets?.snapshot(),
				}),
			);
		} catch {
			// The current session can still run when browser storage is unavailable.
		}
		if (wallets?.takeBalanceChange()) publish("wallet");
	}

	function walletRunId(job) {
		return job.walletRunId ?? job.batchId;
	}

	function saveJobChanges(changed) {
		const open = new Map();
		for (const job of changed) {
			const id = walletRunId(job);
			if (wallets?.isOpen(job.provider, id)) {
				open.set(`${job.provider}:${id}`, { provider: job.provider, id });
			}
		}
		for (const { id, provider } of open.values()) {
			const members = rows.filter((job) => job.provider === provider && walletRunId(job) === id);
			if (members.some((job) => ["queued", "running"].includes(job.status) || job.retryAt !== null))
				continue;
			wallets.finish(
				provider,
				id,
				Date.now(),
				members.some((job) => job.status === "uncertain"),
			);
		}
		persist();
	}

	function boundedRetryLimit(value, fallback = 0) {
		return Number.isSafeInteger(value) ? Math.max(0, Math.min(value, maxRetryLimit)) : fallback;
	}

	function assignPreferences(changes) {
		for (const name of ["keys", "wallet"]) {
			for (const provider of providers) {
				const value = changes[name]?.[provider];
				if (typeof value === "boolean") preferences[name][provider] = value;
			}
		}
		for (const name of ["onboarded", "retryEnabled"]) {
			if (typeof changes[name] === "boolean") preferences[name] = changes[name];
		}
		preferences.retryLimit = boundedRetryLimit(changes.retryLimit, preferences.retryLimit);
	}

	function publish(topic, detail) {
		for (const listener of [...listeners]) {
			try {
				listener(topic, detail);
			} catch (error) {
				console.error("Siluet studio subscriber failed", error);
			}
		}
	}

	function generatedAsset(job) {
		const fixture = fixtureById.get(job.fixtureId);
		if (!fixture || job.status !== "completed" || !job.assetId || fixtureById.has(job.assetId))
			return null;
		return {
			id: job.assetId,
			title: job.title,
			kind: job.kind,
			mime: fixture.mime,
			src: fixture.src,
			provider: job.provider,
			createdAt: job.createdAt,
			sourceIds: [...job.sourceIds],
		};
	}

	function assets() {
		const results = rows.map(generatedAsset).filter(Boolean);
		return [...fixtureAssets, ...importedAssets.values(), ...results]
			.sort((a, b) => b.createdAt - a.createdAt)
			.map((asset) => ({ ...asset, sourceIds: [...asset.sourceIds] }));
	}

	function hasAsset(id) {
		if (typeof id !== "string") return false;
		if (fixtureById.has(id) || importedAssets.has(id)) return true;
		if (!id.startsWith("output-")) return false;
		const job = byId.get(id.slice("output-".length));
		return job?.status === "completed" && job.assetId === id && fixtureById.has(job.fixtureId);
	}

	function publicJob(job) {
		const {
			fixtureId: _fixtureId,
			retryAt: _retryAt,
			outcome: _outcome,
			throttleSeen: _throttleSeen,
			retryRevoked: _retryRevoked,
			...result
		} = job;
		const cooldown = cooldowns[job.provider];
		if (job.status === "queued" && cooldown > Date.now()) {
			result.nextEligibleAt = cooldown;
			result.reason =
				"The demo provider rate-limited submissions. The queue will resume after Retry-After.";
		}
		result.sources = job.sources.map((source) => ({
			...source,
			title: sourceTitle(source),
			available: stagedSources.has(source.id),
		}));
		result.sourceUnavailable = result.sources.some((source) => !source.available);
		result.autoRetriesRevoked = retriesRevoked(job);
		result.retryPending =
			job.retryAt !== null && !result.autoRetriesRevoked && !childByParent.has(job.id);
		return structuredClone(result);
	}

	function setJobStatus(job, status, reason = null) {
		job.status = status;
		job.reason = reason;
		if (["completed", "download-failed", "cancelled"].includes(status)) releaseJobSources(job);
	}

	function queueJob(input, { batchId, parent = null, retryLimit = 0, fixtureId }) {
		const id = crypto.randomUUID();
		newestDate = Math.max(Date.now(), newestDate + 1);
		const fixtures = fixtureByKind[input.kind];
		const resultFixtureId =
			fixtureId ?? parent?.fixtureId ?? fixtures[rows.length % fixtures.length]?.id;
		const job = {
			...input,
			id,
			batchId,
			rootId: parent?.rootId ?? id,
			parentId: parent?.id ?? null,
			attempt: parent ? parent.attempt + 1 : 1,
			retryLimit,
			status: "queued",
			reason: null,
			assetId: null,
			fixtureId: resultFixtureId ?? null,
			retryAt: null,
			createdAt: newestDate,
		};
		for (const sourceId of job.sourceIds) stagedSources.get(sourceId).jobIds.add(id);
		rows.push(job);
		byId.set(id, job);
		if (parent) childByParent.set(parent.id, job);
		return job;
	}

	function attemptInput(job, outcome, estimate) {
		const { provider, model, kind, operation, prompt, sourceIds, sources, options, title } = job;
		return {
			provider,
			model,
			kind,
			operation,
			prompt,
			sourceIds,
			sources,
			options,
			title,
			outcome,
			estimate,
		};
	}

	function estimateAttempt({ provider, model, operation, options, sourceIds, sources }) {
		const quote = window.SiluetPricing?.quote({
			provider,
			model,
			operation,
			options,
			sourceCount: sourceIds.length,
			sourceKinds: sourceIds.map(
				(id) => sources.find((source) => source.id === id)?.kind ?? "unknown",
			),
			count: 1,
			retryLimit: 0,
		});
		return restoreEstimate(quote, provider, model);
	}

	function restoreEstimate(quote, provider, model) {
		if (provider === "toapis") {
			return window.SiluetPricing?.restoreToapisAttempt?.(quote, model) ?? null;
		}
		if (quote?.status === "unknown") return { status: "unknown" };
		if (quote?.status !== "known" || quote.unit !== "poyo_credit") return null;
		const { status, unit, perRequest, sourceDate, revision } = quote;
		if (
			typeof perRequest !== "string" ||
			!/^\d+(\.\d{1,6})?$/.test(perRequest) ||
			typeof sourceDate !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
				sourceDate,
			) ||
			!Number.isFinite(Date.parse(sourceDate)) ||
			new Date(sourceDate.slice(0, 10)).toISOString().slice(0, 10) !== sourceDate.slice(0, 10) ||
			typeof revision !== "string" ||
			!/^[a-f\d]{40}$/.test(revision)
		)
			return null;
		return { status, unit, perRequest, sourceDate, revision };
	}

	function saveResult(job) {
		if (!fixtureById.has(job.fixtureId)) {
			setJobStatus(job, "download-failed", "The demo result fixture is unavailable.");
			return;
		}
		job.assetId = `output-${job.id}`;
		setJobStatus(job, "completed");
	}

	function blockedReason(job) {
		if (hasMissingSource(job)) return missingSourceReason;
		if (!preferences.keys[job.provider])
			return "The demo provider was disconnected before the request started.";
		return null;
	}

	function retriesRevoked(job) {
		return byId.get(job.rootId)?.retryRevoked === true;
	}

	function finishJob(job) {
		if (job.outcome === "success" || job.outcome === "rate-limit") {
			saveResult(job);
		} else {
			setJobStatus(job, ...resultStates[job.outcome]);
			if (job.outcome === "transient" && job.attempt <= job.retryLimit && !retriesRevoked(job)) {
				const backoff = Math.min(800 * 2 ** (job.attempt - 1), 3200);
				job.retryAt = Date.now() + backoff;
				scheduleRetry(job);
			}
		}
		saveJobChanges([job]);
		schedulePump();
		publish("jobs", publicJob(job));
		if (job.assetId) publish("assets");
	}

	function runQueued() {
		pumpTimer = null;
		const now = Date.now();
		const slots = Object.fromEntries(providers.map((provider) => [provider, activePerProvider]));
		for (const job of rows) {
			if (job.status === "running") slots[job.provider]--;
		}
		const changed = new Set();
		for (const job of rows) {
			if (job.status !== "queued" || slots[job.provider] < 1 || cooldowns[job.provider] > now)
				continue;
			const reason = blockedReason(job);
			if (reason) {
				setJobStatus(job, "failed", reason);
			} else if (job.outcome === "rate-limit" && !job.throttleSeen) {
				cooldowns[job.provider] = now + retryAfter;
				scheduleCooldown(job.provider);
				for (const waiting of rows) {
					if (waiting.status !== "queued" || waiting.provider !== job.provider) continue;
					if (waiting.batchId === job.batchId) waiting.throttleSeen = true;
					changed.add(waiting);
				}
			} else {
				wallets?.start(job.provider, walletRunId(job), now);
				setJobStatus(job, "running");
				slots[job.provider]--;
				window.setTimeout(() => finishJob(job), fixtureDuration[job.kind]);
			}
			changed.add(job);
		}
		if (!changed.size) return;
		saveJobChanges(changed);
		for (const job of changed) publish("jobs", publicJob(job));
	}

	function schedulePump() {
		if (pumpTimer === null) pumpTimer = window.setTimeout(runQueued, enqueueDelay);
	}

	function scheduleCooldown(provider) {
		window.setTimeout(() => {
			cooldowns[provider] = 0;
			persist();
			schedulePump();
			for (const job of rows.filter(
				(job) => job.provider === provider && job.status === "queued",
			)) {
				publish("jobs", publicJob(job));
			}
		}, cooldowns[provider] - Date.now());
	}

	function clearRetry(job) {
		const timer = retryTimers.get(job.id);
		if (timer !== undefined) window.clearTimeout(timer);
		retryTimers.delete(job.id);
		job.retryAt = null;
	}

	function queueRetry(parent, outcome, retryLimit, estimate = parent.estimate) {
		clearRetry(parent);
		const child = queueJob(attemptInput(parent, outcome, estimate), {
			parent,
			batchId: parent.batchId,
			retryLimit,
		});
		releaseJobSources(parent);
		return child;
	}

	function scheduleRetry(parent) {
		const timer = window.setTimeout(
			() => {
				if (parent.retryAt === null || retriesRevoked(parent) || childByParent.has(parent.id))
					return;
				const reason = blockedReason(parent);
				if (reason) {
					clearRetry(parent);
					saveJobChanges([parent]);
					publish("jobs", publicJob(parent));
					return;
				}
				const child = queueRetry(parent, parent.outcome, parent.retryLimit);
				persist();
				schedulePump();
				publish("jobs", publicJob(child));
			},
			Math.max(0, parent.retryAt - Date.now()),
		);
		retryTimers.set(parent.id, timer);
	}

	function submit(request) {
		const {
			provider,
			kind,
			model,
			operation,
			prompt,
			sourceIds: requestedSourceIds,
			options,
			count,
			outcome,
			title,
			fixtureId,
		} = request;
		if (!providers.includes(provider) || !kinds.includes(kind) || !outcomes.includes(outcome)) {
			throw new Error("Choose a demo provider, media kind, and outcome.");
		}
		if (
			![model, operation, prompt, title].every((value) => typeof value === "string") ||
			!model ||
			!operation
		) {
			throw new Error("Choose a demo model and operation.");
		}
		if (!Number.isInteger(count) || count < 1 || count > 5) {
			throw new Error("Choose between one and five requests.");
		}
		if (!Array.isArray(requestedSourceIds)) throw new Error("Choose sources added to the studio.");
		const sourceIds = [...requestedSourceIds];
		if (!sourceIds.every((id) => stagedSources.get(id)?.draft)) {
			throw new Error("Choose sources added to the studio.");
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			throw new Error("Model options must be an object.");
		}
		if (fixtureId !== undefined && fixtureById.get(fixtureId)?.kind !== kind) {
			throw new Error("The example result is unavailable for this media type.");
		}
		if (!preferences.keys[provider]) throw new Error("Connect this demo provider in Settings.");
		const input = {
			provider,
			kind,
			model,
			operation,
			prompt,
			title,
			outcome,
			sourceIds,
			sources: sourceIds.map((id) => {
				const { kind, origin } = stagedSources.get(id);
				return { id, kind, origin };
			}),
			options: JSON.parse(JSON.stringify(options)),
		};
		const batchId = crypto.randomUUID();
		const retryLimit = preferences.retryEnabled ? preferences.retryLimit : 0;
		const estimate = estimateAttempt(input);
		const batch = Array.from({ length: count }, () =>
			queueJob({ ...input, estimate }, { batchId, retryLimit, fixtureId }),
		);
		persist();
		schedulePump();
		for (const job of batch) publish("jobs", publicJob(job));
		return batch.map((job) => job.id);
	}

	function retry(id, reviewedEstimate) {
		const parent = byId.get(id);
		if (!parent || !["failed", "uncertain"].includes(parent.status)) {
			throw new Error("Choose a failed or uncertain attempt to resubmit.");
		}
		const existing = childByParent.get(id);
		if (existing) return existing.id;
		const reason = blockedReason(parent);
		if (reason) throw new Error(reason);
		const estimate = estimateAttempt(parent);
		if (
			reviewedEstimate !== undefined &&
			JSON.stringify(reviewedEstimate) !== JSON.stringify(estimate)
		) {
			throw new Error("The price estimate changed. Review it again before approving.");
		}
		const child = queueRetry(parent, "success", 0, estimate);
		child.walletRunId = child.id;
		persist();
		schedulePump();
		publish("jobs", publicJob(child));
		return child.id;
	}

	function recoverDownload(id) {
		const job = byId.get(id);
		if (job?.status === "completed") return id;
		if (job?.status !== "download-failed")
			throw new Error("Choose a result with a failed download.");
		saveResult(job);
		persist();
		publish("jobs", publicJob(job));
		if (job.assetId) publish("assets");
		return id;
	}

	function revokeRetries(job) {
		if (!job.retryLimit || retriesRevoked(job)) return;
		const root = byId.get(job.rootId);
		if (root) root.retryRevoked = true;
	}

	function stopRequests(matches, reason, cancelQueued) {
		const affected = rows.filter(matches);
		for (const job of affected) revokeRetries(job);
		for (const job of affected) {
			if (job.retryAt !== null) clearRetry(job);
			if (job.status === "queued" && (cancelQueued(job) || (job.parentId && job.retryLimit))) {
				setJobStatus(job, "cancelled", reason);
			}
		}
		return affected;
	}

	function stopQueued(id) {
		const target = byId.get(id);
		if (!target) throw new Error("Choose a demo attempt to stop.");
		const affected = stopRequests(
			(job) => job.rootId === target.rootId,
			"Stopped before submission.",
			(job) => job.id === id,
		);
		saveJobChanges(affected);
		for (const job of affected) publish("jobs", publicJob(job));
		return id;
	}

	function configure(changes = {}) {
		const previous = structuredClone(preferences);
		assignPreferences(changes);
		const affected = new Set();
		for (const provider of providers) {
			if (!hasWalletAccess(provider)) wallets?.revoke(provider);
			if (previous.keys[provider] && !preferences.keys[provider]) {
				for (const job of stopRequests(
					(job) => job.provider === provider,
					"The demo provider was disconnected before submission.",
					() => true,
				))
					affected.add(job);
			}
		}
		if (previous.retryEnabled && !preferences.retryEnabled) {
			for (const job of stopRequests(
				(job) => job.retryLimit > 0,
				"Automatic retries were disabled before submission.",
				() => false,
			))
				affected.add(job);
		}
		saveJobChanges(affected);
		publish("settings", structuredClone(preferences));
		for (const job of affected) publish("jobs", publicJob(job));
	}

	function seedJobs() {
		const done = kinds
			.map((kind) => fixtureByKind[kind][0])
			.filter(Boolean)
			.map((asset) => {
				const id = `seed-${asset.kind}`;
				return {
					id,
					rootId: id,
					batchId: id,
					parentId: null,
					attempt: 1,
					retryLimit: 0,
					title: asset.title,
					kind: asset.kind,
					provider: asset.provider,
					model:
						asset.provider === "poyo"
							? asset.kind === "image"
								? "Z-Image"
								: "H3 Max"
							: asset.kind === "image"
								? "Seedream 5.5"
								: "Vidu Q3",
					status: "completed",
					reason: null,
					assetId: asset.id,
					fixtureId: asset.id,
					operation: "generate",
					outcome: "success",
					retryAt: null,
					prompt: "",
					options: {},
					sourceIds: [],
					sources: [],
					createdAt: asset.createdAt,
				};
			});
		const image = done.find((job) => job.kind === "image");
		if (!image) return done;
		const id = "seed-failed";
		return [
			...done,
			{
				...image,
				id,
				rootId: id,
				batchId: id,
				title: "Overcast variation",
				status: "failed",
				reason: resultStates.failure[1],
				assetId: null,
				outcome: "failure",
				createdAt: image.createdAt - 1000,
			},
		];
	}

	function restoreJob(value) {
		if (
			!value ||
			!providers.includes(value.provider) ||
			!kinds.includes(value.kind) ||
			!statuses.includes(value.status) ||
			!outcomes.includes(value.outcome)
		)
			return null;
		const {
			id,
			rootId,
			batchId,
			parentId,
			title,
			provider,
			kind,
			model,
			operation,
			prompt,
			status,
			outcome,
			assetId,
			reason,
			createdAt,
			fixtureId,
			attempt,
			retryLimit: savedRetryLimit,
			retryAt,
			options,
		} = value;
		if (
			![id, rootId, batchId, title, model, operation, prompt].every(
				(part) => typeof part === "string",
			) ||
			!Number.isFinite(createdAt) ||
			!Number.isSafeInteger(attempt) ||
			attempt < 1
		)
			return null;
		const retryLimit = boundedRetryLimit(savedRetryLimit);
		const sourceIds = Array.isArray(value.sourceIds)
			? value.sourceIds.filter((sourceId) => typeof sourceId === "string")
			: [];
		const savedSources = Array.isArray(value.sources) ? value.sources : [];
		const recordedSources = new Map(
			savedSources
				.filter(
					(source) =>
						(source?.origin === "local" || source?.origin === "remote") &&
						kinds.includes(source.kind),
				)
				.map((source) => [source.id, source]),
		);
		const sources = sourceIds.map((id) => {
			const source = recordedSources.get(id);
			return { id, kind: source?.kind ?? null, origin: source?.origin ?? null };
		});
		// Earlier sessions could remove a missing Gallery ID and retain only the flag.
		if (value.sourceUnavailable === true || savedSources.some((source) => source?.id === null)) {
			sources.push({ id: null, kind: null, origin: null });
		}
		return {
			id,
			rootId,
			batchId,
			title,
			provider,
			kind,
			model,
			operation,
			prompt,
			status,
			outcome,
			createdAt,
			attempt,
			parentId: typeof parentId === "string" ? parentId : null,
			walletRunId: parentId && value.walletRunId === id ? id : undefined,
			reason: typeof reason === "string" ? reason : null,
			assetId:
				assetId === `output-${id}` || (id.startsWith("seed-") && assetId === fixtureId)
					? assetId
					: null,
			fixtureId: fixtureById.has(fixtureId) ? fixtureId : null,
			retryLimit,
			retryAt:
				Number.isFinite(retryAt) &&
				status === "failed" &&
				outcome === "transient" &&
				attempt <= retryLimit
					? retryAt
					: null,
			sourceIds,
			sources,
			options: options && typeof options === "object" && !Array.isArray(options) ? options : {},
			estimate: restoreEstimate(value.estimate, provider, model),
			throttleSeen: value.throttleSeen === true,
			retryRevoked: value.retryRevoked === true,
		};
	}

	function restoreProgress() {
		let changed = false;
		for (const job of rows) {
			if (hasMissingSource(job)) {
				if (job.status === "queued") {
					setJobStatus(job, "failed", missingSourceReason);
					changed = true;
				}
				if (job.retryAt !== null) {
					clearRetry(job);
					changed = true;
				}
			}
			if (job.status === "running") {
				setJobStatus(
					job,
					"uncertain",
					"The previous demo session closed before the acknowledgement arrived.",
				);
				changed = true;
			}
			if (job.retryAt !== null && !retriesRevoked(job) && !childByParent.has(job.id))
				scheduleRetry(job);
		}
		if (changed) persist();
		for (const provider of providers) {
			if (cooldowns[provider] > Date.now()) scheduleCooldown(provider);
		}
		if (rows.some((job) => job.status === "queued")) schedulePump();
	}

	function sourceTitle({ kind, origin }) {
		if (origin === "local") return `Local ${kind}`;
		if (origin === "remote") return `Remote ${kind}`;
		return "Source";
	}

	function hasMissingSource(job) {
		return job.sources.some(({ id }) => !stagedSources.has(id));
	}

	function discardUnusedSource(id, source) {
		if (source.draft || source.jobIds.size) return;
		if (source.src) URL.revokeObjectURL(source.src);
		stagedSources.delete(id);
	}

	function releaseJobSources(job) {
		for (const id of job.sourceIds) {
			const source = stagedSources.get(id);
			if (!source) continue;
			source.jobIds.delete(job.id);
			discardUnusedSource(id, source);
		}
	}

	function unstageSource(id) {
		const source = stagedSources.get(id);
		if (!source) return;
		source.draft = false;
		discardUnusedSource(id, source);
	}

	function stageSource(kind, origin, src, payload) {
		const id = `source-${crypto.randomUUID()}`;
		// Only kind and origin cross into the job record. The file or exact URL stays here.
		stagedSources.set(id, { kind, origin, src, payload, draft: true, jobIds: new Set() });
		const title = origin === "local" ? payload.name : sourceTitle({ kind, origin });
		return { id, kind, title, src, origin };
	}

	function stageUrl(value, kind) {
		if (!kinds.includes(kind)) throw new Error("Choose an image or video source kind.");
		const url = typeof value === "string" ? value.trim() : "";
		const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
		if (!authority || authority.includes("@") || /[\s\\\p{Cc}]/u.test(url) || !URL.canParse(url)) {
			throw new Error("Enter a valid HTTP or HTTPS media URL without credentials.");
		}
		return stageSource(kind, "remote", null, url);
	}

	async function stageFile(file, kind, acceptedTypes) {
		if (!kinds.includes(kind)) throw new Error("Choose an image or video source kind.");
		if (!(file instanceof File)) throw new Error("Choose a local media file.");
		let mime;
		try {
			mime = await checkedFileMime(file);
		} catch {
			throw new Error("The selected file could not be read.");
		}
		if (!mime?.startsWith(`${kind}/`) || (acceptedTypes && !acceptedTypes.includes(mime))) {
			throw new Error(`Choose a supported ${kind} file.`);
		}
		const src = URL.createObjectURL(file.slice(0, file.size, mime));
		return stageSource(kind, "local", src, file);
	}

	function mediaMime(bytes) {
		const at = (offset, ...signature) =>
			signature.every((byte, index) => bytes[offset + index] === byte);
		const tag = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
		if (at(0, 137, 80, 78, 71, 13, 10, 26, 10) && tag(12, 4) === "IHDR") return "image/png";
		if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
		if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(tag(0, 6))) return "image/gif";
		if (
			tag(0, 4) === "RIFF" &&
			tag(8, 4) === "WEBP" &&
			["VP8 ", "VP8L", "VP8X"].includes(tag(12, 4))
		) {
			return "image/webp";
		}
		if (tag(4, 4) === "ftyp" && bytes.length >= 16) {
			const brand = tag(8, 4);
			if (brand === "qt  ") return "video/quicktime";
			const isAvif = (value) => value === "avif" || value === "avis";
			if (isAvif(brand)) return "image/avif";
			const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
			for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.length); offset += 4) {
				if (isAvif(tag(offset, 4))) return "image/avif";
			}
			if (
				["isom", "iso2", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(brand)
			) {
				return "video/mp4";
			}
		}
		if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) {
			for (let offset = 5; offset < 64; offset++) {
				if (at(offset, 0x42, 0x82, 0x84) && tag(offset + 3, 4) === "webm") return "video/webm";
			}
		}
		return null;
	}

	async function checkedFileMime(file) {
		const mime = mediaMime(new Uint8Array(await file.slice(0, 512).arrayBuffer()));
		return !file.type || file.type === mime || file.type === "application/octet-stream"
			? mime
			: null;
	}

	async function importFiles(files) {
		const entries = Array.from(files ?? []);
		let added = 0;
		for (const file of entries) {
			if (!(file instanceof File)) continue;
			try {
				const mime = await checkedFileMime(file);
				if (!mime || mime === "video/quicktime") continue;
				const src = URL.createObjectURL(file.slice(0, file.size, mime));
				const id = `import-${crypto.randomUUID()}`;
				importedAssets.set(id, {
					id,
					mime,
					src,
					title: file.name,
					provider: "local",
					kind: mime.startsWith("image/") ? "image" : "video",
					sourceIds: [],
					createdAt: Date.now(),
				});
				added++;
			} catch {
				// A failed file read leaves the other imports available.
			}
		}
		const result = { added, rejected: entries.length - added };
		if (added) publish("assets");
		return result;
	}

	window.StudioViews ??= {};
	window.Studio = {
		assets,
		jobs: () => [...rows].sort((a, b) => b.createdAt - a.createdAt).map(publicJob),
		settings: () => structuredClone(preferences),
		configure,
		balance(provider) {
			if (!providers.includes(provider)) return { value: null, unit: "", asOf: null };
			const balance = fixtureBalances[provider];
			return hasWalletAccess(provider)
				? (wallets?.balance(provider) ?? { ...balance })
				: { value: null, unit: balance.unit, asOf: null };
		},
		walletComparison: (job) => wallets?.comparison(job),
		walletHistory: (job, jobs) => wallets?.history(job, jobs, Date.now()),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		submit,
		stageFile,
		stageUrl,
		unstageSource,
		retryEstimate(id) {
			const job = byId.get(id);
			return job ? estimateAttempt(job) : null;
		},
		retry,
		stopQueued,
		recoverDownload,
		openAsset(id) {
			if (!hasAsset(id)) return;
			pendingAsset = id;
			window.Studio.go?.("gallery");
		},
		consumeAsset() {
			const id = pendingAsset;
			pendingAsset = null;
			return id;
		},
		importFiles,
	};
	restoreProgress();
})();
