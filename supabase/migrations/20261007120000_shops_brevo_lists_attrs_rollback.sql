alter table public.shops
  drop column if exists brevo_list_ids,
  drop column if exists brevo_attributes;
