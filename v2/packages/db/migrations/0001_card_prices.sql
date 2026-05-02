-- v2 migration: card_prices table.
-- Replaces v1's data/card-prices.json file. Loaded by the bulk-refresh
-- job via INSERT ... ON CONFLICT UPDATE; arbitrage scan reads via WHERE
-- filters in SQL (faster than iterating a 50k-entry Map in Node).
--
-- IDEMPOTENT: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.card_prices (
  set_id          text NOT NULL,
  number          text NOT NULL,
  name            text NOT NULL,
  set_name        text,
  set_code        text,
  rarity          text,
  image           text,
  cardmarket_url  text,
  tcgplayer_url   text,
  tcg             jsonb,                -- {normal:{low,mid,high,market}, holofoil:..., reverseHolofoil:..., 1stEditionNormal:...}
  cm              jsonb,                -- {lowPrice, lowPriceExPlus, trendPrice, avg7, avg30, reverseHoloLow, reverseHoloAvg7, reverseHoloAvg30, ...}
  fetched_at      timestamptz DEFAULT now(),
  PRIMARY KEY (set_id, number)
);

-- Indexes for the arbitrage scan filter (set + recently fetched).
CREATE INDEX IF NOT EXISTS card_prices_set_id_idx
  ON public.card_prices (set_id);
CREATE INDEX IF NOT EXISTS card_prices_fetched_at_idx
  ON public.card_prices (fetched_at DESC);

-- RLS off — admin-only access via service role through /api/admin/arbitrage.
ALTER TABLE public.card_prices DISABLE ROW LEVEL SECURITY;
