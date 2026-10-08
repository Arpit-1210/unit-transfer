-- UNIT TRANSFER: Unit 1 user = Mahesh, Unit 2 user = Rahul. Run ONCE in Supabase -> SQL Editor ("Run without RLS" if asked). Safe to run again.
--   mahesh@gfpl.com / mahesh123  -> entry only, From = Unit 1
--   rahul@gfpl.com  / rahul123   -> entry only, From = Unit 2
-- Replaces the earlier unit1@ / unit2@ logins.

create table if not exists ut_unit_users (
  email text primary key,
  unit text not null
);
alter table ut_unit_users enable row level security;   -- no policies: only the functions below can read it
revoke all on ut_unit_users from anon, authenticated;

insert into ut_unit_users (email, unit) values ('mahesh@gfpl.com', 'Unit 1'), ('rahul@gfpl.com', 'Unit 2')
on conflict (email) do update set unit = excluded.unit;

create or replace function ut_unit_of() returns text
language sql stable security definer set search_path = public as $$
  select unit from ut_unit_users where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1
$$;
revoke execute on function ut_unit_of() from public, anon;
grant execute on function ut_unit_of() to authenticated;

do $$
declare r record; uid uuid;
begin
  for r in select * from (values ('mahesh@gfpl.com', 'mahesh123'), ('rahul@gfpl.com', 'rahul123')) as v(em, pw) loop
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

-- remove the old unit1 / unit2 logins
delete from auth.users where email in ('unit1@gfpl.com', 'unit2@gfpl.com');

select u.email as login_id, m.unit from auth.users u left join ut_unit_users m on m.email = u.email
where u.email in ('mahesh@gfpl.com', 'rahul@gfpl.com', 'admin@gfpl.com') order by u.email;
