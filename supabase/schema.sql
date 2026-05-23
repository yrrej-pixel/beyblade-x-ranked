-- Beyblade X Ranked — run in Supabase SQL Editor
-- Auth: disable "Confirm email" under Authentication → Providers → Email

-- Fresh install (skip if tables exist — use migration block at bottom)
create table if not exists public.players (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  bey_rating integer not null default 0 check (bey_rating >= 0 and bey_rating <= 100),
  rank_tier text not null default 'Bronze I',
  accessories jsonb not null default '["Starter Winder Key"]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists players_username_lower_idx on public.players (lower(username));

create table if not exists public.match_requests (
  id uuid primary key default gen_random_uuid(),
  challenger_id uuid not null references public.players (id) on delete cascade,
  challenged_id uuid not null references public.players (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'completed', 'cancelled')),
  challenger_score integer check (challenger_score is null or (challenger_score >= 0 and challenger_score <= 4)),
  challenged_score integer check (challenged_score is null or (challenged_score >= 0 and challenged_score <= 4)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint different_players check (challenger_id <> challenged_id)
);

create index if not exists match_requests_challenged_pending_idx
  on public.match_requests (challenged_id, status) where status = 'pending';

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists match_requests_updated_at on public.match_requests;
create trigger match_requests_updated_at
  before update on public.match_requests
  for each row execute function public.set_updated_at();

alter table public.players enable row level security;
alter table public.match_requests enable row level security;

drop policy if exists "players_select_all" on public.players;
create policy "players_select_all" on public.players
  for select to authenticated using (true);

drop policy if exists "players_insert_own" on public.players;
create policy "players_insert_own" on public.players
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "players_update_own" on public.players;
create policy "players_update_own" on public.players
  for update to authenticated using (auth.uid() = id);

drop policy if exists "match_requests_select_participant" on public.match_requests;
create policy "match_requests_select_participant" on public.match_requests
  for select to authenticated
  using (auth.uid() = challenger_id or auth.uid() = challenged_id);

drop policy if exists "match_requests_insert_challenger" on public.match_requests;
create policy "match_requests_insert_challenger" on public.match_requests
  for insert to authenticated with check (auth.uid() = challenger_id);

drop policy if exists "match_requests_update_participant" on public.match_requests;
create policy "match_requests_update_participant" on public.match_requests
  for update to authenticated
  using (auth.uid() = challenger_id or auth.uid() = challenged_id);

-- Realtime: Database → Publications → supabase_realtime → add match_requests

create or replace function public.rank_tier_index(tier text)
returns integer language sql immutable as $$
  select coalesce(array_position(array[
    'Bronze I','Bronze II','Bronze III',
    'Silver I','Silver II','Silver III',
    'Gold I','Gold II','Gold III',
    'Platinum I','Platinum II','Platinum III',
    'X-Treme'
  ], tier), 0) - 1;
$$;

create or replace function public.rank_tier_at(idx integer)
returns text language sql immutable as $$
  select (array[
    'Bronze I','Bronze II','Bronze III',
    'Silver I','Silver II','Silver III',
    'Gold I','Gold II','Gold III',
    'Platinum I','Platinum II','Platinum III',
    'X-Treme'
  ])[greatest(1, least(idx + 1, 13))];
$$;

create or replace function public.submit_match_scores(
  p_request_id uuid,
  p_challenger_score integer,
  p_challenged_score integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.match_requests%rowtype;
  v_winner_id uuid;
  v_loser_id uuid;
  v_winner_br integer;
  v_loser_br integer;
  v_winner_idx integer;
  v_loser_idx integer;
  v_winner_tier text;
  v_loser_tier text;
  v_winner_accessories jsonb;
  v_gain constant integer := 25;
  v_loss constant integer := 15;
  v_new_accessory text;
  v_rank_up boolean := false;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.match_requests where id = p_request_id for update;
  if not found then raise exception 'Match request not found'; end if;
  if v_req.status <> 'accepted' then raise exception 'Match is not accepted'; end if;
  if auth.uid() not in (v_req.challenger_id, v_req.challenged_id) then
    raise exception 'Not a participant';
  end if;
  if p_challenger_score = p_challenged_score then raise exception 'Scores cannot tie'; end if;
  if greatest(p_challenger_score, p_challenged_score) <> 4 then
    raise exception 'Winner must reach 4 points';
  end if;

  if p_challenger_score > p_challenged_score then
    v_winner_id := v_req.challenger_id;
    v_loser_id := v_req.challenged_id;
  else
    v_winner_id := v_req.challenged_id;
    v_loser_id := v_req.challenger_id;
  end if;

  select bey_rating, rank_tier_index(rank_tier), accessories
    into v_winner_br, v_winner_idx, v_winner_accessories
  from public.players where id = v_winner_id for update;

  select bey_rating, rank_tier_index(rank_tier)
    into v_loser_br, v_loser_idx
  from public.players where id = v_loser_id for update;

  v_winner_br := v_winner_br + v_gain;
  while v_winner_br > 100 loop
    if v_winner_idx >= 12 then
      v_winner_br := 100;
      exit;
    end if;
    v_winner_idx := v_winner_idx + 1;
    v_rank_up := true;
    v_new_accessory := case
      when public.rank_tier_at(v_winner_idx) like 'Bronze%' then 'Bronze Grip Tape'
      when public.rank_tier_at(v_winner_idx) like 'Silver%' then 'Silver Launcher String'
      when public.rank_tier_at(v_winner_idx) like 'Gold%' then 'Gold Launcher String'
      when public.rank_tier_at(v_winner_idx) like 'Platinum%' then 'Platinum Bit Set'
      else 'X-Treme Bit Sticker'
    end;
    if not (v_winner_accessories ? v_new_accessory) then
      v_winner_accessories := v_winner_accessories || to_jsonb(v_new_accessory);
    end if;
    v_winner_br := v_winner_br - 100;
  end loop;

  v_loser_br := v_loser_br - v_loss;
  while v_loser_br < 0 loop
    if v_loser_idx <= 0 then
      v_loser_br := 0;
      exit;
    end if;
    v_loser_idx := v_loser_idx - 1;
    v_loser_br := 100 + v_loser_br;
  end loop;

  v_winner_tier := public.rank_tier_at(v_winner_idx);
  v_loser_tier := public.rank_tier_at(v_loser_idx);

  update public.players
  set bey_rating = v_winner_br, rank_tier = v_winner_tier, accessories = v_winner_accessories
  where id = v_winner_id;

  update public.players
  set bey_rating = v_loser_br, rank_tier = v_loser_tier
  where id = v_loser_id;

  update public.match_requests
  set status = 'completed',
      challenger_score = p_challenger_score,
      challenged_score = p_challenged_score
  where id = p_request_id;

  return jsonb_build_object(
    'winner_id', v_winner_id,
    'loser_id', v_loser_id,
    'rank_up', v_rank_up,
    'new_rank_tier', v_winner_tier,
    'new_accessory', v_new_accessory
  );
end;
$$;

grant execute on function public.submit_match_scores(uuid, integer, integer) to authenticated;

-- Migration from old columns (br / rank_index) — run only if you had the previous schema
-- alter table public.players add column if not exists bey_rating integer;
-- alter table public.players add column if not exists rank_tier text;
-- update public.players set bey_rating = coalesce(bey_rating, br, 0), rank_tier = coalesce(rank_tier, public.rank_tier_at(rank_index), 'Bronze I') where bey_rating is null or rank_tier is null;
