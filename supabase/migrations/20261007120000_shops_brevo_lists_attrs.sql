-- ============================================================
-- shops: several Brevo lists + contact attributes for quote opt-ins
-- ============================================================
-- Why: brevo_list_id holds one list, and for Board & Brewed it was NULL, so
-- every "Keep me posted" tick on /sell-cards fell through to the
-- BREVO_NEWSLETTER_LIST_ID env var (or nowhere). B&B wants an opt-in on the
-- Pokémon marketing list AND an attribution list, tagged SIGNUP_SOURCE.
--
-- brevo_list_ids    integer[]  — when non-empty, used instead of brevo_list_id.
-- brevo_attributes  jsonb      — merged into the Brevo contact on opt-in.
--                                A value of "$now" becomes the ISO timestamp.
-- Additive and nullable: shops that set neither behave exactly as before.

alter table public.shops
  add column if not exists brevo_list_ids integer[],
  add column if not exists brevo_attributes jsonb;
