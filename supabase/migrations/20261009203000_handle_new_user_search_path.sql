-- Sign-up was broken: "Database error saving new user".
--
-- 9 Oct 2026, Liam (Ireland Card Show) could not create an account. Postgres
-- log: relation "profiles" does not exist. handle_new_user() (the trigger on
-- auth.users that creates the profile) named `profiles` unqualified and set no
-- search_path, and Supabase Auth runs it with search_path = auth, so the
-- insert failed and so did every sign-up. Only one account had ever been
-- created (the owner's, 21 Apr 2026).
--
-- Fix: qualify the table and pin search_path to '' (also clears the
-- function_search_path_mutable advisor). Behaviour otherwise unchanged: a new
-- account still gets a profile on the 'beta' plan.
--
-- Checked in a rolled-back transaction with search_path = auth: before, the
-- insert into auth.users failed with the same error; after, it succeeds and
-- the profile row exists with plan 'beta'.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (user_id, plan) values (new.id, 'beta')
    on conflict (user_id) do nothing;
  return new;
end;
$function$;
