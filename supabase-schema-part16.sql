-- Adds real listening duration to each play record (not just "it was
-- played"), and a safe way to update it as someone keeps listening.
-- This is the data foundation for a year-end recap later -- top songs,
-- total time listened, etc. -- without building the recap itself yet.

alter table public.listening_events add column if not exists duration_seconds integer default 0;

create or replace function public.increment_listening_event_duration(event_id bigint, seconds int)
returns void as $$
begin
  update public.listening_events
  set duration_seconds = duration_seconds + seconds
  where id = event_id and user_id = auth.uid();
end;
$$ language plpgsql security definer;