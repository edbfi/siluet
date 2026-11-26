<script lang="ts">
import * as styles from "#lib/components/image-studio/image-review-styles.ts";
import type { ReviewOnlyRow } from "#lib/shared/media-catalog/picker.ts";

let {
	row,
	headingId,
	title = "Review request",
}: { row: ReviewOnlyRow; headingId: string; title?: string } = $props();

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const operations = $derived(
	row.operations.map((operation) => sentence(operation.replaceAll("-", " "))).join(", "),
);
</script>

<!-- A Review-only row offers no Queue and sends no request. -->
<section class={styles.panel} aria-labelledby={headingId}>
	<h2 class={styles.heading} id={headingId} tabindex="-1">{title}</h2>
	<p role="status">
		<strong>Review only.</strong>
		{sentence(row.reason)}. Siluet sends nothing for this model.
	</p>
	<dl class={styles.facts}>
		<div class={styles.fact}>
			<dt class={styles.term}>API provider</dt>
			<dd class={styles.detail}>Poyo.ai</dd>
		</div>
		<div class={styles.fact}>
			<dt class={styles.term}>Model</dt>
			<dd class={styles.detail}><code>{row.model}</code></dd>
		</div>
		<div class={styles.fact}>
			<dt class={styles.term}>Operations</dt>
			<dd class={styles.detail}>{operations}</dd>
		</div>
	</dl>
</section>
