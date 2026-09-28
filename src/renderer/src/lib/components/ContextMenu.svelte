<script lang="ts">
  import { app } from '$lib/state.svelte'

  let el = $state<HTMLDivElement>()

  const position = $derived.by(() => {
    const menu = app.menu
    if (!menu) return { x: 0, y: 0 }
    const width = 200
    const height = menu.items.length * 30
    return {
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: Math.min(menu.y, window.innerHeight - height - 8)
    }
  })

  function close(): void {
    app.menu = null
  }
</script>

<svelte:window
  onmousedown={(e) => app.menu && !el?.contains(e.target as Node) && close()}
  onkeydown={(e) => e.key === 'Escape' && close()}
  onblur={close}
/>

{#if app.menu}
  <div class="menu" role="menu" bind:this={el} style:left="{position.x}px" style:top="{position.y}px">
    {#each app.menu.items as item, i (i)}
      {#if item === 'sep'}
        <div class="sep"></div>
      {:else if 'swatches' in item}
        <div class="swatches" role="group" aria-label="folder color">
          <span class="swatch-label">color</span>
          {#each item.swatches as color (color)}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={item.current === color}
              aria-label={color}
              title={color}
              class={['swatch', item.current === color && 'on']}
              style:--swatch={`var(--folder-${color})`}
              onclick={() => {
                close()
                item.pick(color)
              }}
            ></button>
          {/each}
          <button
            type="button"
            class="swatch none"
            aria-label="no color"
            title="no color"
            disabled={!item.current}
            onclick={() => {
              close()
              item.pick(null)
            }}>×</button
          >
        </div>
      {:else}
        <button
          type="button"
          role="menuitem"
          class:danger={item.danger}
          disabled={item.disabled}
          onclick={() => {
            close()
            item.action()
          }}>{item.label}</button
        >
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 150;
    min-width: 200px;
    padding: 4px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    background: var(--bg);
    box-shadow: var(--shadow);
  }
  button {
    display: block;
    width: 100%;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--text-strong);
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--bg-weak-hover);
  }
  button:disabled {
    color: var(--text-weaker);
    cursor: default;
  }
  .danger {
    color: var(--danger);
  }
  .swatches {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
  }
  .swatch-label {
    flex: 1;
    color: var(--text-strong);
  }
  .swatches .swatch {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 50%;
    background: var(--swatch);
    color: var(--text-weak);
    font-size: 12px;
    line-height: 1;
  }
  .swatches .swatch:hover:not(:disabled) {
    background: var(--swatch);
    outline: 1px solid var(--border);
    outline-offset: 1px;
  }
  .swatches .swatch.on {
    outline: 2px solid var(--text-strong);
    outline-offset: 1px;
  }
  .swatches .swatch.none {
    border-color: var(--border);
    background: none;
  }
  .swatches .swatch.none:hover:not(:disabled) {
    background: none;
    color: var(--text-strong);
  }
  .sep {
    height: 1px;
    margin: 4px 0;
    background: var(--border-weak);
  }
</style>
