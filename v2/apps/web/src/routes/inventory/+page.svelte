<script lang="ts">
  // Inventory page — list of bought cards with cost / state / market value.
  // Item-detail + state-machine actions handled by /inventory/[id] page (week 9 polish).
  import { onMount } from 'svelte';
  import { supabaseAuthHeader } from '$lib/client/auth.js';

  type Item = {
    id: string;
    card_meta: { name?: string; set_code?: string; card_number?: string };
    cost_eur: number;
    market_value_at_buy: number | null;
    state: 'in_stock' | 'listed' | 'sold' | 'consigned' | 'returned';
    condition_at_buy: string | null;
    created_at: string;
  };

  let items = $state<Item[]>([]);
  let loading = $state(true);
  let stateFilter = $state<'all' | Item['state']>('all');

  async function load() {
    loading = true;
    try {
      const url = stateFilter === 'all' ? '/api/inventory' : `/api/inventory?state=${stateFilter}`;
      const r = await fetch(url, { headers: await supabaseAuthHeader() });
      if (r.ok) {
        const data = (await r.json()) as { items: Item[] };
        items = data.items;
      }
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function transition(item: Item, to: Item['state']) {
    const r = await fetch(`/api/inventory/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await supabaseAuthHeader()) },
      body: JSON.stringify({ state: to }),
    });
    if (r.ok) load();
  }
</script>

<svelte:head>
  <title>Inventory · Card Pricer</title>
</svelte:head>

<header class="hd">
  <h1 class="display" style="font-size: 26px;">Inventory</h1>
  <select bind:value={stateFilter} onchange={load}>
    <option value="all">All</option>
    <option value="in_stock">In stock</option>
    <option value="listed">Listed</option>
    <option value="sold">Sold</option>
    <option value="consigned">Consigned</option>
    <option value="returned">Returned</option>
  </select>
</header>

{#if loading}
  <p style="color: var(--paper-300); font-size: 13px;">Loading…</p>
{:else if items.length === 0}
  <div class="empty">
    <p class="display" style="font-size: 18px;">No items yet</p>
    <p style="color: var(--paper-300); font-size: 13px; margin-top: 6px;">
      Bought cards from the Log tab land here. They flow through in_stock → listed → sold.
    </p>
  </div>
{:else}
  <ul class="rows">
    {#each items as it}
      <li class="row">
        <div class="meta">
          <div class="display name">{it.card_meta.name ?? 'Unknown card'}</div>
          <div class="figure sub">
            {it.card_meta.set_code ?? ''} · #{it.card_meta.card_number ?? ''}
            {#if it.condition_at_buy}<span class="cond">{it.condition_at_buy}</span>{/if}
          </div>
        </div>
        <div class="figure cost">€{it.cost_eur.toFixed(2)}</div>
        <span class="state state-{it.state}">{it.state.replace('_', ' ')}</span>
        <div class="acts">
          {#if it.state === 'in_stock'}
            <button class="link" onclick={() => transition(it, 'listed')}>List</button>
            <button class="link" onclick={() => transition(it, 'sold')}>Mark sold</button>
          {:else if it.state === 'listed'}
            <button class="link" onclick={() => transition(it, 'sold')}>Mark sold</button>
            <button class="link" onclick={() => transition(it, 'in_stock')}>Unlist</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .hd { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
  .hd select {
    background: var(--ink-300); border: 1px solid var(--hairline); border-radius: var(--r-1);
    color: var(--paper-100); padding: 6px 10px; font-size: 13px;
  }
  .empty { text-align: center; padding: 56px 24px; }
  .rows { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row {
    display: grid; grid-template-columns: 1fr auto auto auto;
    gap: 12px; align-items: center;
    padding: 10px 12px; background: var(--ink-200); border: 1px solid var(--hairline); border-radius: var(--r-2);
  }
  .name { font-size: 15px; color: var(--paper-100); }
  .sub { font-size: 11px; color: var(--paper-300); margin-top: 2px; }
  .cond { background: var(--ink-300); border: 1px solid var(--hairline); padding: 1px 6px; border-radius: var(--r-1); margin-left: 6px; }
  .cost { font-size: 14px; color: var(--paper-100); }
  .state {
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 9px; font-weight: 600; padding: 3px 8px;
    border-radius: var(--r-1); letter-spacing: 0.08em; text-transform: uppercase;
  }
  .state-in_stock { background: var(--ink-300); color: var(--paper-200); }
  .state-listed { background: var(--accent-mute); color: var(--accent-soft); }
  .state-sold { background: var(--up-soft); color: var(--up); }
  .state-consigned { background: var(--rare-soft); color: var(--rare); }
  .state-returned { background: var(--down-soft); color: var(--down); }
  .acts { display: flex; gap: 4px; }
  .link {
    background: var(--ink-300); border: 1px solid var(--hairline); border-radius: var(--r-1);
    color: var(--paper-200); font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 11px; font-weight: 500; padding: 4px 8px; cursor: pointer;
  }
  .link:hover { background: var(--ink-400); color: var(--paper-100); }
</style>
