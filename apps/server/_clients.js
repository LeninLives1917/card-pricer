// apps/server/_clients.js
// Owner: A1 | Slice: S5
//
// TRANSIENT — slice S6 (A2) and S20 (A10) will move adapter/DB clients into
// pricing/ and db/ as appropriate. Until then route handlers and the legacy
// pricing helpers import from here. Do NOT add new code in this file.
//
// Centralises the *singleton* third-party clients V1 created at module scope
// in server.js (Anthropic, Supabase service-role, Stripe) plus the shared
// keep-alive HTTP/HTTPS agents wired into axios + Anthropic SDK. Behaviour is
// preserved 1:1 from V1 server.js (lines 66-72, 602-607, 884-894).

import 'dotenv/config';
import https from 'https';
import http from 'http';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Keep-alive agents — preserves V1 server.js:884-887 behaviour. Without these
// every /api/identify eats a fresh TLS handshake (~150-300ms on cellular).
export const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 25, keepAliveMsecs: 30_000 });
export const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 25, keepAliveMsecs: 30_000 });
axios.defaults.httpsAgent = httpsKeepAlive;
axios.defaults.httpAgent = httpKeepAlive;

// Supabase service-role client. Bypasses RLS, so MUST stay server-only.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supabase = (supabaseUrl && supabaseServiceKey)
  ? createSupabaseClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;
if (!supabase) {
  console.warn('[AUTH] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — auth is disabled. Protected routes will reject all requests.');
}

// Anthropic SDK. fetchOptions.agent reuses our keep-alive https agent so
// Anthropic calls share sockets with the rest of the app.
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetchOptions: { agent: httpsKeepAlive }
});

// Stripe. Optional — billing endpoints return 503 if not configured.
export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;
if (!stripe) {
  console.warn('[STRIPE] STRIPE_SECRET_KEY missing — billing endpoints disabled.');
}

// Re-export axios so callers don't import it separately and lose the
// keep-alive agent wiring (axios.defaults is process-wide, but keeping a
// canonical import path here makes the dependency explicit).
export { axios };
