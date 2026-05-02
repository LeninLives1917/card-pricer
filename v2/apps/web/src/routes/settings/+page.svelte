<script lang="ts">
  // Settings tab — account info, plan picker, embed shop config.
  // Plan picker + Stripe wiring port in week 4 alongside admin endpoints.
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Settings · Card Pricer</title>
</svelte:head>

<section class="group">
  <h3>Account</h3>
  <div class="row">
    <span class="label">Email</span>
    <span class="figure">{data.user?.email ?? '—'}</span>
  </div>
</section>

<section class="group">
  <h3>Embed widget</h3>
  <p class="hint">Configure the customer quote tool that shops embed on their websites. Shop CRUD endpoints port in week 4.</p>
</section>

<section class="group">
  <h3>Pair phone</h3>
  <p class="hint">Real-time multi-operator + paired-phone-as-camera lands in week 6 via Supabase Realtime.</p>
</section>

<style>
  .group {
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    padding: 16px;
    margin-bottom: 12px;
  }
  h3 {
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--paper-300);
    margin-bottom: 12px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
  }
  .label { font-size: 13px; color: var(--paper-200); }
  .hint { font-size: 13px; color: var(--paper-300); line-height: 1.55; }
</style>
