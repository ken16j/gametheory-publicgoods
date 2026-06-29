-- ============================================================
--  PUBLIC GOODS GAME  · Supabase schema
--  Paste this whole file into the Supabase SQL editor and run.
--  Then enable Realtime on the tables that need it:
--    Database → Replication → Source: supabase_realtime → toggle
--    sessions, players, rounds, contributions, punishments.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.sessions (
  code           text primary key,
  status         text not null default 'lobby'
                 check (status in ('lobby','running','done','ended')),
  current_round  int  not null default 0,
  config         jsonb not null,
  created_at     timestamptz not null default now()
);

create table if not exists public.players (
  id          text primary key,
  session     text not null references public.sessions(code) on delete cascade,
  name        text not null,
  seat        int  not null default 0,   -- stable anonymous "Player N" label
  gender      text,
  field       text,
  balance     numeric not null default 0,
  joined_at   timestamptz not null default now()
);
create index if not exists players_session_idx on public.players(session);

create table if not exists public.rounds (
  session       text not null references public.sessions(code) on delete cascade,
  round         int  not null,
  status        text not null default 'open'
                check (status in ('open','closed')),
  groups        jsonb not null,
  started_at_ms bigint not null,
  ends_at_ms    bigint not null,
  group_totals  jsonb,
  primary key (session, round)
);

create table if not exists public.contributions (
  session        text not null references public.sessions(code) on delete cascade,
  round          int  not null,
  player_id      text not null,
  name           text not null,
  group_id       text not null,
  amount         numeric not null check (amount >= 0),
  auto           boolean not null default false,
  submitted_at_ms bigint not null,
  response_ms    int,
  payoff         numeric,
  balance_after  numeric,
  primary key (session, round, player_id)
);
create index if not exists contributions_session_round_idx
  on public.contributions(session, round);

-- Punishment round (the final round). One row per punisher→target
-- choice. Each target loses `damage` points; the punisher loses
-- `cost` points per target chosen. Resolved by the experimenter's
-- browser when the round closes (balances floored at 0).
create table if not exists public.punishments (
  session         text not null references public.sessions(code) on delete cascade,
  round           int  not null,
  punisher_id     text not null,
  target_id       text not null,
  damage          numeric not null default 3,
  cost            numeric not null default 1,
  submitted_at_ms bigint not null,
  primary key (session, round, punisher_id, target_id)
);
create index if not exists punishments_session_round_idx
  on public.punishments(session, round);

-- ============================================================
--  RLS  ·  classroom posture (no auth)
--  Anyone with the join code can read and write.  Contributions
--  are insert only from clients; payoff updates only patch the
--  two computed columns.  Tighten for publishable research as
--  noted in the README.
-- ============================================================

alter table public.sessions      enable row level security;
alter table public.players       enable row level security;
alter table public.rounds        enable row level security;
alter table public.contributions enable row level security;
alter table public.punishments   enable row level security;

-- sessions
drop policy if exists "sessions read"   on public.sessions;
drop policy if exists "sessions write"  on public.sessions;
create policy "sessions read"  on public.sessions for select using (true);
create policy "sessions write" on public.sessions for all
  using (true) with check (true);

-- players
drop policy if exists "players read"  on public.players;
drop policy if exists "players write" on public.players;
create policy "players read"  on public.players for select using (true);
create policy "players write" on public.players for all
  using (true) with check (true);

-- rounds
drop policy if exists "rounds read"  on public.rounds;
drop policy if exists "rounds write" on public.rounds;
create policy "rounds read"  on public.rounds for select using (true);
create policy "rounds write" on public.rounds for all
  using (true) with check (true);

-- contributions: insert open; updates only touch payoff/balance_after
drop policy if exists "contributions read"   on public.contributions;
drop policy if exists "contributions insert" on public.contributions;
drop policy if exists "contributions update" on public.contributions;
create policy "contributions read"   on public.contributions for select using (true);
create policy "contributions insert" on public.contributions for insert with check (true);
create policy "contributions update" on public.contributions for update
  using (true) with check (true);

-- punishments: insert open from clients; update open for the close pass
drop policy if exists "punishments read"   on public.punishments;
drop policy if exists "punishments insert" on public.punishments;
drop policy if exists "punishments update" on public.punishments;
create policy "punishments read"   on public.punishments for select using (true);
create policy "punishments insert" on public.punishments for insert with check (true);
create policy "punishments update" on public.punishments for update
  using (true) with check (true);

-- ============================================================
--  Realtime publication  ·  add the tables we listen to.
--  (Equivalent to ticking them in Database → Replication.)
--  sessions MUST be included, or players never leave the lobby
--  and rounds never auto-close until the experimenter refreshes.
-- ============================================================
alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.rounds;
alter publication supabase_realtime add table public.contributions;
alter publication supabase_realtime add table public.punishments;
