<script lang="ts">
  // Session log — sliders set cash + credit %, rows show market / cash / credit.
  // State persistence (Supabase /api/state) ports here in week 5 with inventory.

  let cashPct = $state(55);
  let creditPct = $state(70);

  // Placeholder rows — wire to real session-log fetch in week 4.
  type LogRow = { name: string; setCode: string; number: string; market: number };
  const rows: LogRow[] = [];
</script>

<svelte:head>
  <title>Log · Card Pricer</title>
</svelte:head>

<section class="sliders">
  <div class="slider-row">
    <span class="label" style="color: #f59e0b;">Cash</span>
    <input type="range" min="10" max="90" bind:value={cashPct} aria-label="Cash offer percentage" />
    <span class="figure value" style="color: #f59e0b;">{cashPct}% of market</span>
  </div>
  <div class="slider-row">
    <span class="label" style="color: var(--up);">Credit</span>
    <input type="range" min="20" max="100" bind:value={creditPct} aria-label="Store credit offer percentage" />
    <span class="figure value" style="color: var(--up);">{creditPct}% of market</span>
  </div>
</section>

<section class="totals">
  <div class="stat">
    <div class="label">Market</div>
    <div class="figure stat-value">€0.00</div>
  </div>
  <div class="stat">
    <div class="label" style="color: #f59e0b;">Cash buy</div>
    <div class="figure stat-value" style="color: #f59e0b;">€0.00</div>
  </div>
  <div class="stat">
    <div class="label" style="color: var(--up);">Credit</div>
    <div class="figure stat-value" style="color: var(--up);">€0.00</div>
  </div>
</section>

{#if rows.length === 0}
  <div class="empty">
    <p class="display" style="font-size: 18px;">Session is empty</p>
    <p style="font-size: 13px; color: var(--paper-300); margin-top: 6px;">
      Cards you scan in the Scan tab build up here, with cash &amp; credit offers calculated against the sliders.
    </p>
    <a href="/scan" class="btn">Add a card</a>
  </div>
{:else}
  <ul class="rows">
    {#each rows as r}
      <li class="row">
        <span class="display">{r.name}</span>
        <span class="figure" style="color: var(--paper-300);">{r.setCode} · #{r.number}</span>
        <span class="figure" style="text-align:right;">€{r.market.toFixed(2)}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .sliders { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
  .slider-row {
    display: grid;
    grid-template-columns: 70px 1fr 140px;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
  }
  .label {
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  input[type='range'] { width: 100%; }
  .value { font-size: 13px; text-align: right; }
  .totals {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 16px;
  }
  .stat {
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    padding: 14px 12px;
    text-align: center;
  }
  .stat-value {
    font-size: 22px;
    margin-top: 6px;
    color: var(--paper-100);
    letter-spacing: -0.02em;
  }
  .empty { text-align: center; padding: 56px 24px; }
  .empty .btn {
    display: inline-block;
    margin-top: 14px;
    padding: 8px 14px;
    background: var(--ink-300);
    color: var(--paper-100);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    text-decoration: none;
    font-size: 13px;
  }
  .empty .btn:hover { background: var(--ink-400); }
  .rows { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    padding: 10px 12px;
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    align-items: baseline;
  }
</style>
