<script lang="ts">
import { Dialog } from "@ark-ui/svelte/dialog";
import { onMount, type Snippet, tick } from "svelte";
import icon from "#lib/assets/siluet-icon.svg";
import {
	type ImageDraftMemory,
	setImageDraftContext,
} from "#lib/components/image-studio/draft-context.ts";
import { watchSignOut } from "#lib/shared/owner/session-notice.ts";

let {
	pathname,
	signOutGeneration,
	children,
}: { pathname: string; signOutGeneration: string | null; children: Snippet } = $props();
let menuOpen = $state(false);
let menuReady = $state(false);
let signedOut = $state(false);
const settings = $derived(pathname.startsWith("/settings"));
const image = $derived(pathname === "/image");
const destination = $derived(settings ? "Providers" : image ? "Image Studio" : "Studio home");
const imageDraftMemory = $state<ImageDraftMemory>({});
setImageDraftContext(imageDraftMemory);

onMount(() => {
	menuReady = true;
	const mobile = matchMedia("(max-width: 760px)");
	const closeOnDesktop = () => {
		if (!mobile.matches) menuOpen = false;
	};
	mobile.addEventListener("change", closeOnDesktop);
	return () => mobile.removeEventListener("change", closeOnDesktop);
});

onMount(() =>
	watchSignOut(signOutGeneration, async () => {
		if (signedOut) return;
		signedOut = true;
		imageDraftMemory.draft = undefined;
		await tick();
		location.replace("/sign-in");
	}),
);
</script>

