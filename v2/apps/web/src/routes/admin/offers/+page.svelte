<script lang="ts">
  // Vendor-side: compose + send a quote_offer to a customer.
  // Customer follows the email link to /account/offer/[token] to accept/decline.
  import { onMount } from 'svelte';
  import { supabaseAuthHeader } from '$lib/client/auth.js';

  type LineItem = { name: string; price: number };
  type RecentOffer = {
    id: string;
    customer_email: string;
    total_eur: number;
    status: 'open' | 'accepted' | 'declined' | 'expired';
    created_at: string;
    accept_token: string;
    line_items: LineItem[];
  };

  let customerEmail = $state('');
  let customerName = $state('');
  let lineItems = $state<LineItem[]>([{ name: '', price: 0 }]);
  let expiresInDays = $state(7);
  let working = $state(false);
  let result = $state<null | { ok: true; accept_url: string; email_sent: boolean; email_error: string | null }>(null);
  let error = $state<string | null>(null);
  let recent = $state<RecentOffer[]>([]);

  const total = $derived(lineItems.reduce((s, li) => s + (Number(li.price) || 0), 0));
  const canSubmit = $derived(
    customerEmail.includes('@') &&
      lineItems.length > 0 &&
      lineItems.every((li) => li.name.trim() && Number(li.price) >= 0),
  );

  function addRow() {
    lineItems = [...lineItems, { name: '', price: 0 }];
  }
  function removeRow(idx: number) {
    lineItems = lineItems.filter((_, i) => i !== idx);
    if (lineItems.length === 0) lineItems = [{ name: '', price: 0 }];
  }

  async function loadRecent() {
    try {
      const auth = await supabaseAuthHeader();
      if (!auth) return;
      const r = await fetch('/api/offers', { headers: auth });
      if (!r.ok) return;
      const j = (await r.json()) as { offers: RecentOffer[] };
      recent = j.offers;
    } catch {
      /* ignore */
    }
  }

  async function send() {
    error = null;
    result = null;
    working = true;
    try {
      const auth = await supabaseAuthHeader();
      if (!auth) {
        error = 'Sign in first.';
        return;
      }
      const r = await fetch('/api/offers', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_email: customerEmail.trim(),
          customer_name: customerName.trim() || null,
          line_items: lineItems.map((li) => ({ name: li.name.trim(), price: Number(li.price) })),
          expires_in_days: Number(expiresInDays) || 7,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        error = j.message ?? `Failed (${r.status})`;
        return;
      }
      result = (await r.json()) as typeof result;
      lineItems = [{ name: '', price: 0 }];
      customerEmail = '';
      customerName = '';
      await loadRecent();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Network error';
    } finally {
      working = false;
    }
  }

  onMount(loadRecent);
</script>

<svelte:head>
  <title>Send offer · Card Pricer</title>
</svelte:head>

<h2 class="display" style="font-size:22px; margin-bottom:6px;">Send offer</h2>
<p style="color: var(--paper-300); font-size:13px; margin-top:0;">
  Email a customer a link they can click to accept or decline a firm cash/credit offer.
</p>

