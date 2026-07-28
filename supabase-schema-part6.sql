alter table public.profiles add column if not exists onboarding_seen boolean default false;
alter table public.profiles add column if not exists prefs jsonb default '{}'::jsonb;

create table public.playlists (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  name text not null,
  track_urls jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  unique(user_id, name)
);

alter table public.playlists enable row level security;

create policy "Users manage their own playlists"
  on public.playlists for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Lets whoever added a URL-based song remove it from the shared library
-- for good, instead of it quietly reappearing on next load.
create policy "Adder can delete their own shared track"
  on public.shared_tracks for delete
  using (auth.uid() = added_by);

-- So "recently played" can be rebuilt from real data instead of the
-- broken client-only storage.
alter table public.listening_events add column if not exists url text;
alter table public.listening_events add column if not exists type text;
alter table public.listening_events add column if not exists yt_id text;