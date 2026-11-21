<script lang="ts">
import "../app.css";
import icon from "#lib/assets/siluet-icon.svg";

let { children } = $props();
</script>
<svelte:head><link rel="icon" href={icon}></svelte:head>
{@render children()}
