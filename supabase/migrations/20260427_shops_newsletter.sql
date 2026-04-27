-- ============================================================
-- shops — pluggable newsletter provider per shop
-- ============================================================
-- newsletter_provider: which email service to subscribe opt-ins to.
--   'brevo'      — uses brevo_list_id (existing column) + Dave's Brevo API key.
--   'mailchimp'  — uses mailchimp_api_key + mailchimp_list_id (DC derived from key).
--   'convertkit' — uses convertkit_api_key + convertkit_form_id.
--   'off'        — checkbox may still appear, but no auto-subscribe; opt-in is
--                  still saved to quote_leads.newsletter for manual export.
-- newsletter_show: hide the checkbox in the embedded /quote entirely.

alter table public.shops
  add column if not exists newsletter_provider text not null default 'brevo'
    check (newsletter_provider in ('brevo','mailchimp','convertkit','off')),
  add column if not exists newsletter_show boolean not null default true,
  add column if not exists mailchimp_api_key text,
  add column if not exists mailchimp_list_id text,
  add column if not exists convertkit_api_key text,
  add column if not exists convertkit_form_id text;
