<script lang="ts">
  let { size = 15 }: { size?: number } = $props()
</script>

<span class="logo" style:font-size="{size}px"><span class="a">bawk</span><span class="b">term</span></span>

<style>
  .logo {
    font-weight: 700;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .a {
    color: var(--text-strong);
  }
  .b {
    color: var(--text-weak);
  }
</style>
