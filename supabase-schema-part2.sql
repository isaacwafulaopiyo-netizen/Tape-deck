-- Lets the app safely add listening seconds without race conditions.

create or replace function public.increment_listen_time(seconds int)
returns void as $$
begin
  update public.profiles
  set total_listen_seconds = total_listen_seconds + seconds,
      last_seen = now()
  where id = auth.uid();
end;
$$ language plpgsql security definer;

