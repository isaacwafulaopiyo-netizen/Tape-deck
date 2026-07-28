create table public.app_settings (
  id int primary key default 1,
  welcome_message text default 'Welcome to Tape Deck! Paste a link or upload a song to get started.',
  constraint single_row check (id = 1)
);

insert into public.app_settings (id, welcome_message)
values (1, 'Welcome to Tape Deck! Paste a link or upload a song to get started.')
on conflict (id) do nothing;

alter table public.app_settings enable row level security;

create policy "Settings are viewable by everyone"
  on public.app_settings for select using (true);

create policy "Admins can update settings"
  on public.app_settings for update
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Tracks whether each account has seen the welcome banner yet.
alter table public.profiles add column if not exists welcome_seen boolean default false;