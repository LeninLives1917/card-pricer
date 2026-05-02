<script lang="ts">
  // Vendor app shell — week 3 fills this in (tab nav + scan/log/settings/admin).
</script>

<svelte:head>
  <title>Card Pricer</title>
</svelte:head>

<main style="padding: 48px 24px; max-width: 720px; margin: 0 auto;">
  <h1 class="display" style="font-size: 36px; margin-bottom: 8px;">Card Pricer</h1>
  <p style="color: var(--paper-300); font-size: 14px; line-height: 1.6;">
    v2.0 staging. Vendor app surfaces ship in week 3. See <code class="figure" style="background: var(--ink-300); padding: 2px 6px; border-radius: var(--r-1);">V2_PLAN.md</code> for the timeline.
  </p>
  <ul style="margin-top: 24px; list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px;">
    <li><a href="/quote">/quote — customer quote tool (week 2)</a></li>
    <li><a href="/api/health">/api/health</a></li>
  </ul>
</main>
