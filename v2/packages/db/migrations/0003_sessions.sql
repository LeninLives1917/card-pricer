-- v2 W6 migration: sessions + session_scans for multi-operator real-time.
-- IDEMPOTENT.

CREATE TABLE IF NOT EXISTS public.sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id         uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  name            text,
  /** 6-character code printed on the host laptop, used by paired phones to join. */
  pair_code       text NOT NULL UNIQUE,
  created_at      timestamptz DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON public.sessions (owner_user_id, created_at DESC);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads own sessions" ON public.sessions;
DROP POLICY IF EXISTS "owner mutates own sessions" ON public.sessions;
CREATE POLICY "owner reads own sessions" ON public.sessions
  FOR SELECT USING (owner_user_id = auth.uid());
CREATE POLICY "owner mutates own sessions" ON public.sessions
  FOR ALL USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.session_scans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  scanned_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  card_meta           jsonb NOT NULL,
  pricing_snapshot    jsonb,
  /** Idempotency key — prevents double-add when two operators scan the same card simultaneously. */
  idempotency_key     text NOT NULL,
  created_at          timestamptz DEFAULT now(),
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS session_scans_session_idx ON public.session_scans (session_id, created_at DESC);

ALTER TABLE public.session_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read session scans" ON public.session_scans;
DROP POLICY IF EXISTS "members add session scans" ON public.session_scans;
-- Read: any user who can see the parent session can read its scans.
CREATE POLICY "members read session scans" ON public.session_scans
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.sessions s
            WHERE s.id = session_id AND s.owner_user_id = auth.uid())
  );
-- Insert: same membership check.
CREATE POLICY "members add session scans" ON public.session_scans
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.sessions s
            WHERE s.id = session_id AND s.owner_user_id = auth.uid())
  );

-- Enable realtime on session_scans so all paired clients hear inserts.
-- (Run separately in Supabase dashboard if not already on the publication.)
ALTER PUBLICATION supabase_realtime ADD TABLE public.session_scans;
