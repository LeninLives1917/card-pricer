-- v2 W5 migration: inventory_items, inventory_events, listings.
-- Bought-cards become tracked items with state machine + P&L until sold.
-- IDEMPOTENT: safe to re-run.

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id         uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  card_meta       jsonb NOT NULL,
  source          text NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'manual', 'import')),
  cost_eur        numeric(10,2) NOT NULL,
  condition_at_buy text,
  market_value_at_buy numeric(10,2),
  state           text NOT NULL DEFAULT 'in_stock'
                  CHECK (state IN ('in_stock', 'listed', 'sold', 'consigned', 'returned')),
  notes           text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_items_owner_state_idx
  ON public.inventory_items (owner_user_id, state);

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "owner mutates own inventory" ON public.inventory_items;
CREATE POLICY "owner reads own inventory" ON public.inventory_items
  FOR SELECT USING (owner_user_id = auth.uid());
CREATE POLICY "owner mutates own inventory" ON public.inventory_items
  FOR ALL USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.inventory_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN ('bought', 'listed', 'price_change', 'sold', 'returned', 'consigned', 'note')),
  data            jsonb,
  actor_user_id   uuid,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_events_item_idx
  ON public.inventory_events (item_id, created_at DESC);

ALTER TABLE public.inventory_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads own events" ON public.inventory_events;
CREATE POLICY "owner reads own events" ON public.inventory_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.inventory_items i
            WHERE i.id = item_id AND i.owner_user_id = auth.uid())
  );

CREATE TABLE IF NOT EXISTS public.listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  marketplace     text NOT NULL CHECK (marketplace IN ('cardmarket', 'tcgplayer', 'ebay', 'in_store')),
  external_url    text,
  ask_eur         numeric(10,2),
  listed_at       timestamptz DEFAULT now(),
  sold_at         timestamptz,
  sold_eur        numeric(10,2),
  fees_eur        numeric(10,2)
);
CREATE INDEX IF NOT EXISTS listings_item_idx ON public.listings (item_id);

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner reads own listings" ON public.listings;
DROP POLICY IF EXISTS "owner mutates own listings" ON public.listings;
CREATE POLICY "owner reads own listings" ON public.listings
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.inventory_items i
            WHERE i.id = item_id AND i.owner_user_id = auth.uid())
  );
CREATE POLICY "owner mutates own listings" ON public.listings
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.inventory_items i
            WHERE i.id = item_id AND i.owner_user_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.touch_inventory_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS inventory_items_touch ON public.inventory_items;
CREATE TRIGGER inventory_items_touch
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_inventory_updated_at();
