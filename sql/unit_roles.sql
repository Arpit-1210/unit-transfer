-- UNIT TRANSFER: roles. Run ONCE in Supabase -> SQL Editor ("Run without RLS" if asked). Safe to run again.
--   admin@gfpl.com  -> sees everything, can edit / delete any transfer
--   unit1@gfpl.com  -> can only make a transfer (From = Unit 1) and download the PDF
--   unit2@gfpl.com  -> can only make a transfer (From = Unit 2) and download the PDF

create extension if not exists pgcrypto;

alter table ut_transfers add column if not exists created_by_email text;
alter table ut_transfers add column if not exists edited_by text;
alter table ut_transfers add column if not exists edited_at timestamptz;

-- ───────── who is who ─────────
create or replace function ut_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'admin@gfpl.com'
$$;

-- 'unit1@gfpl.com' -> 'Unit 1' ; anyone else -> null
create or replace function ut_unit_of() returns text
language sql stable security definer set search_path = public as $$
  select case when lower(coalesce(auth.jwt() ->> 'email', '')) ~ '^unit[0-9]+@gfpl\.com$'
    then 'Unit ' || substring(lower(auth.jwt() ->> 'email') from '^unit([0-9]+)@') end
$$;

create or replace function ut_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select ut_is_admin() or ut_unit_of() is not null
$$;

-- ───────── security ─────────
alter table ut_units enable row level security;
alter table ut_products enable row level security;
alter table ut_transfers enable row level security;
alter table ut_items enable row level security;

