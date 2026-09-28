<script lang="ts">
  let {
    checked = $bindable(false),
    label,
    disabled = false,
    onchange
  }: { checked?: boolean; label: string; disabled?: boolean; onchange?: (checked: boolean) => void } = $props()

  function toggle(): void {
    checked = !checked
    onchange?.(checked)
  }
</script>

<button type="button" class="check" role="checkbox" aria-checked={checked} {disabled} onclick={toggle}>
  <span class="box">[{checked ? 'x' : ' '}]</span>
  <span>{label}</span>
</button>

<style>
  .check {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .check:hover:not(:disabled) {
    color: var(--text-strong);
  }
  .check:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .box {
    color: var(--text-strong);
    white-space: pre;
  }
</style>
