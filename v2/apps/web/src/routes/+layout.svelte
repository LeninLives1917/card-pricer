<script lang="ts">
  import '@card-pricer/design/tokens.css';
  import './app.css';
  import { page } from '$app/state';
  import type { LayoutData } from './$types';
  let { children, data }: { children: unknown; data: LayoutData } = $props();

  // Only the vendor app's main routes get the tab nav.
  // /quote and embed iframe paths render bare.
  const showShell = $derived.by(() => {
    const p = page.url.pathname;
    if (p === '/quote' || p.startsWith('/quote')) return false;
    return true;
  });

  const tabs = [
    { href: '/scan', label: 'Scan' },
    { href: '/log', label: 'Log' },
    { href: '/inventory', label: 'Inventory' },
    { href: '/settings', label: 'Settings' },
    { href: '/admin', label: 'Admin', adminOnly: true },
  ];
</script>

{#if showShell}
  <header class="header">
    <h1>Card Pricer <span class="figure" style="font-size:11px; color:var(--paper-300); font-style:normal; letter-spacing:0.06em; margin-left:8px;">V2</span></h1>
    <div class="header-actions">
      {#if data.user}
        <span class="figure" style="font-size:11px; color:var(--paper-300);">{data.user.email ?? 'signed in'}</span>
      {:else}
        <a href="/scan" class="header-btn">Sign in</a>
      {/if}
    </div>
  </header>
  <nav class="tabs">
    {#each tabs as tab}
      <a
        href={tab.href}
        class="tab"
        class:active={page.url.pathname.startsWith(tab.href)}
      >{tab.label}</a>
    {/each}
  </nav>
  <main>
    {@render (children as any)?.()}
  </main>
{:else}
  {@render (children as any)?.()}
{/if}

<style>
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--ink-200);
    border-bottom: 1px solid var(--hairline);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header h1 {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 18px;
    font-weight: 600;
    font-style: italic;
    letter-spacing: -0.01em;
    color: var(--paper-100);
  }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .header-btn {
    background: var(--ink-300);
    border: 1px solid var(--hairline);
    color: var(--paper-100);
    padding: 7px 12px;
    border-radius: var(--r-2);
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
  }
  .tabs {
    display: flex;
    background: var(--ink-200);
    border-bottom: 1px solid var(--hairline);
    padding: 0 8px;
    position: sticky;
    top: 57px;
    z-index: 99;
  }
  .tab {
    flex: 1;
    padding: 12px 4px;
    text-align: center;
    font-size: 13px;
    font-weight: 500;
    color: var(--paper-300);
    border-bottom: 2px solid transparent;
    text-decoration: none;
    transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .tab:hover { color: var(--paper-200); }
  .tab.active { color: var(--paper-100); border-bottom-color: var(--accent); }

  main { padding: 24px 16px; max-width: 980px; margin: 0 auto; }
</style>