do $$
declare t text; p record;
begin
  foreach t in array array['ut_units','ut_products','ut_transfers','ut_items'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- everyone allowed can read the unit list and product list
create policy "units read" on ut_units for select to authenticated using (ut_allowed());
create policy "products read" on ut_products for select to authenticated using (ut_allowed());
-- only admin changes units / products / transfers directly
create policy "units admin" on ut_units for all to authenticated using (ut_is_admin()) with check (ut_is_admin());
create policy "products admin" on ut_products for all to authenticated using (ut_is_admin()) with check (ut_is_admin());
create policy "transfers admin" on ut_transfers for all to authenticated using (ut_is_admin()) with check (ut_is_admin());
create policy "items admin" on ut_items for all to authenticated using (ut_is_admin()) with check (ut_is_admin());

revoke all on ut_units, ut_products, ut_transfers, ut_items from anon;
grant all on ut_units, ut_products, ut_transfers, ut_items to authenticated;

-- ───────── next transfer number (for the preview) ─────────
create or replace function ut_next_no(p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare prefix text := 'UT-' || to_char(p_date, 'YYYYMMDD') || '-'; n int;
begin
  if not ut_allowed() then raise exception 'not allowed'; end if;
  select coalesce(max(substr(transfer_no, length(prefix) + 1)::int), 0) + 1 into n
  from ut_transfers where transfer_no ~ ('^' || prefix || '[0-9]+$');
  return prefix || lpad(n::text, 3, '0');
end $$;

-- ───────── save a new transfer (admin: any route; unit user: From is forced to their own unit) ─────────
create or replace function ut_save_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d date; v_from text; v_to text; prefix text; n int; t ut_transfers; tot numeric;
begin
  if not ut_allowed() then raise exception 'not allowed'; end if;
  d := (p ->> 'transfer_date')::date;
  v_from := case when ut_is_admin() then p ->> 'from_unit' else ut_unit_of() end;
  v_to := p ->> 'to_unit';
  if v_from is null or v_to is null or v_from = v_to then raise exception 'From and To unit must be different'; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then raise exception 'Add at least one product'; end if;
  if exists (select 1 from jsonb_array_elements(p -> 'items') e where coalesce((e ->> 'qty')::numeric, 0) <= 0) then raise exception 'Quantity must be more than 0'; end if;

  perform pg_advisory_xact_lock(hashtext('ut_no_' || d::text));
  prefix := 'UT-' || to_char(d, 'YYYYMMDD') || '-';
  select coalesce(max(substr(transfer_no, length(prefix) + 1)::int), 0) + 1 into n
  from ut_transfers where transfer_no ~ ('^' || prefix || '[0-9]+$');
  select sum((e ->> 'qty')::numeric) into tot from jsonb_array_elements(p -> 'items') e;

  insert into ut_transfers (transfer_no, transfer_date, from_unit, to_unit, vehicle_type, vehicle_no, driver, note, total_qty, status, created_by_email)
  values (prefix || lpad(n::text, 3, '0'), d, v_from, v_to, p ->> 'vehicle_type', coalesce(p ->> 'vehicle_no', ''), coalesce(p ->> 'driver', ''), coalesce(p ->> 'note', ''), tot, 'done', lower(auth.jwt() ->> 'email'))
  returning * into t;

  insert into ut_items (transfer_id, sno, product_name, quantity, position)
  select t.id, nullif(e.v ->> 'sno', '')::int, e.v ->> 'name', (e.v ->> 'qty')::numeric, e.i::int
  from jsonb_array_elements(p -> 'items') with ordinality as e(v, i);

  return jsonb_build_object('transfer', to_jsonb(t),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sno', i.sno, 'product_name', i.product_name, 'quantity', i.quantity, 'position', i.position) order by i.position), '[]'::jsonb) from ut_items i where i.transfer_id = t.id));
end $$;

-- ───────── admin edits an existing transfer ─────────
create or replace function ut_update_transfer(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t ut_transfers; tot numeric;
begin
  if not ut_is_admin() then raise exception 'owner only'; end if;
  if (p ->> 'from_unit') = (p ->> 'to_unit') then raise exception 'From and To unit must be different'; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then raise exception 'Add at least one product'; end if;
  if exists (select 1 from jsonb_array_elements(p -> 'items') e where coalesce((e ->> 'qty')::numeric, 0) <= 0) then raise exception 'Quantity must be more than 0'; end if;
  select sum((e ->> 'qty')::numeric) into tot from jsonb_array_elements(p -> 'items') e;

  update ut_transfers set
    transfer_date = (p ->> 'transfer_date')::date, from_unit = p ->> 'from_unit', to_unit = p ->> 'to_unit',
    vehicle_type = p ->> 'vehicle_type', vehicle_no = coalesce(p ->> 'vehicle_no', ''), driver = coalesce(p ->> 'driver', ''),
    note = coalesce(p ->> 'note', ''), total_qty = tot, edited_by = lower(auth.jwt() ->> 'email'), edited_at = now()
  where id = p_id returning * into t;
  if t.id is null then raise exception 'Transfer not found'; end if;

  delete from ut_items where transfer_id = p_id;
  insert into ut_items (transfer_id, sno, product_name, quantity, position)
  select p_id, nullif(e.v ->> 'sno', '')::int, e.v ->> 'name', (e.v ->> 'qty')::numeric, e.i::int
  from jsonb_array_elements(p -> 'items') with ordinality as e(v, i);

  return jsonb_build_object('transfer', to_jsonb(t),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sno', i.sno, 'product_name', i.product_name, 'quantity', i.quantity, 'position', i.position) order by i.position), '[]'::jsonb) from ut_items i where i.transfer_id = p_id));
end $$;

revoke execute on function ut_is_admin(), ut_unit_of(), ut_allowed(), ut_next_no(date), ut_save_transfer(jsonb), ut_update_transfer(uuid, jsonb) from public, anon;
grant execute on function ut_is_admin(), ut_unit_of(), ut_allowed(), ut_next_no(date), ut_save_transfer(jsonb), ut_update_transfer(uuid, jsonb) to authenticated;

-- ───────── the two unit logins ─────────
do $$
declare r record; uid uuid;
begin
  for r in select * from (values ('unit1@gfpl.com', 'Unit1@Gfpl26'), ('unit2@gfpl.com', 'Unit2@Gfpl26')) as v(em, pw) loop
    select id into uid from auth.users where email = r.em;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', r.em,
        extensions.crypt(r.pw, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', r.em), 'email', now(), now(), now());
    else
      update auth.users set encrypted_password = extensions.crypt(r.pw, extensions.gen_salt('bf')), updated_at = now() where id = uid;
    end if;
  end loop;
end $$;

select email as login_id from auth.users where email in ('unit1@gfpl.com', 'unit2@gfpl.com', 'admin@gfpl.com') order by email;
