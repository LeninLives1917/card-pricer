-- v2 W7 migration: customer_accounts + quote_offers.
-- Public-side customer accounts. Lets buyers log in via magic-link,
-- see past quotes, accept/decline new offers from shops.
-- IDEMPOTENT.

CREATE TABLE IF NOT EXISTS public.customer_accounts (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name         text,
  opted_in_marketing   boolean NOT NULL DEFAULT false,
  preferred_shop_slug  text REFERENCES public.shops(slug) ON DELETE SET NULL,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

ALTER TABLE public.customer_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self reads own account" ON public.customer_accounts;
DROP POLICY IF EXISTS "self mutates own account" ON public.customer_accounts;
CREATE POLICY "self reads own account" ON public.customer_accounts
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "self mutates own account" ON public.customer_accounts
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.quote_offers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid REFERENCES public.quote_leads(id) ON DELETE SET NULL,
  shop_id         uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  /** Customer email — joins to quote_leads if/when they create an account. */
  customer_email  text NOT NULL,
  customer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  /** Token used in unauthenticated accept/decline links emailed out. */
  accept_token    text NOT NULL UNIQUE,
  line_items      jsonb NOT NULL,
  total_eur       numeric(10,2) NOT NULL,
  currency        text NOT NULL DEFAULT 'EUR',
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'accepted', 'declined', 'expired')),
  expires_at      timestamptz,
  created_at      timestamptz DEFAULT now(),
  accepted_at     timestamptz,
  declined_at     timestamptz
);
CREATE INDEX IF NOT EXISTS quote_offers_email_idx ON public.quote_offers (customer_email);
CREATE INDEX IF NOT EXISTS quote_offers_user_idx ON public.quote_offers (customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quote_offers_token_idx ON public.quote_offers (accept_token);

ALTER TABLE public.quote_offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer reads own offers" ON public.quote_offers;
DROP POLICY IF EXISTS "shop reads own offers" ON public.quote_offers;
CREATE POLICY "customer reads own offers" ON public.quote_offers
  FOR SELECT USING (customer_user_id = auth.uid());
CREATE POLICY "shop reads own offers" ON public.quote_offers
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.shops s
            WHERE s.id = shop_id AND s.owner_user_id = auth.uid())
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.quote_offers;
