<script lang="ts">
import OwnerForm from "#lib/components/owner/OwnerForm.svelte";

let { form } = $props();
</script>
<OwnerForm message={form?.message} username={form?.username} />
