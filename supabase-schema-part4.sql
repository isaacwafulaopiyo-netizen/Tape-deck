-- Recent Supabase projects require explicit authorization before two
--already worked but the cross-device sync and online-status features did
-- not deliver messages between devices).

create policy "Authenticated users can receive presence"
on "realtime"."messages"
for select
to authenticated
using ( realtime.topic() = 'online-users' );

create policy "Authenticated users can send presence"
on "realtime"."messages"
for insert
to authenticated
with check ( realtime.topic() = 'online-users' );

create policy "Users can receive their own playback sync"
on "realtime"."messages"
for select
to authenticated
using ( realtime.topic() = 'playback-' || auth.uid()::text );

create policy "Users can send their own playback sync"
on "realtime"."messages"
for insert
to authenticated
with check ( realtime.topic() = 'playback-' || auth.uid()::text );