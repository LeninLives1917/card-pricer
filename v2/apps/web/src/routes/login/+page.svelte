<script lang="ts">
  import { goto } from '$app/navigation';
  import { getSupabaseClient } from '$lib/client/auth.js';

  let email = $state('');
  let password = $state('');
  let working = $state(false);
  let err = $state<string | null>(null);

  async function signIn() {
    err = null;
    working = true;
    try {
      const sb = getSupabaseClient();
      if (!sb) {
        err = 'Auth not configured. Check PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY.';
        return;
      }
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        err = error.message;
        return;
      }
      // Force a re-load so the layout picks up the new session.
      await goto('/scan', { invalidateAll: true });
    } catch (e) {
      err = e instanceof Error ? e.message : 'Sign-in failed';
    } finally {
      working = false;
    }
  }

  async function magicLink() {
    err = null;
    working = true;
    try {
      const sb = getSupabaseClient();
      if (!sb) {
        err = 'Auth not configured.';
        return;
      }
      const { error } = await sb.auth.signInWithOtp({ email: email.trim() });
      if (error) {
        err = error.message;
        return;
      }
      err = 'Check your email for a magic link.';
    } catch (e) {
      err = e instanceof Error ? e.message : 'Send failed';
    } finally {
      working = false;
    }
  }
</script>

<svelte:head><title>Sign in · Card Pricer</title></svelte:head>

<div class="wrap">
  <h1 class="display" style="font-size: 28px;">Sign in</h1>
  <p style="color: var(--paper-300); font-size: 13px;">Vendor access — use your existing account.</p>

  <form
    class="panel"
    onsubmit={(e) => {
      e.preventDefault();
      void signIn();
    }}
  >
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" bind:value={email} />
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" bind:value={password} />
    </div>
    <button class="primary" disabled={!email || !password || working}>
      {working ? '…' : 'Sign in'}
    </button>
    <button class="link" type="button" disabled={!email || working} onclick={magicLink}>
      Email me a magic link instead
    </button>
    {#if err}<p class="err">{err}</p>{/if}
  </form>
</div>

<style>
  .wrap { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  .panel { background: var(--ink-200); border: 1px solid var(--hairline); border-radius: var(--r-2); padding: 20px; margin-top: 16px; display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  label { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--paper-300); }
  input { background: var(--ink-300); border: 1px solid var(--hairline); border-radius: var(--r-1); padding: 10px 12px; color: var(--paper-100); font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 14px; }
  input:focus { outline: 1px solid var(--accent); }
  .primary { padding: 12px; background: var(--accent); color: var(--ink-100); border: 0; border-radius: var(--r-2); font-family: 'IBM Plex Sans', system-ui, sans-serif; font-weight: 600; font-size: 14px; cursor: pointer; }
  .primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .primary:hover:not(:disabled) { background: #b45309; }
  .link { background: transparent; border: 0; color: var(--accent); font-size: 12px; cursor: pointer; padding: 4px; text-align: center; }
  .link:disabled { opacity: 0.4; cursor: not-allowed; }
  .err { color: var(--down); font-size: 12px; margin: 0; text-align: center; }
</style>
