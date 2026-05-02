<script lang="ts">
  // Customer quote tool — port of v1's quote.html. Editorial layout (Fraunces
  // display + Plex Sans body + Plex Mono figures). Server pre-loads shop
  // branding so initial paint is themed correctly.
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const DEFAULT_CASH_PCT = 55;
  const DEFAULT_CREDIT_PCT = 70;
  const CONDITION_MULTS: Record<string, number> = {
    NM: 1.0,
    LP: 0.85,
    MP: 0.7,
    HP: 0.5,
    DMG: 0.3,
  };

  const shop = data.shop;
  const embed = data.embed;
  const cashPct = $derived(shop?.cash_pct ?? DEFAULT_CASH_PCT);
  const creditPct = $derived(shop?.credit_pct ?? DEFAULT_CREDIT_PCT);
  const showNewsletter = $derived(shop?.newsletter_show !== false);
  const accent = $derived(shop?.accent_color ?? '#d97706');
  const shopName = $derived(shop?.name ?? 'Board & Brewed');

  type CardLine = {
    raw: string;
    set_code: string;
    card_number: string;
    name: string;
  };
  type ResultEntry =
    | { kind: 'priced'; line: CardLine; card: any; market: number; cash: number; credit: number }
    | { kind: 'error'; line: CardLine; message: string };

  let game = $state('pokemon');
  let cardInput = $state('');
  let running = $state(false);
  let progress = $state({ done: 0, total: 0 });
  let results = $state<ResultEntry[]>([]);
  let resultsPanelVisible = $state(false);
  let locked = $state(true);
  let leadEmail = $state('');
  let leadName = $state('');
  let leadNewsletter = $state(false);
  let submitting = $state(false);
  let successMessage = $state<string | null>(null);
  let leadError = $state<string | null>(null);

  const totals = $derived.by(() => {
    let market = 0;
    let cash = 0;
    let credit = 0;
    for (const r of results) {
      if (r.kind !== 'priced') continue;
      market += r.market;
      cash += r.cash;
      credit += r.credit;
    }
    return { market, cash, credit };
  });

  function parseLines(raw: string): CardLine[] {
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
      .slice(0, 20)
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length === 1) {
          return {
            raw: line,
            set_code: '',
            card_number: parts[0]?.split('/')[0] ?? '',
            name: '',
          };
        }
        const set_code = parts[0] ?? '';
        const card_number = (parts[1] ?? '').split('/')[0] ?? '';
        const name = parts.slice(2).join(' ');
        return { raw: line, set_code, card_number, name };
      });
  }

  async function lookupCard(line: CardLine) {
    const r = await fetch('/api/identify-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game,
        set_code: line.set_code || undefined,
        card_number: line.card_number,
        name: line.name || undefined,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? `Not found (${r.status})`);
    }
    const data = (await r.json()) as { cards?: unknown[] };
    if (!data.cards || data.cards.length === 0) throw new Error('Card not found');
    return data.cards[0] as { name?: string; set_code?: string; set_name?: string; card_number?: string; condition_estimate?: string };
  }

  async function priceCard(card: unknown) {
    const r = await fetch('/api/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card, buyPercentage: cashPct }),
    });
    if (!r.ok) return null;
    return (await r.json()) as { market_value?: number; card?: any; cardmarket?: { price?: number; trend?: number } };
  }

  async function startProcessing() {
    if (running) return;
    const lines = parseLines(cardInput);
    if (!lines.length) {
      alert('Enter at least one card — e.g. MEG 133');
      return;
    }
    running = true;
    results = [];
    resultsPanelVisible = false;
    locked = true;
    successMessage = null;
    progress = { done: 0, total: lines.length };

    for (const line of lines) {
      try {
        const card = await lookupCard(line);
        const priced = await priceCard(card);
        const mv =
          priced?.market_value ??
          priced?.cardmarket?.price ??
          priced?.cardmarket?.trend ??
          0;
        const finalCard = priced?.card ?? card;
        const condMult =
          CONDITION_MULTS[(card as { condition_estimate?: string }).condition_estimate ?? 'NM'] ?? 1;
        const effective = mv * condMult;
        results = [
          ...results,
          {
            kind: 'priced',
            line,
            card: finalCard,
            market: mv,
            cash: Math.round(effective * (cashPct / 100) * 100) / 100,
            credit: Math.round(effective * (creditPct / 100) * 100) / 100,
          },
        ];
      } catch (e) {
        results = [
          ...results,
          { kind: 'error', line, message: e instanceof Error ? e.message : String(e) },
        ];
      }
      progress = { done: progress.done + 1, total: lines.length };
    }
    running = false;
    if (results.length) resultsPanelVisible = true;
  }

  async function submitLead() {
    leadError = null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) {
      leadError = 'Please enter a valid email.';
      return;
    }
    const priced = results.filter((r): r is Extract<ResultEntry, { kind: 'priced' }> => r.kind === 'priced');
    if (!priced.length) {
      leadError = 'No priced cards to send.';
      return;
    }
    submitting = true;
    try {
      const r = await fetch('/api/quote-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: leadEmail,
          name: leadName || null,
          newsletter: leadNewsletter,
          cards: priced.map((p) => ({
            name: p.card?.name ?? 'Unknown',
            set_code: p.card?.set_code ?? null,
            card_number: p.card?.card_number ?? null,
            condition_estimate: p.card?.condition_estimate ?? null,
            market_value: p.market,
            cash_offer: p.cash,
            credit_offer: p.credit,
          })),
          totals,
          cashPct,
          creditPct,
          shop_slug: data.shopSlug,
        }),
      });
      if (!r.ok) throw new Error(`Server rejected quote (${r.status})`);
      const result = (await r.json()) as { ok?: boolean; emailed?: boolean };
      locked = false;
      successMessage = result.emailed
        ? leadNewsletter
          ? 'Quote unlocked & emailed. Welcome to the list!'
          : 'Quote unlocked & emailed — check your inbox.'
        : 'Quote unlocked. We’ll be in touch shortly.';

      // postMessage to parent widget if we're embedded.
      if (embed && window.parent !== window) {
        try {
          window.parent.postMessage({ type: 'cp:submitted', shop: data.shopSlug }, '*');
        } catch {
          /* noop */
        }
      }
    } catch (e) {
      leadError = e instanceof Error ? e.message : 'Network error.';
    } finally {
      submitting = false;
    }
  }

  function closeEmbed() {
    if (window.parent !== window) {
      try {
        window.parent.postMessage({ type: 'cp:close' }, '*');
      } catch {
        /* noop */
      }
    }
  }
