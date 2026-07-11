-- Provisioning is performed by the application after it has enforced the
-- deployment's invitation/JIT policy. A database trigger cannot safely read
-- that policy and previously allowed every Auth identity to become an admin.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
