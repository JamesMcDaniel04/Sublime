create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  insert into public.organizations (id, name, slug, plan, "trialStartDate", "createdAt", "updatedAt")
  values (
    gen_random_uuid(),
    coalesce(new.raw_user_meta_data->>'organization_name', split_part(new.email, '@', 1)),
    'org-' || substring(new.id::text, 1, 8),
    'TRIAL',
    now(),
    now(),
    now()
  )
  returning id into org_id;

  insert into public.users (
    id,
    "supabaseId",
    email,
    name,
    role,
    "organizationId",
    "isActive",
    timezone,
    "createdAt",
    "updatedAt"
  )
  values (
    'usr_' || replace(new.id::text, '-', ''),
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'ADMIN',
    org_id,
    true,
    'UTC',
    now(),
    now()
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
