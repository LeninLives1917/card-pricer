<script lang="ts">
  // Root — sends signed-in users to /scan, signed-out to a marketing page.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();

  onMount(() => {
    if (data.user) {
      goto('/scan', { replaceState: true });
    }
  });
</script>

<svelte:head>
  <title>Card Pricer</title>
</svelte:head>

<div style="padding: 48px 0; max-width: 720px;">
  <h1 class="display" style="font-size: 40px; line-height: 1.1; margin-bottom: 12px;">
    Real-time pricing for trading-card shops.
  </h1>
  <p style="color: var(--paper-200); font-size: 15px; line-height: 1.55; max-width: 56ch;">
    Scan a card, get cash + credit offers in under a second. Track inventory through to sale. Embed a customer quote tool on your website.
  </p>
  <div style="display: flex; gap: 12px; margin-top: 24px;">
    <a href="/scan" class="header-btn" style="font-size: 14px; font-weight: 600; padding: 10px 16px; background: var(--accent); color: var(--ink-100); border: 0;">Open the app</a>
    <a href="/quote" class="header-btn" style="font-size: 14px; padding: 10px 16px;">See the customer flow →</a>
  </div>
</div>

<style>
  .header-btn {
    background: var(--ink-300);
    border: 1px solid var(--hairline);
    color: var(--paper-100);
    border-radius: var(--r-2);
    text-decoration: none;
    transition: background var(--t-fast) var(--ease);
  }
  .header-btn:hover { background: var(--ink-400); }
</style>