<div class="grid">
  <section class="panel">
    <h3 class="display">Compose</h3>
    <div class="field">
      <label for="email">Customer email</label>
      <input id="email" type="email" bind:value={customerEmail} placeholder="customer@example.com" />
    </div>
    <div class="field">
      <label for="name">Customer name (optional)</label>
      <input id="name" type="text" bind:value={customerName} />
    </div>

    <div class="field">
      <label>Line items</label>
      <ul class="rows">
        {#each lineItems as li, idx}
          <li class="row">
            <input
              class="li-name"
              type="text"
              placeholder="e.g. Charizard ex 199/197"
              bind:value={li.name}
            />
            <span class="euro">€</span>
            <input
              class="li-price"
              type="number"
              min="0"
              step="0.01"
              bind:value={li.price}
            />
            <button class="x" type="button" onclick={() => removeRow(idx)} aria-label="Remove row">×</button>
          </li>
        {/each}
      </ul>
      <button class="add" type="button" onclick={addRow}>+ Add line</button>
    </div>

    <div class="field">
      <label for="exp">Expires in (days)</label>
      <input id="exp" type="number" min="1" max="60" bind:value={expiresInDays} />
    </div>

    <div class="totalrow">
      <span class="label">Total</span>
      <span class="figure">€{total.toFixed(2)}</span>
    </div>

    <button class="primary" disabled={!canSubmit || working} onclick={send}>
      {working ? 'Sending…' : 'Send offer'}
    </button>

    {#if result}
      <div class="ok">
        <p><strong>Offer created.</strong> {result.email_sent ? 'Email sent.' : 'Email NOT sent (Brevo not configured).'}</p>
        <p style="font-size:12px; color: var(--paper-300); word-break: break-all;">
          Direct link: <a href={result.accept_url} target="_blank" rel="noopener">{result.accept_url}</a>
        </p>
        {#if result.email_error}
          <p style="font-size:12px; color: var(--down);">Email error: {result.email_error}</p>
        {/if}
      </div>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
  </section>

  <section class="panel">
    <h3 class="display">Recent</h3>
    {#if recent.length === 0}
      <p style="color: var(--paper-300); font-size:13px;">No offers yet.</p>
    {:else}
      <ul class="recent">
        {#each recent as o}
          <li class="rec">
            <div>
              <span class="display">{o.customer_email}</span>
              <span class="status status-{o.status}">{o.status}</span>
            </div>
            <div class="figure">€{Number(o.total_eur).toFixed(2)} · {new Date(o.created_at).toLocaleDateString()}</div>
            <a class="link" href="/account/offer/{o.accept_token}" target="_blank" rel="noopener">view</a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @media (min-width: 900px) { .grid { grid-template-columns: 1.2fr 1fr; } }
  .panel { background: var(--ink-200); border: 1px solid var(--hairline); border-radius: var(--r-2); padding: 18px; }
  .panel h3 { margin: 0 0 12px 0; font-size: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  label {
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 11px; font-weight: 500;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--paper-300);
  }
  input {
    background: var(--ink-300); border: 1px solid var(--hairline);
    border-radius: var(--r-1); padding: 8px 10px;
    color: var(--paper-100); font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 13px;
  }
  input:focus { outline: 1px solid var(--accent); }
  .rows { list-style: none; padding: 0; margin: 0 0 8px 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: grid; grid-template-columns: 1fr auto 110px 28px; gap: 6px; align-items: center; }
  .li-name { width: 100%; }
  .li-price { width: 100%; text-align: right; }
  .euro { color: var(--paper-300); font-size: 13px; }
  .x {
    background: var(--ink-300); border: 1px solid var(--hairline);
    color: var(--paper-300); border-radius: var(--r-1);
    width: 28px; height: 28px; cursor: pointer; padding: 0;
  }
  .x:hover { color: var(--down); }
  .add {
    background: transparent; border: 1px dashed var(--hairline);
    color: var(--paper-300); border-radius: var(--r-1);
    padding: 6px 10px; cursor: pointer; font-size: 12px; margin-bottom: 4px;
  }
  .add:hover { color: var(--accent); border-color: var(--accent); }
  .totalrow {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 12px 0; border-top: 1px solid var(--hairline); margin-top: 8px;
  }
  .totalrow .label { color: var(--paper-300); }
  .totalrow .figure { font-size: 18px; color: var(--paper-100); }
  .primary {
    width: 100%; padding: 12px; background: var(--accent);
    color: var(--ink-100); border: 0; border-radius: var(--r-2);
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-weight: 600; font-size: 14px; cursor: pointer;
    transition: background var(--t-fast) var(--ease);
  }
  .primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .primary:hover:not(:disabled) { background: #b45309; }
  .ok { margin-top: 12px; padding: 10px; background: var(--up-soft); border: 1px solid rgba(22,163,74,0.3); border-radius: var(--r-1); font-size: 13px; }
  .err { color: var(--down); font-size: 12px; margin-top: 8px; }
  .recent { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .rec { padding: 10px; background: var(--ink-300); border-radius: var(--r-1); display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; }
  .status {
    display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .status-open { background: var(--ink-400); color: var(--paper-300); }
  .status-accepted { background: var(--up-soft); color: var(--up); }
  .status-declined { background: var(--down-soft); color: var(--down); }
  .status-expired { background: var(--ink-400); color: var(--paper-300); }
  .link { color: var(--accent); text-decoration: none; font-size: 12px; }
  .link:hover { text-decoration: underline; }
</style>
