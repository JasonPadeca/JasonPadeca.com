-- 40 families, one child each, all eligible, all fighting over 5 seats.
insert into public.classes
  (id, period_id, semester_id, option_number, name, capacity)
values ('3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111', 9, 'Stampede', 5);

do $$
declare i integer;
begin
  for i in 1..40 loop
    insert into public.families (id, display_name, primary_email)
    values (('60000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
            'Racer ' || i, 'racer' || i || '@example.com');
    insert into public.children (id, family_id, first_name, birth_date, sex, active)
    values (('70000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
            ('60000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
            'Kid' || i, '2015-01-01', 'female', true);
  end loop;
end;
$$;

-- These forty families are created after the seed, so they need registering
-- too: class sign-up is gated on it, and forty families racing for a seat they
-- are not allowed to take would prove nothing about locking.
insert into public.semester_registrations (family_id, semester_id, status, registered_at)
select f.id, '11111111-1111-1111-1111-111111111111'::uuid, 'registered', now()
  from public.families f
 where f.display_name like 'Racer %'
on conflict (family_id, semester_id) do update set status = 'registered';
