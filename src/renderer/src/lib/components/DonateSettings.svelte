<script lang="ts">
  const ONCE = [
    { label: '$5', url: 'https://donate.stripe.com/aFa4gz4Ux9xz5e17Ev67S00' },
    { label: '$15', url: 'https://donate.stripe.com/9B6eVdcmZ6ln7m99MD67S01' },
    { label: '$30', url: 'https://donate.stripe.com/cNifZh5YBh0135T2kb67S02' }
  ]
  const MONTHLY = 'https://donate.stripe.com/8x2bJ172FeRT35T3of67S03'
  const MANAGE = 'https://billing.stripe.com/p/login/aFa4gz4Ux9xz5e17Ev67S00'

  const open = (url: string): void => window.api.app.openExternal(url)
</script>

<p class="lead">
  bawkterm is free and has no paid tier. If it saves you time, a donation helps pay for what comes next. Each button
  opens a Stripe checkout in your browser.
</p>
<div class="ways">
  <div class="way">
    <span class="strong">one time</span>
    <span class="actions">
      {#each ONCE as { label, url } (label)}
        <button type="button" class="btn" aria-label="Donate {label} once" onclick={() => open(url)}>{label}</button>
      {/each}
    </span>
  </div>
  <div class="way">
    <span class="stack">
      <span class="strong">monthly</span>
      <button type="button" class="link" onclick={() => open(MANAGE)}>Cancel a monthly donation</button>
    </span>
    <button type="button" class="btn" onclick={() => open(MONTHLY)}>$5 a month</button>
  </div>
</div>
<p class="hint">Payments go through Stripe. Donations are not tax-deductible.</p>

<style>
  .lead {
    margin-bottom: 14px;
    line-height: 1.8;
  }
  .ways {
    display: grid;
    border-top: 1px solid var(--border-weak);
  }
  .way {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border-weak);
  }
  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-weak);
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover {
    color: var(--text-strong);
  }
  .hint {
    margin-top: 14px;
    color: var(--text-weak);
    font-size: 12px;
  }
</style>