{#snippet navigation()}
	<nav aria-label="Studio navigation">
		<a
			href="/"
			aria-current={pathname === "/" ? "page" : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<rect x="3" y="3" width="7" height="7" rx="1" />
				<rect x="14" y="3" width="7" height="7" rx="1" />
				<rect x="3" y="14" width="7" height="7" rx="1" />
				<rect x="14" y="14" width="7" height="7" rx="1" />
			</svg>
			Studio home
		</a>
		<a href="/image" aria-current={image ? "page" : undefined} onclick={() => (menuOpen = false)}>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<circle cx="8.5" cy="9" r="1.5" />
				<path d="m4 17 5-4 3 2 4-4 5 5" />
			</svg>
			Image Studio
		</a>
		<a
			href="/settings/providers"
			aria-current={settings ? "page" : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4" />
			</svg>
			<span>Settings</span>
		</a>
	</nav>
{/snippet}

<a class="skip" href="#workspace-main">Skip to workspace</a>
<div class="shell">
	<aside class="sidebar" aria-label="Studio sidebar">
		<span class="identity"><img src={icon} alt="" width="40" height="40">Siluet</span>
		{@render navigation()}
	</aside>
	<div class="body">
		<header class="topbar">
			<div class="frame location">
				<div class="mobile-menu">
					<Dialog.Root bind:open={menuOpen} lazyMount unmountOnExit>
						<Dialog.Trigger class="studio-menu-button" aria-label="Menu" disabled={!menuReady}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
						</Dialog.Trigger>
						<Dialog.Backdrop class="studio-scrim" />
						<Dialog.Positioner class="studio-drawer-position">
							<Dialog.Content class="studio-drawer">
								<header class="drawer-header">
									<Dialog.Title class="studio-drawer-title"
										><span class="identity"
											><img src={icon} alt="" width="40" height="40">Siluet<span
												class="visually-hidden"
											>
												navigation</span
											></span
										></Dialog.Title
									>
									<Dialog.CloseTrigger class="studio-menu-button" aria-label="Close menu">
										<svg viewBox="0 0 24 24" aria-hidden="true">
											<path d="m6 6 12 12M18 6 6 18" />
										</svg>
									</Dialog.CloseTrigger>
								</header>
								{@render navigation()}
							</Dialog.Content>
						</Dialog.Positioner>
					</Dialog.Root>
					<img src={icon} alt="" width="28" height="28">
				</div>
				<span class="location-parent">{settings ? "Settings" : "Workspace"}</span>
				<span class="location-parent" aria-hidden="true">/</span>
				<span class="location-current">{destination}</span>
			</div>
		</header>
		<main id="workspace-main" tabindex="-1" class="frame content">
			{#if !signedOut}
				{@render children()}
			{/if}
		</main>
	</div>
</div>

<style>
.shell {
	--rail: light-dark(#111d33, #101827);
	--rail-ink: #f1f5ff;
	--rail-muted: #b5c1d6;
	--gutter: clamp(1.25rem, 3vw, 2.625rem);
	min-height: 100dvh;
	display: grid;
	grid-template-columns: 15rem minmax(0, 1fr);
}
.sidebar,
.mobile-menu :global(.studio-drawer) {
	background: var(--rail);
	color: var(--rail-ink);
	padding: 1.625rem 1.0625rem;
	overflow: auto;
}
.sidebar {
	position: sticky;
	inset-block-start: 0;
	height: 100dvh;
}
.identity {
	display: inline-flex;
	align-items: center;
	gap: 0.625rem;
	margin: 0;
	color: var(--rail-ink);
	font:
		650 1.43rem / 1.2 system-ui,
		sans-serif;
	letter-spacing: -0.035em;
}
nav {
	display: grid;
	gap: 0.25rem;
	margin-block-start: 2.4375rem;
}
nav a {
	display: flex;
	align-items: center;
	gap: 0.6875rem;
	min-height: 2.75rem;
	padding: 0.5rem 0.75rem;
	border: 1px solid transparent;
	border-radius: 8px;
	color: var(--rail-muted);
	font-size: 0.875rem;
	font-weight: 600;
	text-decoration: none;
}
nav a:hover,
.mobile-menu :global(.studio-drawer .studio-menu-button:hover) {
	background: #1e2d48;
	color: var(--rail-ink);
}
nav a[aria-current="page"] {
	border-color: #374c76;
	background: #26385e;
	color: #fff;
}
nav a:focus-visible,
.mobile-menu :global(.studio-drawer .studio-menu-button:focus-visible) {
	outline-color: #f4c461;
}
svg {
	width: 1.25rem;
	height: 1.25rem;
	flex: none;
	fill: none;
	stroke: currentColor;
	stroke-width: 1.65;
	stroke-linecap: round;
	stroke-linejoin: round;
}
.topbar {
	border-block-end: 1px solid var(--line);
	background: var(--surface);
}
.frame {
	width: min(100%, 96rem);
	margin-inline: auto;
	padding-inline: var(--gutter);
}
.location {
	display: flex;
	min-height: 3.875rem;
	align-items: center;
	gap: 0.625rem;
	font-size: 0.875rem;
}
.location-parent {
	color: var(--muted);
}
.location-current {
	font-weight: 650;
}
.content {
	padding-block: 2rem;
}
.mobile-menu {
	display: none;
}
.mobile-menu :global(.studio-menu-button) {
	display: grid;
	width: 2.75rem;
	height: 2.75rem;
	place-items: center;
	padding: 0;
	background: transparent;
	color: inherit;
}
.mobile-menu :global(.studio-menu-button:hover) {
	background: var(--canvas);
}
.mobile-menu :global(.studio-scrim),
.mobile-menu :global(.studio-drawer-position) {
	position: fixed;
	inset: 0;
	z-index: 10;
}
.mobile-menu :global(.studio-scrim) {
	background: rgb(10 20 40 / 54%);
}
.mobile-menu :global(.studio-drawer) {
	width: min(20rem, 90vw);
	height: 100%;
}
.mobile-menu :global(.studio-drawer-title) {
	margin: 0;
}
.drawer-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.visually-hidden {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}
@media (max-width: 760px) {
	.shell {
		display: block;
	}
	.sidebar,
	.location-parent {
		display: none;
	}
	.mobile-menu {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-inline-start: -0.5rem;
	}
	.location {
		min-height: 3.625rem;
	}
	.content {
		padding-block: 1.5rem;
	}
	nav {
		margin-block-start: 1.625rem;
	}
}
</style>
