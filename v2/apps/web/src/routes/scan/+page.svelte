<script lang="ts">
  // Scan tab — bulk upload + text entry. Camera path is a separate phone-paired
  // flow (week 6 wires Supabase Realtime; for now scan via text or upload).
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Mode = 'bulk' | 'text';
  let mode = $state<Mode>('text');

  type LookupResult = { ok: true; card: any; price: any } | { ok: false; line: string; error: string };
  let textInput = $state('');
  let lookups = $state<LookupResult[]>([]);
  let running = $state(false);

  async function runText() {
    const lines = textInput
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .slice(0, 50);
    if (!lines.length) return;
    running = true;
    lookups = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const set_code = parts.length > 1 ? parts[0] : '';
      const card_number = (parts.length > 1 ? parts[1] : parts[0]) ?? '';
      try {
        const idR = await fetch('/api/identify-manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: 'pokemon', set_code, card_number }),
        });
        if (!idR.ok) throw new Error(`identify ${idR.status}`);
        const id = (await idR.json()) as { cards?: any[] };
        const card = id.cards?.[0];
        if (!card) throw new Error('not found');
        const pR = await fetch('/api/price', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card }),
        });
        const price = pR.ok ? await pR.json() : null;
        lookups = [...lookups, { ok: true, card, price }];
      } catch (e) {
        lookups = [
          ...lookups,
          { ok: false, line, error: e instanceof Error ? e.message : String(e) },
        ];
      }
    }
    running = false;
  }
</script>

<svelte:head>
  <title>Scan · Card Pricer</title>
</svelte:head>

{#if !data.user}
  <div class="empty">
    <p class="display" style="font-size: 22px;">You need to be signed in to scan.</p>
    <p style="color: var(--paper-300); font-size: 13px; margin-top: 6px;">Use your existing vendor account.</p>
    <a href="/login" class="btn primary" style="margin-top: 14px; display: inline-block; text-decoration: none;">Sign in</a>
  </div>
{:else}
  <div class="mode-toggle" role="tablist">
    <button class:active={mode === 'text'} onclick={() => (mode = 'text')}>Text entry</button>
    <button class:active={mode === 'bulk'} onclick={() => (mode = 'bulk')}>Bulk upload</button>
  </div>

  {#if mode === 'text'}
    <section class="panel">
      <label for="ti">Cards (one per line)</label>
      <textarea id="ti" bind:value={textInput} placeholder="MEG 133&#10;PFL 94" disabled={running}></textarea>
      <div style="display: flex; gap: 8px; margin-top: 12px;">
        <button class="btn primary" onclick={runText} disabled={running}>
          {running ? 'Looking up…' : 'Look up all'}
        </button>
        <button class="btn secondary" onclick={() => (textInput = '')} disabled={running}>Clear</button>
      </div>
    </section>

    {#if lookups.length}
      <section class="results">
        {#each lookups as r}
          {#if r.ok}
            <div class="row">
              <div class="display" style="font-size: 16px;">{r.card.name ?? 'Unknown'}</div>
              <div class="figure" style="font-size: 11px; color: var(--paper-300);">
                {r.card.set_code ?? ''} · #{r.card.card_number ?? ''}
              </div>
              <div class="figure" style="text-align: right; font-size: 14px; color: var(--paper-100);">
                €{(r.price?.market_value ?? 0).toFixed(2)}
              </div>
            </div>
          {:else}
            <div class="row error">
              <div>Could not look up: <code class="figure">{r.line}</code></div>
              <div class="figure" style="font-size: 11px; color: var(--down);">{r.error}</div>
            </div>
          {/if}
        {/each}
      </section>
    {/if}
  {:else}
    <section class="panel" style="text-align: center; padding: 48px 24px;">
      <p class="display" style="font-size: 18px; color: var(--paper-100);">Bulk upload</p>
      <p style="color: var(--paper-300); font-size: 13px; margin-top: 8px; max-width: 360px; margin-inline: auto;">
        Drag-drop card images here. Identification via Anthropic vision wires up in this week's
        identify endpoint port. UI in place; full flow lights up when /api/identify lands.
      </p>
    </section>
  {/if}
{/if}

<style>
  .empty { text-align: center; padding: 64px 16px; }
  .mode-toggle {
    display: flex;
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    overflow: hidden;
    margin-bottom: 16px;
  }
  .mode-toggle button {
    flex: 1;
    padding: 10px;
    background: transparent;
    border: 0;
    color: var(--paper-300);
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  }
  .mode-toggle button:hover { color: var(--paper-200); }
  .mode-toggle button.active { background: var(--accent-mute); color: var(--accent-soft); }
  .panel {
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    padding: 20px;
    margin-bottom: 16px;
  }
  .panel label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: var(--paper-300);
    margin-bottom: 6px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  textarea {
    width: 100%;
    min-height: 160px;
    padding: 11px 14px;
    border-radius: var(--r-2);
    border: 1px solid var(--hairline);
    background: var(--ink-300);
    color: var(--paper-100);
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    line-height: 1.7;
    resize: vertical;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .btn {
    padding: 10px 16px;
    border-radius: var(--r-2);
    border: 0;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
  }
  .btn.primary { background: var(--accent); color: var(--ink-100); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-soft); }
  .btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.secondary { background: var(--ink-300); color: var(--paper-100); border: 1px solid var(--hairline); }
  .btn.secondary:hover { background: var(--ink-400); }
  .results { display: flex; flex-direction: column; gap: 6px; }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 16px;
    align-items: baseline;
    padding: 10px 12px;
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
  }
  .row.error { background: var(--down-soft); border-color: rgba(220,38,38,0.30); color: var(--down); }
  code { background: var(--ink-300); padding: 1px 5px; border-radius: var(--r-1); font-size: 12px; }
</style>
