-- v2 W6 migration: live_sessions + live_session_scans for multi-operator real-time.
-- Named "live_*" to avoid collision with v1's separate `sessions` session-log table.
-- IDEMPOTENT.

CREATE TABLE IF NOT EXISTS public.live_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id         uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  name            text,
  /** 6-character code printed on the host laptop, used by paired phones to join. */
  pair_code       text NOT NULL UNIQUE,
  created_at      timestamptz DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS live_sessions_owner_idx ON public.live_sessions (owner_user_id, created_at DESC);

ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads own live_sessions" ON public.live_sessions;
DROP POLICY IF EXISTS "owner mutates own live_sessions" ON public.live_sessions;
CREATE POLICY "owner reads own live_sessions" ON public.live_sessions
  FOR SELECT USING (owner_user_id = auth.uid());
CREATE POLICY "owner mutates own live_sessions" ON public.live_sessions
  FOR ALL USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.live_session_scans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES public.live_sessions(id) ON DELETE CASCADE,
  scanned_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  card_meta           jsonb NOT NULL,
  pricing_snapshot    jsonb,
  /** Idempotency key — prevents double-add when two operators scan the same card simultaneously. */
  idempotency_key     text NOT NULL,
  created_at          timestamptz DEFAULT now(),
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS live_session_scans_session_idx ON public.live_session_scans (session_id, created_at DESC);

ALTER TABLE public.live_session_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read live_session_scans" ON public.live_session_scans;
DROP POLICY IF EXISTS "members add live_session_scans" ON public.live_session_scans;
CREATE POLICY "members read live_session_scans" ON public.live_session_scans
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.live_sessions s
            WHERE s.id = session_id AND s.owner_user_id = auth.uid())
  );
CREATE POLICY "members add live_session_scans" ON public.live_session_scans
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.live_sessions s
            WHERE s.id = session_id AND s.owner_user_id = auth.uid())
  );

-- Realtime publication: idempotent — drop-then-add avoids "already member" error.
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.live_session_scans;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_session_scans;
