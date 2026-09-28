<script lang="ts">
  import source from '../../assets/chicken.svg?raw'

  let { size = 15, mark = true }: { size?: number; mark?: boolean } = $props()

  const d = source.match(/\sd="([^"]+)"/)?.[1] ?? ''
</script>

<span class="logo" style:font-size="{size}px">
  {#if mark}
    <svg class="mark" viewBox="40 12 432 488" aria-hidden="true"><path {d} /></svg>
  {/if}
  <span><span class="a">bawk</span><span class="b">term</span></span>
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    font-weight: 700;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .mark {
    height: 1.3em;
    width: auto;
    fill: var(--text-strong);
    flex: none;
  }
  .a {
    color: var(--text-strong);
  }
  .b {
    color: var(--text-weak);
  }
</style>
