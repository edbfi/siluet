(() => {
	window.StudioViews ??= {};
	const views = window.StudioViews;
	const providers = [
		{ id: "poyo", name: "Poyo.ai", mark: "P" },
		{ id: "toapis", name: "ToAPIs", mark: "T" },
	];
	const phases = ["Providers", "Demo keys", "Review"];
	let activeDialog;

	views.onboarding = (force = false) => {
		const studio = window.Studio;
		const initial = studio.settings();
		if ((!force && initial.onboarded) || activeDialog?.open) return;

		const opener = document.activeElement;
		const dialog = document.createElement("dialog");
		dialog.className = "studio-setup";
		dialog.setAttribute("aria-labelledby", "studio-setup-title");
		dialog.innerHTML = `
			<div class="studio-setup__shell">
				<div class="studio-setup__header">
					<ol class="studio-setup__steps" aria-label="Setup progress">
						${phases.map((phase) => `<li>${phase}</li>`).join("")}
					</ol>
					${force ? '<button type="button" class="studio-setup__close" data-action="close" aria-label="Close setup"><span aria-hidden="true"></span></button>' : ""}
				</div>
				<div class="studio-setup__body"></div>
				<footer class="studio-setup__footer"></footer>
			</div>`;

		const body = dialog.querySelector(".studio-setup__body");
		const footer = dialog.querySelector(".studio-setup__footer");
		const picked = new Set(providers.filter(({ id }) => initial.keys[id]).map(({ id }) => id));
		const connected = new Set(picked);
		let wallet = Boolean(initial.wallet.toapis);
		let step = 0;

		function ready() {
			return picked.size > 0 && (step === 0 || [...picked].every((id) => connected.has(id)));
		}

		function render() {
			Array.from(dialog.querySelectorAll(".studio-setup__steps li")).forEach((item, index) => {
				item.toggleAttribute("data-complete", index < step);
				if (index === step) item.setAttribute("aria-current", "step");
				else item.removeAttribute("aria-current");
			});

			if (step === 0) {
				body.innerHTML = `
					<h2 id="studio-setup-title" tabindex="-1">Choose your demo providers</h2>
					<p>Pick Poyo.ai, ToAPIs, or both. One connection is enough to try image and video jobs.</p>
					<fieldset class="studio-setup__choices">
						<legend class="studio-setup__sr">Demo providers</legend>
						${providers
							.map(
								({ id, name, mark }) => `
							<label class="studio-setup__choice">
								<span class="studio-setup__mark" aria-hidden="true">${mark}</span>
								<span><strong>${name}</strong><small>${initial.keys[id] ? "Demo key connected" : "Demo connection available"}</small></span>
								<input type="checkbox" data-provider="${id}" ${picked.has(id) ? "checked" : ""}>
							</label>`,
							)
							.join("")}
					</fieldset>
					<p class="studio-setup__note">Gallery and job history stay local. Siluet sends no telemetry. Only the selected provider receives the inputs you authorize for a real job. It may retrieve submitted references through a provider-hosted URL.</p>`;
			} else if (step === 1) {
				body.innerHTML = `
					<h2 id="studio-setup-title" tabindex="-1">Connect your demo keys</h2>
					<p>These fictional keys let you try the studio without a provider account. Keep real keys out of this demo.</p>
					<ul class="studio-setup__connections">
						${providers
							.filter(({ id }) => picked.has(id))
							.map(
								({ id, name, mark }) => `
							<li>
								<span class="studio-setup__mark" aria-hidden="true">${mark}</span>
								<strong>${name}</strong>
								<button type="button" class="studio-setup__button" data-action="connect" data-provider="${id}" aria-label="Connect ${name} demo key" ${connected.has(id) ? "hidden" : ""}>Connect demo key</button>
								<span class="studio-setup__connected" ${connected.has(id) ? "" : "hidden"}>Connected</span>
							</li>`,
							)
							.join("")}
					</ul>
					<p class="studio-setup__sr" role="status"></p>`;
			} else {
				const names = providers.filter(({ id }) => picked.has(id)).map(({ name }) => name);
				body.innerHTML = `
					<h2 id="studio-setup-title" tabindex="-1">Review access</h2>
					<dl class="studio-setup__summary">
						<div><dt>Demo model access</dt><dd>${names.join(", ")}</dd></div>
						<div><dt>Account balance</dt><dd>${picked.has("poyo") ? "Poyo.ai shows a sample balance with its demo connection." : "Balance access is optional."}</dd></div>
					</dl>
					${
						picked.has("toapis")
							? `
						<label class="studio-setup__permission">
							<input type="checkbox" data-wallet aria-describedby="studio-setup-wallet-help" ${wallet ? "checked" : ""}>
							<span><strong>Show the ToAPIs demo balance</strong><small id="studio-setup-wallet-help">A real balance check needs a separate system access token. Model generation only needs the model key.</small></span>
						</label>`
							: ""
					}
					<p class="studio-setup__note">You can change your demo connections and balance access later in Settings.</p>`;
			}

			footer.innerHTML =
				step === 0
					? `<button type="button" class="studio-setup__text-button" data-action="${force ? "close" : "explore"}">${force ? "Cancel" : "Explore without keys"}</button>
					<button type="button" class="studio-setup__button studio-setup__button--primary" data-action="next">Continue</button>`
					: `<button type="button" class="studio-setup__text-button" data-action="back">Back</button>
					<button type="button" class="studio-setup__button studio-setup__button--primary" data-action="${step === 1 ? "next" : "finish"}">${step === 1 ? "Continue" : "Open studio"}</button>`;
			footer.lastElementChild.disabled = !ready();
		}

		function focusHeading() {
			body.querySelector("h2").focus();
			dialog.scrollTop = 0;
		}

		function remove() {
			if (activeDialog !== dialog) return;
			activeDialog = undefined;
			dialog.remove();
			if (opener instanceof HTMLElement && opener.isConnected)
				opener.focus({ preventScroll: true });
		}

		function close() {
			dialog.close();
			remove();
		}

		dialog.addEventListener("cancel", (event) => {
			event.preventDefault();
			if (force) close();
		});
		dialog.addEventListener("close", remove);

		dialog.addEventListener("change", ({ target }) => {
			if (target.hasAttribute("data-wallet")) {
				wallet = target.checked;
				return;
			}
			const id = target.dataset.provider;
			if (!id) return;
			if (target.checked) picked.add(id);
			else picked.delete(id);
			footer.lastElementChild.disabled = !ready();
		});

		dialog.addEventListener("click", ({ target }) => {
			const button = target.closest("button[data-action]");
			if (!button) return;

			switch (button.dataset.action) {
				case "close":
					close();
					break;
				case "explore":
					studio.configure({ onboarded: true });
					close();
					break;
				case "back":
				case "next":
					step += button.dataset.action === "back" ? -1 : 1;
					render();
					focusHeading();
					break;
				case "connect": {
					const id = button.dataset.provider;
					connected.add(id);
					button.hidden = true;
					button.nextElementSibling.hidden = false;
					const continueButton = footer.lastElementChild;
					continueButton.disabled = !ready();
					const focusTarget =
						body.querySelector('button[data-action="connect"]:not([hidden])') ?? continueButton;
					focusTarget.focus();
					const provider = providers.find((entry) => entry.id === id);
					body.querySelector('[role="status"]').textContent =
						`${provider.name} demo key connected.`;
					break;
				}
				case "finish": {
					const keys = Object.fromEntries([...picked].map((id) => [id, true]));
					const patch = { keys, onboarded: true };
					if (picked.has("toapis") && wallet !== Boolean(initial.wallet.toapis)) {
						patch.wallet = { toapis: wallet };
					}
					studio.configure(patch);
					close();
					break;
				}
			}
		});

		activeDialog = dialog;
		render();
		document.body.append(dialog);
		dialog.showModal();
		focusHeading();
	};
})();
