<script lang="ts">
  // Admin landing — links to overview, users, arbitrage. Sub-pages port in week 4.
</script>

<svelte:head>
  <title>Admin · Card Pricer</title>
</svelte:head>

<h1 class="display" style="font-size: 26px; margin-bottom: 16px;">Admin</h1>
<ul style="list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px;">
  <li><a href="/admin/arbitrage" class="link">US↔EU arbitrage finder</a></li>
  <li><span style="color: var(--paper-400);">Overview, users, plan breakdown — week 4</span></li>
</ul>

<style>
  .link {
    display: inline-block;
    padding: 10px 14px;
    background: var(--ink-200);
    border: 1px solid var(--hairline);
    border-radius: var(--r-2);
    color: var(--paper-100);
    text-decoration: none;
    font-size: 13px;
    transition: background var(--t-fast) var(--ease);
  }
  .link:hover { background: var(--ink-300); border-color: var(--ink-500); }
</style>
