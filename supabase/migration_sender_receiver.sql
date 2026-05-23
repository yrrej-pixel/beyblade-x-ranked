-- Run in Supabase SQL Editor (one block at a time if a column was already renamed)

-- challenger_id → sender_id
alter table public.match_requests rename column challenger_id to sender_id;

-- challenged_id OR rival_id → receiver_id (use the line that matches your table)
alter table public.match_requests rename column challenged_id to receiver_id;
-- alter table public.match_requests rename column rival_id to receiver_id;

alter table public.match_requests rename column challenger_score to sender_score;
alter table public.match_requests rename column challenged_score to receiver_score;

-- Then re-run RLS + submit_match_scores from schema.sql