</script>

<svelte:head>
  <title>Get a Quote — {shopName}</title>
  <meta name="description" content="Enter your trading card details and get an instant indicative cash or store-credit offer." />
</svelte:head>

<div
  class="wrap"
  style:padding={embed ? '12px 12px 32px' : undefined}
  style="--shop-accent: {accent};"
>
  {#if !embed}
    <div class="brand">
      <div class="brand-logo" aria-hidden="true">
        {#if shop?.logo_url}
          <img src={shop.logo_url} alt={`${shopName} logo`} />
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" width="56" height="56">
            <rect width="56" height="56" rx="12" fill="#1c1917" />
            <rect x="14" y="10" width="28" height="36" rx="4" fill="none" stroke="var(--shop-accent)" stroke-width="2" />
          </svg>
        {/if}
      </div>
      <div>
        <div class="brand-name">{shopName}</div>
        <div class="brand-tag">Card Buying Desk</div>
      </div>
    </div>
  {/if}

  <h1>
    Get an <span class="accent">instant quote</span> on your cards
  </h1>
  <p class="sub">
    Type the set code and card number from each card you'd like to sell or trade in. We'll price them against live market data and email you an offer.
  </p>

  <!-- Input -->
  <div class="panel" id="inputPanel">
    <div class="entry-section">
      <label for="gameSelect">Game</label>
      <select id="gameSelect" bind:value={game}>
        <option value="pokemon">Pokémon</option>
        <option value="magic">Magic: The Gathering</option>
        <option value="yugioh">Yu-Gi-Oh!</option>
        <option value="lorcana">Lorcana</option>
        <option value="onepiece">One Piece</option>
        <option value="starwars">Star Wars Unlimited</option>
        <option value="digimon">Digimon</option>
        <option value="fleshandblood">Flesh and Blood</option>
        <option value="dragonball">Dragon Ball Super</option>
      </select>
    </div>

    <div class="entry-section">
      <label for="cardInput">Your cards (one per line, up to 20)</label>
      <textarea id="cardInput" bind:value={cardInput} placeholder="MEG 133&#10;PFL 94&#10;TWM 200" disabled={running}></textarea>
      <div class="format-hint">
        Format: <code>SET NUMBER</code> — e.g. <code>MEG 133</code> or <code>TWM 200</code>.<br />
        Don't know the set? Just enter the number: <code>133</code>.
      </div>
    </div>

    {#if running}
      <div class="progress-wrap">
        <div class="progress-bar" style:width={`${(progress.done / Math.max(progress.total, 1)) * 100}%`}></div>
      </div>
      <div class="progress-label">{progress.done} / {progress.total}</div>
    {/if}

    <div class="btn-row">
      <button class="btn primary" disabled={running} onclick={startProcessing}>
        {running ? 'Looking up cards…' : 'Get my quote'}
      </button>
      <button
        class="btn secondary"
        style="flex:0 0 auto; width:auto; padding:12px 16px;"
        disabled={running}
        onclick={() => {
          cardInput = '';
          results = [];
          resultsPanelVisible = false;
          locked = true;
          successMessage = null;
        }}
      >Clear</button>
    </div>

    <p class="note">
      Prices shown are indicative and assume Near Mint condition. Final offer depends on in-person condition check. Cash offer is {cashPct}% of market value, store credit is {creditPct}%. We price off Cardmarket (EU) and Scryfall live data.
    </p>
  </div>

  <!-- Results -->
  {#if resultsPanelVisible}
    <div class="panel results visible" id="resultsPanel">
      <h2 style="margin:0 0 12px;" class="display">Your quote</h2>

      <div class="results-wrap" class:locked>
        <div class="totals">
          <div class="stat">
            <div class="stat-label">Market</div>
            <div class="stat-value">€{totals.market.toFixed(2)}</div>
          </div>
          <div class="stat cash">
            <div class="stat-label">Cash offer</div>
            <div class="stat-value">€{totals.cash.toFixed(2)}</div>
          </div>
          <div class="stat credit">
            <div class="stat-label">Store credit</div>
            <div class="stat-value">€{totals.credit.toFixed(2)}</div>
          </div>
        </div>

        <div class="card-list">
          {#each results as r, i}
            {#if r.kind === 'priced'}
              <div class="card-row">
                <div class="card-icon">{i + 1}</div>
                <div class="card-meta">
                  <div class="card-name">{r.card?.name ?? 'Unknown'}</div>
                  <div class="card-set">
                    {r.card?.set_name ?? r.card?.set_code ?? ''}{r.card?.card_number ? ` · #${r.card.card_number}` : ''}
                  </div>
                </div>
                <div class="card-prices">
                  <div class="row"><span class="label">MV</span><span>€{r.market.toFixed(2)}</span></div>
                  <div class="row"><span class="label">Cash</span><span class="cash">€{r.cash.toFixed(2)}</span></div>
                  <div class="row"><span class="label">Credit</span><span class="credit">€{r.credit.toFixed(2)}</span></div>
                </div>
              </div>
            {:else}
              <div class="card-error-row">
                Could not find: {r.line.raw} ({r.message})
              </div>
            {/if}
          {/each}
        </div>

        {#if locked}
          <div class="gate">
            <div class="gate-inner">
              <div class="gate-title">Enter your email to see your quote</div>
              <p class="gate-sub">
                We'll reveal your prices here and email you a copy so you don't lose it. Bring the cards in to the shop for a firm offer.
              </p>
              <div class="lead-form">
                <input type="text" bind:value={leadName} placeholder="Your name (optional)" autocomplete="name" />
                <input type="email" bind:value={leadEmail} placeholder="you@example.com" autocomplete="email" required />
              </div>
              {#if showNewsletter}
                <div class="checkbox-row">
                  <input id="leadNewsletter" type="checkbox" bind:checked={leadNewsletter} />
                  <label for="leadNewsletter">Keep me posted on new arrivals, tournaments &amp; card buying offers at {shopName}.</label>
                </div>
              {/if}
              <button class="btn primary" disabled={submitting} onclick={submitLead}>
                {submitting ? 'Unlocking…' : 'Unlock my quote'}
              </button>
              {#if leadError}
                <p style="color:var(--down); font-size:12px; margin-top:8px;">{leadError}</p>
              {/if}
              <p class="gate-small">No spam. Unsubscribe anytime.</p>
            </div>
          </div>
        {/if}
      </div>

      {#if successMessage}
        <div class="success-banner">
          {successMessage}
          {#if embed}
            <a href="#" onclick={(e) => { e.preventDefault(); closeEmbed(); }} style="margin-left:8px; color:var(--rare); text-decoration:underline; font-size:12px;">Close ✕</a>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <footer>
    <p>
      Powered by {shopName} · <a href="mailto:hello@cardpricer.app">Contact us</a>
    </p>
  </footer>
</div>

<style>
  /* Per-shop accent override — falls back to --accent if no shop. */
  :global(:root) {
    --shop-accent: var(--accent);
  }
  .accent { color: var(--shop-accent); font-style: italic; }
  .gate { position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: center; padding: 40px 12px; z-index: 5; }
  .gate-inner { width: 100%; max-width: 420px; background: var(--ink-200); border: 1px solid var(--shop-accent); border-radius: var(--r-3); padding: 24px; }
  .gate-title { font-family: 'Fraunces', Georgia, serif; font-size: 22px; font-weight: 600; font-style: italic; letter-spacing: -0.02em; margin: 0 0 6px; color: var(--paper-100); }
  .gate-sub { font-size: 13px; color: var(--paper-300); margin: 0 0 16px; line-height: 1.5; }
  .lead-form input { width: 100%; padding: 12px 14px; border-radius: var(--r-2); border: 1px solid var(--hairline); background: var(--ink-300); color: var(--paper-100); font-size: 14px; margin-bottom: 10px; box-sizing: border-box; transition: border-color var(--t-fast) var(--ease); }
  .lead-form input:focus { outline: none; border-color: var(--shop-accent); }
  .checkbox-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0 16px; }
  .checkbox-row input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--shop-accent); margin-top: 2px; flex-shrink: 0; cursor: pointer; }
  .checkbox-row label { font-size: 13px; color: var(--paper-200); line-height: 1.5; cursor: pointer; }
  .gate-small { font-size: 11px; color: var(--paper-300); margin: 10px 0 0; text-align: center; letter-spacing: 0.02em; }

  .results-wrap { position: relative; }
  .results-wrap.locked .card-list, .results-wrap.locked .totals { filter: blur(8px); pointer-events: none; user-select: none; }

  /* Layout primitives — duplicated subset of app.css to keep the page self-contained. */
  .wrap { max-width: 780px; margin: 0 auto; padding: 24px 16px 96px; }
  .brand { display: flex; align-items: center; gap: 14px; padding: 8px 0 28px; }
  .brand-logo { width: 56px; height: 56px; border-radius: var(--r-2); overflow: hidden; background: var(--ink-300); display: grid; place-items: center; }
  .brand-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .brand-name { font-family: 'Fraunces', Georgia, serif; font-size: 22px; font-weight: 600; font-style: italic; letter-spacing: -0.02em; color: var(--paper-100); }
  .brand-tag { font-size: 11px; color: var(--paper-300); font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 2px; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-size: 32px; margin: 8px 0 12px; line-height: 1.1; font-weight: 600; font-style: italic; letter-spacing: -0.02em; color: var(--paper-100); }
  .sub { color: var(--paper-200); font-size: 15px; margin: 0 0 28px; line-height: 1.55; max-width: 56ch; }
  .panel { background: var(--ink-200); border: 1px solid var(--hairline); border-radius: var(--r-2); padding: 20px; margin-bottom: 16px; }
  .entry-section { margin-bottom: 16px; }
  .entry-section label { display: block; font-size: 11px; font-weight: 500; color: var(--paper-300); margin-bottom: 6px; letter-spacing: 0.06em; text-transform: uppercase; }
  .entry-section select, .entry-section textarea { width: 100%; padding: 11px 14px; border-radius: var(--r-2); border: 1px solid var(--hairline); background: var(--ink-300); color: var(--paper-100); font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 14px; transition: border-color var(--t-fast) var(--ease); }
  .entry-section textarea { min-height: 160px; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 14px; line-height: 1.7; resize: vertical; }
  .entry-section select:focus, .entry-section textarea:focus { outline: none; border-color: var(--shop-accent); }
  .format-hint { font-size: 12px; color: var(--paper-300); margin-top: 8px; line-height: 1.6; }
  .format-hint code { font-family: 'IBM Plex Mono', ui-monospace, monospace; background: var(--ink-300); padding: 1px 6px; border-radius: var(--r-1); font-size: 11px; color: var(--accent-soft); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 20px; border-radius: var(--r-2); border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: background var(--t-fast) var(--ease); width: 100%; letter-spacing: 0.01em; }
  .btn.primary { background: var(--shop-accent); color: var(--ink-100); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-soft); }
  .btn.primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn.secondary { background: var(--ink-300); color: var(--paper-100); border: 1px solid var(--hairline); }
  .btn.secondary:hover { background: var(--ink-400); }
  .btn-row { display: flex; gap: 8px; margin-top: 14px; }
  .progress-wrap { margin-top: 14px; height: 4px; background: var(--ink-300); border-radius: var(--r-1); overflow: hidden; }
  .progress-bar { height: 100%; background: var(--shop-accent); width: 0%; transition: width 0.3s var(--ease); }
  .progress-label { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--paper-300); text-align: center; margin-top: 8px; letter-spacing: 0.04em; }
  .note { font-size: 12px; color: var(--paper-300); line-height: 1.55; padding: 10px 0; }
  .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
  .stat { background: var(--ink-300); border: 1px solid var(--hairline); border-radius: var(--r-2); padding: 14px 12px; text-align: center; }
  .stat-label { font-size: 10px; color: var(--paper-300); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500; }
  .stat-value { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 500; margin-top: 6px; letter-spacing: -0.02em; color: var(--paper-100); }
  .stat.cash .stat-value { color: #f59e0b; }
  .stat.credit .stat-value { color: var(--rare); }
  .stat.credit { border-color: rgba(234,179,8,0.30); }
  .card-list { display: flex; flex-direction: column; gap: 6px; }
  .card-row { display: grid; grid-template-columns: 36px 1fr auto; gap: 12px; align-items: center; padding: 10px; background: var(--ink-300); border-radius: var(--r-2); border: 1px solid var(--hairline); }
  .card-icon { width: 36px; height: 36px; border-radius: var(--r-1); background: var(--ink-200); display: grid; place-items: center; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 13px; color: var(--paper-300); }
  .card-name { font-family: 'Fraunces', Georgia, serif; font-style: italic; font-weight: 600; font-size: 15px; margin-bottom: 2px; color: var(--paper-100); letter-spacing: -0.01em; }
  .card-set { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--paper-300); letter-spacing: 0.02em; }
  .card-prices { text-align: right; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 12px; }
  .card-prices .row { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 1px; align-items: baseline; }
  .card-prices .label { color: var(--paper-300); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500; }
  .cash { color: #f59e0b; font-weight: 500; }
  .credit { color: var(--rare); font-weight: 500; }
  .card-error-row { padding: 10px 12px; background: var(--down-soft); border: 1px solid rgba(220,38,38,0.30); border-radius: var(--r-2); font-size: 13px; color: var(--down); }
  .success-banner { background: var(--rare-soft); border: 1px solid rgba(234,179,8,0.30); color: var(--rare); padding: 12px; border-radius: var(--r-2); text-align: center; margin-bottom: 12px; font-weight: 500; }
  footer { text-align: center; color: var(--paper-300); font-size: 12px; padding: 32px 0 16px; }
  footer a { color: var(--paper-200); text-decoration: none; border-bottom: 1px solid var(--hairline); padding-bottom: 1px; transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease); }
  footer a:hover { color: var(--accent-soft); border-color: var(--shop-accent); }
</style>
