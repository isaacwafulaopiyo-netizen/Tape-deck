-- songs.json links to them work), uploads restricted to signed-in users.

insert into storage.buckets (id, name, public)
values ('music', 'music', true)
on conflict (id) do nothing;

create policy "Public read music files"
  on storage.objects for select
  using (bucket_id = 'music');

create policy "Authenticated users can upload music"
  on storage.objects for insert
  with check (bucket_id = 'music' and auth.role() = 'authenticated');

create policy "Authenticated users can delete music they uploaded"
  on storage.objects for delete
  using (bucket_id = 'music' and auth.role() = 'authenticated');