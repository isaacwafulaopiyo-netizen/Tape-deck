alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "Public read avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Authenticated users can upload their avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.role() = 'authenticated');

create policy "Authenticated users can update their avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.role() = 'authenticated');