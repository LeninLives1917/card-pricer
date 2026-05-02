<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();

  let working = $state(false);
  let result = $state<'accepted' | 'declined' | null>(
    data.offer.status === 'accepted' ? 'accepted' : data.offer.status === 'declined' ? 'declined' : null,
  );
  let error = $state<string | null>(null);

  async function decide(action: 'accept' | 'decline') {
    working = true;
    error = null;
    try {
      const r = await fetch(`/api/offers/${data.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        error = j.message ?? `Failed (${r.status})`;
        return;
      }
      const j = (await r.json()) as { status: 'accepted' | 'declined' };
      result = j.status;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Network error';
    } finally {
      working = false;
    }
  }
</script>

<svelte:head>
  <title>Offer · Card Pricer</title>
</svelte:head>

<div class="wrap">
  <h1 class="display" style="font-size: 28px;">Quote offer</h1>
  <p style="color: var(--paper-300); font-size: 13px;">For {data.offer.customer_email}</p>

  <section class="panel">
    <ul class="items">
      {#each (data.offer.line_items as Array<{ name: string; price: number }>) ?? [] as li}
        <li>
          <span class="display">{li.name}</span>
          <span class="figure">€{li.price.toFixed(2)}</span>
        </li>
      {/each}
    </ul>
    <div class="total">
      <span class="label">Total</span>
      <span class="figure value">€{data.offer.total_eur.toFixed(2)}</span>
    </div>
  </section>

  {#if result === 'accepted'}
    <p class="banner ok">Offer accepted. The shop has been notified.</p>
  {:else if result === 'declined'}
    <p class="banner declined">Offer declined.</p>
  {:else}
    <div class="actions">
      <button class="btn primary" disabled={working} onclick={() => decide('accept')}>
        {working ? '…' : 'Accept'}
      </button>
      <button class="btn secondary" disabled={working} onclick={() => decide('decline')}>Decline</button>
    </div>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</div>

<style>
  .wrap { max-width: 600px; margin: 0 auto; padding: 48px 16px; }
  .panel { background: var(--ink-200); border: 1px solid var(--hairline); border-radius: var(--r-2); padding: 20px; margin: 16px 0; }
  .items { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .items li { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--hairline); }
  .items li:last-child { border-bottom: 0; }
  .total { display: flex; justify-content: space-between; padding-top: 14px; border-top: 1px solid var(--hairline); margin-top: 8px; }
  .label { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--paper-300); }
  .value { font-size: 22px; color: var(--paper-100); }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  .btn { padding: 12px 20px; border-radius: var(--r-2); border: 0; font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; flex: 1; transition: background var(--t-fast) var(--ease); }
  .btn.primary { background: var(--up); color: var(--ink-100); }
  .btn.secondary { background: var(--ink-300); color: var(--paper-100); border: 1px solid var(--hairline); }
  .btn.primary:hover:not(:disabled) { background: #14803a; }
  .btn.secondary:hover { background: var(--ink-400); }
  .banner { padding: 14px; border-radius: var(--r-2); text-align: center; margin-top: 16px; font-size: 13px; }
  .banner.ok { background: var(--up-soft); color: var(--up); border: 1px solid rgba(22,163,74,0.3); }
  .banner.declined { background: var(--down-soft); color: var(--down); border: 1px solid rgba(220,38,38,0.3); }
  .err { color: var(--down); font-size: 12px; margin-top: 8px; }
</style>
