-- Run this if you already created tables with br / rank_index columns

alter table public.players add column if not exists bey_rating integer;
alter table public.players add column if not exists rank_tier text;

update public.players
set
  bey_rating = coalesce(bey_rating, br, 0),
  rank_tier = coalesce(rank_tier, 'Bronze I')
where bey_rating is null or rank_tier is null;

-- Optional: drop old columns after verifying data
-- alter table public.players drop column if exists br;
-- alter table public.players drop column if exists rank_index;

-- Then re-run functions from schema.sql (rank_tier_index, submit_match_scores)
