<script lang="ts">
import type { CodesNotice } from "#lib/shared/owner/session-client.ts";
import { css } from "#styled-system/css";
import { afterNavigate } from "$app/navigation";

/**
 * Newly issued recovery codes, in a modal dialog above every route and error page until
 * Done. Escape, a backdrop click or any other close never dismisses it.
 */
let { codes, notice, ondone }: { codes: string[]; notice: CodesNotice; ondone: () => void } =
	$props();
let dialog = $state<HTMLDialogElement>();
let done = $state<HTMLButtonElement>();
let finishing = false;

/** Done takes focus back from anything outside the dialog, including after route changes. */
const reclaim = () => {
	if (dialog?.open && done && !dialog.contains(document.activeElement)) done.focus();
};
afterNavigate(reclaim);
$effect(() => {
	const element = dialog;
	if (!element) return;
	// `closedby` keeps Escape and light dismiss away where the browser supports it.
	element.setAttribute("closedby", "none");
	if (!element.open) element.showModal();
	done?.focus();
	const blockEscape = (event: KeyboardEvent) => {
		if (event.key === "Escape" && element.open) {
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const keepOpen = (event: Event) => event.preventDefault();
	const reopen = () => {
		if (!finishing && element.isConnected && !element.open) {
			element.showModal();
			done?.focus();
		}
	};
	const outside = (event: FocusEvent) => {
		if (!element.contains(event.target as Node)) reclaim();
	};
	window.addEventListener("keydown", blockEscape, { capture: true });
	element.addEventListener("cancel", keepOpen);
	element.addEventListener("close", reopen);
	document.addEventListener("focusin", outside);
	return () => {
		window.removeEventListener("keydown", blockEscape, { capture: true });
		element.removeEventListener("cancel", keepOpen);
		element.removeEventListener("close", reopen);
		document.removeEventListener("focusin", outside);
	};
});
function finish() {
	finishing = true;
	dialog?.close();
	ondone();
}

const layer = css({
	inlineSize: "min(100vw - 2rem, 34rem)",
	maxBlockSize: "calc(100dvh - 2rem)",
	overflow: "auto",
	padding: "clamp(1rem, 4vw, 2rem)",
	border: "1px solid {colors.line}",
	borderRadius: "15px",
	background: "surface",
	color: "ink",
	"&::backdrop": { background: "canvas" },
	"& ul": { paddingInlineStart: "1.25rem" },
});
const caveat = css({ color: "warning", fontWeight: 650 });
</script>

<dialog bind:this={dialog} class={layer} aria-labelledby="recovery-codes-title">
	<h2 id="recovery-codes-title">Save your recovery codes</h2>
	<p>Keep these ten single-use codes somewhere private. They are shown once.</p>
	{#if notice === "replaced"}
		<p class={caveat} role="alert">
			A later Security change replaced these codes. Do not keep these.
		</p>
	{:else if notice === "signed-out" || notice === "changed"}
		<p class={caveat} role="alert">
			{notice === "signed-out" ? "Signed out." : "Session changed."} These codes hold only if
			two-step sign-in has not changed since.
		</p>
	{/if}
	<ul class={css({ overflowWrap: "anywhere", userSelect: "all", fontFamily: "monospace" })}>
		{#each codes as code (code)}
			<li>{code}</li>
		{/each}
	</ul>
	<button bind:this={done} type="button" onclick={finish}>Done</button>
</dialog>
