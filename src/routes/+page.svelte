<script lang="ts">
import { Collapsible } from "@ark-ui/svelte/collapsible";
import { css } from "#styled-system/css";
import "../app.css";
</script>

<svelte:head><title>Siluet</title></svelte:head>

<main class={css({ padding: "2rem", fontFamily: "system-ui, sans-serif" })}>
	<h1>Siluet</h1>
	<Collapsible.Root>
		<Collapsible.Trigger>Studio status</Collapsible.Trigger>
		<Collapsible.Content>The local studio is running.</Collapsible.Content>
	</Collapsible.Root>
</main>
