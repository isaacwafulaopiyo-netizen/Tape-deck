-- private to the device they were uploaded from -- that part is unchanged,
-- since uploaded files are never sent anywhere.

create table public.shared_tracks (
  id bigint generated always as identity primary key,
  url text not null unique,
  type text not null,
  yt_id text,
  title text not null,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);

alter table public.shared_tracks enable row level security;

create policy "Shared tracks are viewable by everyone"
  on public.shared_tracks for select using (true);

create policy "Authenticated users can add shared tracks"
  on public.shared_tracks for insert
  with check (auth.uid() = added_by);

create policy "Adder can update their own shared track"
  on public.shared_tracks for update
  using (auth.uid() = added_by);