<script lang="ts">
import { Dialog } from "@ark-ui/svelte/dialog";
import { onMount, type Snippet, tick } from "svelte";
import icon from "#lib/assets/siluet-icon.svg";
import {
	type ImageDraftMemory,
	setImageDraftContext,
} from "#lib/components/image-studio/draft-context.ts";
import { watchSignOut } from "#lib/shared/owner/session-notice.ts";
import { skipLink } from "#lib/shared/styles/navigation.ts";
import { cx } from "#styled-system/css";
import { drawer, shell } from "./studio-shell-styles.ts";

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
const jobs = $derived(pathname === "/jobs");
const gallery = $derived(pathname === "/gallery" || pathname.startsWith("/gallery/"));
const destination = $derived(
	settings
		? "Providers"
		: pathname === "/video"
			? "Video Studio"
			: image
				? "Image Studio"
				: jobs
					? "Jobs"
					: gallery
						? "Gallery"
						: "Studio home",
);
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
	<nav class={shell.navigation} aria-label="Studio navigation">
		<a
			class={shell.navLink}
			href="/"
			aria-current={pathname === "/" ? "page" : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
				<rect x="3" y="3" width="7" height="7" rx="1" />
				<rect x="14" y="3" width="7" height="7" rx="1" />
				<rect x="3" y="14" width="7" height="7" rx="1" />
				<rect x="14" y="14" width="7" height="7" rx="1" />
			</svg>
			Studio home
		</a>
		<a
			class={shell.navLink}
			href="/image"
			aria-current={image ? "page" : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<circle cx="8.5" cy="9" r="1.5" />
				<path d="m4 17 5-4 3 2 4-4 5 5" />
			</svg>
			Image Studio
		</a>
		<a
			class={shell.navLink}
			href="/video"
			aria-current={pathname === "/video" ? "page" : undefined}
			onclick={() => (menuOpen = false)}
			><svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
				<rect x="2" y="5" width="14" height="14" rx="2" />
				<path d="m16 9 6-3v12l-6-3z" />
			</svg
			>Video Studio</a
		>
		<a
			class={shell.navLink}
			href="/jobs"
			aria-current={jobs ? "page" : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
				<path d="m3 6 1.5 1.5L7 4m3 2h11M3 12h4m3 0h11M3 18h4m3 0h11" />
			</svg>
			Jobs
		</a>
		<a
			class={shell.navLink}
			href="/gallery"
			aria-current={gallery ? (pathname === "/gallery" ? "page" : "location") : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
				<rect x="6" y="3" width="15" height="14" rx="2" />
				<path d="m7 14 4-4 3 2 3-4 3 3M3 8v11a2 2 0 0 0 2 2h12" />
			</svg>
			Gallery
		</a>
		<a
			class={shell.navLink}
			href="/settings/providers"
			aria-current={settings ? "page" : undefined}
			onclick={() => (menuOpen = false)}
		>
			<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
				<path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4" />
			</svg>
			<span>Settings</span>
		</a>
	</nav>
{/snippet}

<a class={skipLink} href="#workspace-main">Skip to workspace</a>
<div class={shell.root}>
	<aside class={cx(shell.rail, shell.sidebar)} aria-label="Studio sidebar">
		<span class={shell.identity}><img src={icon} alt="" width="40" height="40">Siluet</span>
		{@render navigation()}
	</aside>
	<div>
		<header class={shell.topbar}>
			<div class={cx(shell.frame, shell.location)}>
				<div class={shell.mobileMenu}>
					<Dialog.Root bind:open={menuOpen} lazyMount unmountOnExit>
						<Dialog.Trigger class={drawer.trigger} aria-label="Menu" disabled={!menuReady}>
							<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
								<path d="M4 6h16M4 12h16M4 18h16" />
							</svg>
						</Dialog.Trigger>
						<Dialog.Backdrop class={drawer.backdrop} />
						<Dialog.Positioner class={drawer.positioner}>
							<Dialog.Content class={cx(shell.rail, drawer.content)}>
								<header class={shell.drawerHeader}>
									<Dialog.Title class={drawer.title}>
										<span class={shell.identity}>
											<img src={icon} alt="" width="40" height="40">Siluet<span
												class={shell.screenReaderText}
											>
												navigation</span
											>
										</span>
									</Dialog.Title>
									<Dialog.CloseTrigger class={drawer.closeTrigger} aria-label="Close menu">
										<svg class={shell.icon} viewBox="0 0 24 24" aria-hidden="true">
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
				<span class={shell.locationParent}>{settings ? "Settings" : "Workspace"}</span>
				<span class={shell.locationParent} aria-hidden="true">/</span>
				<span class={shell.locationCurrent}>{destination}</span>
			</div>
		</header>
		<main id="workspace-main" tabindex="-1" class={cx(shell.frame, shell.content)}>
			{#if !signedOut}
				{@render children()}
			{/if}
		</main>
	</div>
</div>
