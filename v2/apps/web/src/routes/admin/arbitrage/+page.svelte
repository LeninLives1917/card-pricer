<script lang="ts">
  // US/EU arbitrage finder — backed by the card_prices Postgres table.
  // Form posts to /api/admin/arbitrage. Results render as hairline rows
  // matching v1's editorial-terminal styling.
  import { supabaseAuthHeader } from '$lib/client/auth.js';

  let direction = $state<'us_to_eu' | 'eu_to_us'>('us_to_eu');
  let minSrcPrice = $state(5);
  let threshold = $state(1.3);
  let variant = $state<'auto' | 'normal' | 'holofoil' | 'reverseHolofoil'>('auto');
  let sortBy = $state<'ratio' | 'spread'>('ratio');
  let liquidity = $state<'any' | 'active' | 'strong'>('any');
  let limit = $state(100);
  let scanning = $state(false);
  let refreshing = $state(false);
  let status = $state<{ msg: string; tone: 'dim' | 'green' | 'amber' | 'red' }>({ msg: '', tone: 'dim' });
  type Row = {
    key: string;
    name: string;
    setName: string;
    setCode: string;
    number: string;
    variant: string;
    image: string | null;
    usd: number;
    eur: number;
    usdInEur: number;
    ratio: number;
    spread: number;
    spreadCurrency: 'EUR' | 'USD';
    cmAvg30: number;
    cardmarketUrl: string | null;
    tcgplayerUrl: string | null;
  };
  let rows = $state<Row[]>([]);

  async function scan() {
    scanning = true;
    status = { msg: 'Scanning…', tone: 'dim' };
    try {
      const r = await fetch('/api/admin/arbitrage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await supabaseAuthHeader()) },
        body: JSON.stringify({
          direction,
          minSrcPrice,
          threshold,
          variant,
          sortBy,
          liquidity,
          limit,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        status = { msg: (err as { message?: string }).message ?? `Scan failed (${r.status})`, tone: 'red' };
        rows = [];
        return;
      }
      const data = (await r.json()) as { cardsPriced: number; matched: number; rate: number; results: Row[] };
      rows = data.results;
      status = {
        msg: `${data.cardsPriced.toLocaleString()} priced cards · ${data.matched} matched · USD→EUR ${data.rate.toFixed(4)}`,
        tone: 'dim',
      };
    } catch (e) {
      status = { msg: e instanceof Error ? e.message : 'Network error', tone: 'red' };
    } finally {
      scanning = false;
    }
  }

  let pollHandle: ReturnType<typeof setInterval> | null = null;

  async function refreshPrices() {
    refreshing = true;
    status = { msg: 'Starting refresh — pulling all sets from pokemontcg.io.', tone: 'amber' };
    try {
      const r = await fetch('/api/admin/refresh-prices', {
        method: 'POST',
        headers: await supabaseAuthHeader(),
      });
      if (!r.ok) {
        status = { msg: `Refresh failed (${r.status})`, tone: 'red' };
        refreshing = false;
        return;
      }
      if (pollHandle) clearInterval(pollHandle);
      pollHandle = setInterval(async () => {
        try {
          const sr = await fetch('/api/admin/refresh-status', { headers: await supabaseAuthHeader() });
          if (!sr.ok) return;
          const s = (await sr.json()) as { loading: boolean; cardsPriced: number; cardsTotal: number };
          if (s.loading) {
            status = {
              msg: `Refreshing… ${s.cardsPriced.toLocaleString()} priced (of ~${s.cardsTotal.toLocaleString()}).`,
              tone: 'amber',
            };
          } else {
            if (pollHandle) clearInterval(pollHandle);
            pollHandle = null;
            status = {
              msg: `Refresh complete: ${s.cardsPriced.toLocaleString()} priced cards.`,
              tone: 'green',
            };
            refreshing = false;
          }
        } catch {
          /* poll silently */
        }
      }, 10_000);
    } catch (e) {
      status = { msg: e instanceof Error ? e.message : 'Network error', tone: 'red' };
      refreshing = false;
    }
  }
</script>

<svelte:head>
  <title>Arbitrage · Admin</title>
</svelte:head>

<h1 class="display" style="font-size: 26px; margin-bottom: 6px;">US → EU arbitrage finder</h1>
<p style="color: var(--paper-300); font-size: 12px; margin-bottom: 16px;">
  English Pokémon cards priced cheaper in one market vs the other. Raw price comparison — no shipping factor.
</p>

<div class="form">
  <label>Direction
    <select bind:value={direction}>
      <option value="us_to_eu">US → EU (cheap in US)</option>
      <option value="eu_to_us">EU → US (cheap in EU)</option>
    </select>
  </label>
  <label>Min source price
    <input type="number" min="0" step="0.5" bind:value={minSrcPrice} />
    <span class="unit">{direction === 'eu_to_us' ? '€' : '$'}</span>
  </label>
  <label>Threshold (dst ≥ src ×)
    <input type="range" min="1.10" max="2.00" step="0.05" bind:value={threshold} />
    <span class="figure" style="color: var(--accent-soft);">{threshold.toFixed(2)}</span>
  </label>
  <label>Variant
    <select bind:value={variant}>
      <option value="auto">Auto (best spread)</option>
      <option value="normal">Normal</option>
      <option value="holofoil">Holofoil</option>
      <option value="reverseHolofoil">Reverse holo</option>
    </select>
  </label>
  <label>Sort by
    <select bind:value={sortBy}>
      <option value="ratio">Ratio (biggest %)</option>
      <option value="spread">Spread (biggest absolute)</option>
    </select>
  </label>
  <label>Liquidity
    <select bind:value={liquidity}>
      <option value="any">Any</option>
      <option value="active">Active (EU sold last 7d)</option>
      <option value="strong">Strong (active + tight US)</option>
    </select>
  </label>
  <label>Limit
    <input type="number" min="10" max="500" bind:value={limit} />
  </label>
</div>

<div class="actions">
  <button class="btn primary" disabled={scanning} onclick={scan}>{scanning ? 'Scanning…' : 'Scan'}</button>
  <button class="btn secondary" disabled={refreshing} onclick={refreshPrices}>
    {refreshing ? 'Refreshing prices…' : 'Refresh prices (~5 min)'}
  </button>
</div>

<p class="status status-{status.tone}">{status.msg}</p>

<section class="rows">
  {#each rows as r}
    <div class="row">
      {#if r.image}
        <img src={r.image} alt="" loading="lazy" />
      {:else}
        <div class="thumb-empty"></div>
      {/if}
      <div class="meta">
        <div class="display name">{r.name}</div>
        <div class="figure sub">{r.setCode} · #{r.number} · <span class="vbadge">{r.variant}</span></div>
      </div>
      <div class="prices">
        <div class="figure {direction === 'us_to_eu' ? 'src' : 'dst'}">${r.usd.toFixed(2)}</div>
        <div class="figure {direction === 'us_to_eu' ? 'dst' : 'src'}">€{r.eur.toFixed(2)}</div>
      </div>
      <div class="ratio-cell">
        <span class="figure ratio">×{r.ratio.toFixed(2)}</span>
        <span class="figure spread">+{r.spreadCurrency === 'USD' ? '$' : '€'}{r.spread.toFixed(2)}</span>
      </div>
      <div class="links">
        {#if r.tcgplayerUrl}<a class="link" href={r.tcgplayerUrl} target="_blank" rel="noopener">TCGplayer</a>{/if}
        {#if r.cardmarketUrl}<a class="link" href={r.cardmarketUrl} target="_blank" rel="noopener">Cardmarket</a>{/if}
      </div>
    </div>
  {/each}
</section>

<style>
  .form { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; margin-bottom: 16px; }
  @media (min-width: 720px) { .form { grid-template-columns: repeat(4, 1fr); } }
  .form label {
    display: flex; flex-direction: column; gap: 4px;
    font-size: 11px; color: var(--paper-300);
    letter-spacing: 0.06em; text-transform: uppercase; font-weight: 500;
  }
  .form select, .form input {
    background: var(--ink-300);
    border: 1px solid var(--hairline);
    border-radius: var(--r-1);
    color: var(--paper-100);
    padding: 7px 10px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 13px;
    text-transform: none;
  }
  .form input[type='number'] { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .unit { font-size: 11px; color: var(--paper-400); margin-top: 4px; }
  .actions { display: flex; gap: 8px; margin-bottom: 12px; }
  .btn { padding: 9px 14px; border-radius: var(--r-2); border: 0; font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 13px; font-weight: 600; cursor: pointer; transition: background var(--t-fast) var(--ease); }
  .btn.primary { background: var(--accent); color: var(--ink-100); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-soft); }
  .btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.secondary { background: var(--ink-300); color: var(--paper-100); border: 1px solid var(--hairline); }
  .btn.secondary:hover:not(:disabled) { background: var(--ink-400); }
  .status { font-size: 11px; min-height: 14px; margin-bottom: 16px; }
  .status-dim { color: var(--paper-300); }
  .status-green { color: var(--up); }
  .status-amber { color: var(--accent-soft); }
  .status-red { color: var(--down); }
  .rows { display: flex; flex-direction: column; gap: 4px; }
  .row { display: grid; grid-template-columns: 44px 1fr auto auto auto; gap: 12px; align-items: center; padding: 10px 12px; background: var(--ink-200); border: 1px solid var(--hairline); border-radius: var(--r-2); }
  .row img, .thumb-empty { width: 44px; height: 61px; border-radius: var(--r-1); object-fit: cover; background: var(--ink-300); }
  .meta { min-width: 0; }
  .name { font-size: 16px; color: var(--paper-100); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 11px; color: var(--paper-300); margin-top: 3px; }
  .vbadge { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 9px; padding: 1px 6px; background: var(--ink-300); border: 1px solid var(--hairline); border-radius: var(--r-1); letter-spacing: 0.06em; text-transform: uppercase; }
  .prices { display: flex; flex-direction: column; gap: 2px; text-align: right; min-width: 76px; }
  .prices .src { color: var(--paper-300); }
  .prices .dst { color: var(--paper-100); font-weight: 500; }
  .ratio-cell { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; padding: 4px 10px; background: var(--up-soft); border-radius: var(--r-1); min-width: 76px; }
  .ratio { font-size: 15px; font-weight: 500; color: var(--up); letter-spacing: -0.02em; }
  .spread { font-size: 10px; color: var(--paper-300); letter-spacing: 0.02em; }
  .links { display: flex; flex-direction: column; gap: 4px; }
  .link { font-size: 10px; padding: 4px 8px; border-radius: var(--r-1); background: var(--ink-300); border: 1px solid var(--hairline); color: var(--paper-200); text-decoration: none; font-weight: 500; letter-spacing: 0.02em; transition: background var(--t-fast) var(--ease); }
  .link:hover { background: var(--ink-400); color: var(--paper-100); }
</style>
