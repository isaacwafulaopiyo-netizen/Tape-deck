

-- Lets a recipient mark a message as read (needed for the unread dot).
create policy "Recipients can mark messages read"
  on public.messages for update
  using (auth.uid() = recipient_id);

-- Logs each play so followed users' activity can show up as a feed.
create table public.listening_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  track_title text not null,
  played_at timestamptz default now()
);

alter table public.listening_events enable row level security;

create policy "Listening events are viewable by everyone"
  on public.listening_events for select using (true);

create policy "Users can log their own plays"
  on public.listening_events for insert with check (auth.uid() = user_id);

-- Storage bucket for images/GIFs shared in chat (public read, so links work
-- in <img> tags; only signed-in users can upload to it).
insert into storage.buckets (id, name, public)
values ('chat-uploads', 'chat-uploads', true)
on conflict (id) do nothing;

create policy "Public read chat uploads"
  on storage.objects for select
  using (bucket_id = 'chat-uploads');

create policy "Authenticated users can upload chat images"
  on storage.objects for insert
  with check (bucket_id = 'chat-uploads' and auth.role() = 'authenticated');