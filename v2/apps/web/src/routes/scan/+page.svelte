<script lang="ts">
  // Scan tab — bulk image upload + text entry. Camera live-OCR is deferred.
  import type { PageData } from './$types';
  import { supabaseAuthHeader } from '$lib/client/auth.js';

  let { data }: { data: PageData } = $props();

  type Mode = 'bulk' | 'text';
  let mode = $state<Mode>('text');

  type LookupResult = { ok: true; card: any; price: any } | { ok: false; line: string; error: string };
  let textInput = $state('');
  let lookups = $state<LookupResult[]>([]);
  let running = $state(false);

  // ---- Bulk upload state ----
  type BulkRow = {
    file: File;
    previewUrl: string;
    status: 'pending' | 'identifying' | 'pricing' | 'done' | 'error';
    cards?: any[];
    price?: any;
    error?: string;
  };
  let bulkRows = $state<BulkRow[]>([]);
  let bulkRunning = $state(false);
  let dragOver = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);

  async function fileToResizedDataUrl(file: File, maxSide = 2000): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.95);
    });
  }

  function addFiles(files: File[] | FileList) {
    const accepted: BulkRow[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      accepted.push({
        file: f,
        previewUrl: URL.createObjectURL(f),
        status: 'pending',
      });
    }
    bulkRows = [...bulkRows, ...accepted];
  }

  function clearBulk() {
    for (const r of bulkRows) URL.revokeObjectURL(r.previewUrl);
    bulkRows = [];
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) addFiles(input.files);
    input.value = '';
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  }

  async function runBulk() {
    if (!bulkRows.length || bulkRunning) return;
    const auth = await supabaseAuthHeader();
    if (!auth.Authorization) {
      alert('Sign in first.');
      return;
    }
    bulkRunning = true;
    for (const row of bulkRows) {
      if (row.status === 'done' || row.status === 'error') continue;
      try {
        row.status = 'identifying';
        bulkRows = [...bulkRows];
        const blob = await fileToResizedDataUrl(row.file);
        const fd = new FormData();
        fd.append('image', blob, row.file.name.replace(/\.[^.]+$/, '') + '.jpg');
        const r = await fetch('/api/identify', { method: 'POST', headers: auth, body: fd });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(`identify ${r.status}${t ? ` — ${t.slice(0, 80)}` : ''}`);
        }
        const j = (await r.json()) as { cards?: any[] };
        row.cards = j.cards ?? [];
        const top = row.cards[0];
        if (!top) {
          row.status = 'error';
          row.error = 'no card matched';
          bulkRows = [...bulkRows];
          continue;
        }
        row.status = 'pricing';
        bulkRows = [...bulkRows];
        const pR = await fetch('/api/price', {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ card: top }),
        });
        row.price = pR.ok ? await pR.json() : null;
        row.status = 'done';
      } catch (e) {
        row.status = 'error';
        row.error = e instanceof Error ? e.message : String(e);
      }
      bulkRows = [...bulkRows];
    }
    bulkRunning = false;
  }

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
    <section
      class="dropzone"
      class:dragOver
      ondragover={(e) => {
        e.preventDefault();
        dragOver = true;
      }}
      ondragleave={() => (dragOver = false)}
      ondrop={onDrop}
      onclick={() => fileInput?.click()}
      role="button"
      tabindex="0"
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') fileInput?.click();
      }}
    >
      <p class="display" style="font-size: 18px; color: var(--paper-100); margin: 0;">Drop card images here</p>
      <p style="color: var(--paper-300); font-size: 13px; margin: 6px 0 0; max-width: 360px; margin-inline: auto;">
        or click to pick. JPG / PNG / HEIC. Each gets resized client-side and sent to Claude Vision for identification.
      </p>
      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        multiple
        onchange={onPick}
        style="display: none;"
      />
    </section>

    {#if bulkRows.length}
      <div style="display: flex; gap: 8px; margin: 12px 0;">
        <button class="btn primary" onclick={runBulk} disabled={bulkRunning}>
          {bulkRunning ? 'Identifying…' : `Identify ${bulkRows.length} card${bulkRows.length === 1 ? '' : 's'}`}
        </button>
        <button class="btn secondary" onclick={clearBulk} disabled={bulkRunning}>Clear</button>
      </div>

      <ul class="bulkList">
        {#each bulkRows as r, i (r.previewUrl)}
          <li class="bulkRow">
            <img src={r.previewUrl} alt="card {i + 1}" />
            <div class="bulkInfo">
              {#if r.status === 'pending'}
                <span class="figure" style="color: var(--paper-300); font-size: 12px;">Queued</span>
              {:else if r.status === 'identifying'}
                <span class="figure" style="color: var(--accent); font-size: 12px;">Identifying…</span>
              {:else if r.status === 'pricing'}
                <span class="figure" style="color: var(--accent); font-size: 12px;">Pricing…</span>
              {:else if r.status === 'done' && r.cards?.[0]}
                <div class="display" style="font-size: 14px;">{r.cards[0].name ?? 'Unknown'}</div>
                <div class="figure" style="font-size: 11px; color: var(--paper-300);">
                  {r.cards[0].set_code ?? r.cards[0].setCode ?? ''} · #{r.cards[0].card_number ?? r.cards[0].number ?? ''}
                </div>
                {#if r.price?.market_value != null}
                  <div class="figure" style="font-size: 14px; color: var(--paper-100); margin-top: 2px;">
                    €{Number(r.price.market_value).toFixed(2)}
                  </div>
                {/if}
              {:else if r.status === 'error'}
                <span class="figure" style="color: var(--down); font-size: 12px;">{r.error ?? 'failed'}</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
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

  .dropzone {
    border: 2px dashed var(--hairline);
    border-radius: var(--r-2);
    padding: 56px 24px;
    text-align: center;
    cursor: pointer;
    transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
    background: var(--ink-200);
  }
  .dropzone:hover { border-color: var(--accent); }
  .dropzone.dragOver { border-color: var(--accent); background: var(--ink-300); }
  .bulkList { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .bulkRow {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 12px;
    align-items: center;
    padding: 8px;
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
  }
  .bulkRow img {
    width: 56px;
    height: 78px;
    object-fit: cover;
    border-radius: var(--r-1);
    background: var(--ink-300);
  }
  .bulkInfo { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
</style>
