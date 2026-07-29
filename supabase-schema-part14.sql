alter table public.shared_tracks add column if not exists normalized_title text
  generated always as (
    trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))
  ) stored;

-- Clean up existing duplicates first (keeps the oldest entry of each,
-- removes the rest) -- required before the unique constraint below can
-- be added, since it would otherwise fail with duplicates present.
delete from public.shared_tracks a
using public.shared_tracks b
where a.normalized_title = b.normalized_title
  and a.id > b.id;

alter table public.shared_tracks
  add constraint shared_tracks_normalized_title_unique unique (normalized_title);