-- Restores the broken pre-fix definition (unqualified table, no search_path).
-- Only useful to reproduce the incident; sign-ups fail again with it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$
begin
  insert into profiles (user_id, plan) values (new.id, 'beta')
    on conflict (user_id) do nothing;
  return new;
end;
$function$;
