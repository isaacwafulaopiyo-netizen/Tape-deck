create table public.music_requests (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

alter table public.music_requests enable row level security;

create policy "Users can submit their own music requests"
  on public.music_requests for insert
  with check (auth.uid() = user_id);

create policy "Users can view their own music requests"
  on public.music_requests for select
  using (auth.uid() = user_id);

create policy "Admins can view all music requests"
  on public.music_requests for select
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

create policy "Admins can delete music requests"
  on public.music_requests for delete
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Tracks whether the one-time "what music do you love" prompt has already
-- been shown/handled, so it never nags twice.
alter table public.profiles add column if not exists music_taste_prompted boolean default false;