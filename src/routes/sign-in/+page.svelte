<script lang="ts">
import OwnerForm from "#lib/components/owner/OwnerForm.svelte";

let { form, data } = $props();
</script>
<OwnerForm pending={data.pending} message={form?.message} username={form?.username} />
