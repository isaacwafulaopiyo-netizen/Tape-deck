create policy "Admins can delete any shared track"
  on public.shared_tracks for delete
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );