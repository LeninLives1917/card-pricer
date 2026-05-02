// Supabase Realtime helper — subscribe to session_scans inserts on a
// specific session channel. Replaces v1's bespoke /api/room/:id SSE.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SessionScan {
  id: string;
  session_id: string;
  scanned_by_user_id: string | null;
  card_meta: Record<string, unknown>;
  pricing_snapshot: Record<string, unknown> | null;
  idempotency_key: string;
  created_at: string;
}

/**
 * Subscribe to scan inserts for a session. Returns an unsubscribe function.
 * The handler fires for every INSERT — server upserts use UNIQUE (session_id,
 * idempotency_key) so dedupes don't broadcast.
 */
export function subscribeToSessionScans(
  client: SupabaseClient,
  sessionId: string,
  handler: (scan: SessionScan) => void,
): () => void {
  const channel = client
    .channel(`session:${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'session_scans',
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        handler(payload.new as SessionScan);
      },
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
