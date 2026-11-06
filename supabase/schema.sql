-- =====================================================================
-- Sportdashboard in Supabase
-- ---------------------------------------------------------------------
-- Eén gebruiker: jij. De eerste gebruiker die in Auth wordt aangemaakt,
-- wordt eigenaar; alleen de eigenaar kan iets lezen of schrijven.
-- Uitvoeren: Supabase > SQL Editor > dit hele bestand plakken > Run.
-- Opnieuw uitvoeren mag: alles is idempotent.
-- =====================================================================

-- ---- eigenaar ---------------------------------------------------------
create table if not exists public.eigenaar (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sinds   timestamptz not null default now()
);
alter table public.eigenaar enable row level security;

create or replace function public.is_eigenaar() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.eigenaar where user_id = auth.uid())
$$;

-- De eerste gebruiker wordt eigenaar; daarna niemand meer.
create or replace function public.eerste_eigenaar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.eigenaar) then
    insert into public.eigenaar (user_id) values (new.id);
  end if;
  return new;
end $$;

drop trigger if exists eerste_eigenaar on auth.users;
create trigger eerste_eigenaar after insert on auth.users
  for each row execute function public.eerste_eigenaar();

-- Bestond je gebruiker al vóór dit script: dan alsnog de oudste.
insert into public.eigenaar (user_id)
  select id from auth.users order by created_at limit 1
  on conflict do nothing;
delete from public.eigenaar e
  where (select count(*) from public.eigenaar) > 1
    and e.user_id <> (select user_id from public.eigenaar order by sinds limit 1);

drop policy if exists eigenaar_lezen on public.eigenaar;
create policy eigenaar_lezen on public.eigenaar for select to authenticated
  using (user_id = auth.uid());

-- ---- jouw invoer ------------------------------------------------------
-- Eén rij per record, net als in de app: vak (check, plan, log, explos,
-- zesmin, instel, leer, wkaan, notitie, context) en sleutel (datum of id).
-- 'data' is het volledige record inclusief herkomst (_t, _bron, _basis,
-- _weg, _conflicten); de app voegt samen, deze tabel bewaart.
create table if not exists public.records (
  vak        text not null,
  sleutel    text not null,
  data       jsonb not null,
  bijgewerkt timestamptz not null default now(),
  primary key (vak, sleutel)
);
alter table public.records enable row level security;
drop policy if exists records_eigenaar on public.records;
create policy records_eigenaar on public.records for all to authenticated
  using (public.is_eigenaar()) with check (public.is_eigenaar());

create or replace function public.records_tijd() returns trigger
language plpgsql as $$ begin new.bijgewerkt := now(); return new; end $$;
drop trigger if exists records_tijd on public.records;
create trigger records_tijd before insert or update on public.records
  for each row execute function public.records_tijd();

-- ---- Garmin (schrijft alleen GitHub Actions, met de secret key) -------
create table if not exists public.garmin_dag (
  datum      date primary key,
  data       jsonb not null,
  bijgewerkt timestamptz not null default now()
);
create table if not exists public.garmin_activiteit (
  id         bigint primary key,
  datum      date not null,
  data       jsonb not null,
  bijgewerkt timestamptz not null default now()
);
create index if not exists garmin_activiteit_datum on public.garmin_activiteit (datum);
create table if not exists public.garmin_overzicht (
  sleutel    text primary key,
  data       jsonb not null,
  bijgewerkt timestamptz not null default now()
);
alter table public.garmin_dag        enable row level security;
alter table public.garmin_activiteit enable row level security;
alter table public.garmin_overzicht  enable row level security;
drop policy if exists garmin_dag_lezen on public.garmin_dag;
drop policy if exists garmin_act_lezen on public.garmin_activiteit;
drop policy if exists garmin_ovz_lezen on public.garmin_overzicht;
create policy garmin_dag_lezen on public.garmin_dag        for select to authenticated using (public.is_eigenaar());
create policy garmin_act_lezen on public.garmin_activiteit for select to authenticated using (public.is_eigenaar());
create policy garmin_ovz_lezen on public.garmin_overzicht  for select to authenticated using (public.is_eigenaar());

-- ---- gesprek met de coach ---------------------------------------------
create table if not exists public.coach_berichten (
  id      bigint generated always as identity primary key,
  t       timestamptz not null default now(),
  rol     text not null check (rol in ('user', 'assistant')),
  tekst   text not null,
  acties  jsonb,          -- wat de coach heeft gelezen en vastgelegd
  bron    text            -- apparaat of 'claude'
);
alter table public.coach_berichten enable row level security;
drop policy if exists coach_lezen on public.coach_berichten;
drop policy if exists coach_schrijven on public.coach_berichten;
drop policy if exists coach_wissen on public.coach_berichten;
create policy coach_lezen     on public.coach_berichten for select to authenticated using (public.is_eigenaar());
create policy coach_schrijven on public.coach_berichten for insert to authenticated with check (public.is_eigenaar());
create policy coach_wissen    on public.coach_berichten for delete to authenticated using (public.is_eigenaar());

-- ---- rechten: anoniem niets, ingelogd volgens de regels hierboven -----
revoke all on public.eigenaar, public.records, public.garmin_dag, public.garmin_activiteit,
              public.garmin_overzicht, public.coach_berichten from anon;
grant select on public.eigenaar to authenticated;
grant select, insert, update, delete on public.records to authenticated;
grant select on public.garmin_dag, public.garmin_activiteit, public.garmin_overzicht to authenticated;
grant select, insert, delete on public.coach_berichten to authenticated;

-- ---- live: wijzigingen in je invoer en het gesprek direct doorgeven ---
do $$ begin
  begin alter publication supabase_realtime add table public.records;
  exception when duplicate_object or undefined_object then null; end;
  begin alter publication supabase_realtime add table public.coach_berichten;
  exception when duplicate_object or undefined_object then null; end;
end $$;
