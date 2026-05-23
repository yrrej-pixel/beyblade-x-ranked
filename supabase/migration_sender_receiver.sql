-- Rename match_requests columns to sender_id / receiver_id
-- Run in Supabase SQL Editor if your table still uses challenger_id / challenged_id / rival_id

alter table public.match_requests rename column challenger_id to sender_id;
alter table public.match_requests rename column challenged_id to receiver_id;

-- If you used rival_id instead of challenged_id:
-- alter table public.match_requests rename column rival_id to receiver_id;

alter table public.match_requests rename column challenger_score to sender_score;
alter table public.match_requests rename column challenged_score to receiver_score;

-- Re-run RLS policies + submit_match_scores from schema.sql after renaming
