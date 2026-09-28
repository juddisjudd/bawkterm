<script lang="ts">
  import { app } from '$lib/state.svelte'
  import ModalDialog from './ModalDialog.svelte'

  const modal = $derived(app.modals[0])
</script>

{#if modal}
  {#key modal.id}
    <ModalDialog {modal} />
  {/key}
{/if}
