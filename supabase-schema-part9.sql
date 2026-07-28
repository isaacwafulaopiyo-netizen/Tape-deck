-- Run this in Supabase SQL Editor.

create table public.announcements (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);

alter table public.announcements enable row level security;

create policy "Announcements are viewable by everyone"
  on public.announcements for select using (true);

create policy "Admins can post announcements"
  on public.announcements for insert
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

create policy "Admins can delete announcements"
  on public.announcements for delete
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Tracks which announcement each user has already seen, so the banner
-- only shows for genuinely new ones.
alter table public.profiles add column if not exists last_seen_announcement_id bigint default 0;