# Tape Deck — Documentation

A personal music player and mini social app: play songs from YouTube, direct
links, or your own uploads; sync your library across devices; follow friends,
message them, and see what they're listening to.

Support: isaacwafulaopiyo@gmail.com

---

## 1. What it's built from

Tape Deck is a static site — plain HTML, CSS, and JavaScript, no build step,
no server of your own to run. It's hosted for free on GitHub Pages. All the
"backend" work (accounts, database, real-time messaging, file storage) is
handled by **Supabase**, a free hosted service the app talks to directly from
the browser.

### File structure

```
tape-deck/
├── index.html              Main player (requires login)
├── login.html               Sign in / sign up page, install banner
├── admin.html                Admin dashboard (signups, stats, who's online)
├── help.html                  Help desk: FAQ + contact + FAQ bot
├── about.html                  About-the-developer page (editable template)
├── style.css                    All styling, shared across every page
├── script.js                     All application logic for index.html
├── config.js                      Your Supabase URL + public API key
├── manifest.json                   PWA metadata (name, icons, colors)
├── sw.js                            Service worker (installable app, update banner)
├── icons/                            App icons for install/home screen
├── generate-manifest.js               Node script: scan music/ → songs.json
├── generate-manifest-cloud.ps1          PowerShell: build songs.json from cloud URLs
├── supabase-schema.sql                   Database setup, part 1
├── supabase-schema-part2.sql              Listening-time function
├── supabase-schema-part3.sql               Unread messages, activity feed, chat images
├── supabase-schema-part4.sql                Realtime authorization (presence/sync)
└── music/                                    Local song files + songs.json manifest
```

---

## 2. Features

**Playback**
- Add songs via pasted YouTube link, direct audio URL, or file upload from
  your device.
- Shuffle, repeat (off / all / one), volume control.
- Library, Playlists, and Recently Played tabs.
- Library starts collapsed — tap "Show library" to expand.

**Accounts**
- Real email/password accounts via Supabase Auth.
- Each account has a profile: username, total listening time, admin flag.

**Cross-device sync**
- Your link-based library, playlists, and recent history follow you to any
  device you log into.
- Only one device plays at a time — starting playback on one device pauses
  any other device signed into the same account, with a banner showing
  what's playing elsewhere (same idea as Spotify Connect).
- Uploaded files are the one exception: they only play on the device you
  uploaded them from, since they're never sent anywhere.

**Social**
- People tab: see everyone who's signed up, follow/unfollow, see who's
  online right now.
- Following's activity feed: see what people you follow have been playing.
- Messages: real-time 1:1 chat, with images/GIFs, an emoji picker, and a
  sticker strip. Unread messages show a dot on the Messages tab.

**Admin dashboard** (`admin.html`)
- Total users, who's online right now, each user's join date and total
  listening time.
- Only accounts with `is_admin = true` in the database can see this page.
- Message *contents* are never visible here — only account-level stats.

**Installable app (PWA)**
- Chrome shows an install banner on the login page; once installed it opens
  in its own window with a custom icon, no browser bar.
- iOS doesn't support automatic install prompts — the banner shows manual
  Share → Add to Home Screen instructions instead.
- New pushes to GitHub show a "new version ready" reload banner in the app.

---

## 3. First-time setup

1. **Create a Supabase project** at supabase.com (free tier is enough to
   start).
2. **Run the SQL files in order**, in Supabase's SQL Editor:
   `supabase-schema.sql` → `supabase-schema-part2.sql` →
   `supabase-schema-part3.sql` → `supabase-schema-part4.sql`.
3. **Turn off "Confirm email"** under Authentication → Providers → Email, so
   signups don't hit Supabase's low free email-sending limit.
4. **Fill in `config.js`** with your Project URL and anon public key, found
   under Project Settings → API.
5. **Push everything to GitHub**, with **GitHub Pages** enabled (Settings →
   Pages → pick your branch).
6. **Sign up** through `login.html`, then in the SQL Editor run:
   ```sql
   update public.profiles set is_admin = true where username = 'you';
   ```
   to give yourself access to `admin.html`.

---

## 4. Adding songs

**Local files committed to GitHub** (fine for a small library):
1. Drop audio files into the `music` folder.
2. Regenerate the manifest:
   ```powershell
   Get-ChildItem -Path music\* -Include *.mp3,*.wav,*.ogg,*.m4a,*.flac,*.aac -File |
     Select-Object -ExpandProperty Name | ConvertTo-Json | Set-Content music\songs.json
   ```
3. `git add . && git commit -m "Add songs" && git push`

**Cloud-hosted files** (recommended once your library gets large — GitHub
has a hard 100MB-per-file limit and isn't meant for hosting media):
1. Upload your files to a cloud storage bucket (e.g. Cloudflare R2) and get
   its public base URL.
2. Edit the URL at the top of `generate-manifest-cloud.ps1`, then run it —
   it builds `music/songs.json` with full cloud URLs instead of local
   filenames. `songs.json` supports both formats at once.

---

## 5. Troubleshooting (real issues hit while building this)

**GitHub push rejected / "file too large"**
A file over 100MB was committed at some point in your history — deleting it
locally isn't enough, since old commits still contain it. Fix: wipe and
restart git history (`Remove-Item -Recurse -Force .git`, then `git init`,
`add`, `commit`, `push` fresh), and avoid committing large media going
forward.

**A page 404s on the live site but works locally**
Almost always a filename casing mismatch — Windows treats `Config.js` and
`config.js` as the same file, GitHub (Linux) does not. Fix with a two-step
rename: `git mv Old.html temp.html` then `git mv temp.html new.html`.

**"Email rate limit reached" when signing up**
Supabase's built-in email sender has a very low free-tier limit. Turn off
"Confirm email" under Authentication → Providers (see setup step 3).

**Online status / cross-device sync banner not working**
Recent Supabase projects require explicit Realtime Authorization policies
before two different browser sessions can hear each other's real-time
messages — this is what `supabase-schema-part4.sql` sets up. Without it,
presence and sync messages get silently dropped with no error shown.

**Admin dashboard says "This account isn't an admin"**
Run the `update public.profiles set is_admin = true where username = ...`
command from setup step 6, using your exact username as shown in the
`profiles` table.

---

## 6. Honest limitations

- The FAQ chatbot on the Help page is a simple keyword-matcher, not a real
  AI model — it has no cost and needs no setup, but it can only answer
  questions close to what's in its FAQ list.
- There's no self-service password reset built in yet.
- GIF "search" isn't integrated (that needs a separate third-party API key)
  — GIF *files* work fine through the image upload button.
- The service worker caches the app shell for fast reloads, not your music
  or chat history — this isn't a fully offline player.