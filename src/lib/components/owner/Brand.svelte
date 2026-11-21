<script lang="ts">
import icon from "#lib/assets/siluet-icon.svg";
import { css } from "#styled-system/css";

const brand = css({
	fontSize: "1.55rem",
	letterSpacing: "-0.05em",
	fontWeight: "700",
	display: "inline-flex",
	alignItems: "center",
	gap: "0.65rem",
	color: "railInk",
});
</script>
<span class={brand}><img src={icon} width="38" height="38" alt="">Siluet</span>
