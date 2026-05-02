<script lang="ts">
  // Arbitrage finder placeholder. Full Postgres-backed implementation
  // ports in week 4 once card_prices table + refresh job are in place.
</script>

<svelte:head>
  <title>Arbitrage · Admin</title>
</svelte:head>

<h1 class="display" style="font-size: 26px; margin-bottom: 8px;">US → EU arbitrage finder</h1>
<p style="color: var(--paper-300); font-size: 13px; line-height: 1.55; max-width: 56ch; margin-bottom: 16px;">
  English Pokémon cards priced cheaper on TCGplayer than Cardmarket. Backed by the <code>card_prices</code> Postgres table — populated by the refresh job that ports in week 4.
</p>
<div class="hint">Form + virtualised data grid land in week 4.</div>

<style>
  code {
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    background: var(--ink-300);
    padding: 1px 6px;
    border-radius: var(--r-1);
    font-size: 12px;
    color: var(--accent-soft);
  }
  .hint {
    padding: 24px;
    background: var(--ink-200);
    border: 1px dashed var(--hairline);
    border-radius: var(--r-2);
    color: var(--paper-300);
    font-size: 13px;
    text-align: center;
  }
</style>
