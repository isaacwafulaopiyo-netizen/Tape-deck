  /* ================= accounts, presence, follow, messaging ================= */

  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  let currentUser = null;       // profile row: {id, username, is_admin, total_listen_seconds, ...}
  let onlineUserIds = new Set();
  let presenceChannel = null;
  let listenStartTs = null;
  let allProfiles = [];
  let followingIds = new Set();
  let activeConversationUserId = null;
  let unreadFromUserIds = new Set();
  let lastMessageTimeByUser = {};
  let messagesChannel = null;

  const deviceId = (crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Math.random().toString(36).slice(2));
  let playbackChannel = null;
  let suppressBroadcastOnStop = false;
  let remoteIsPlaying = false;

  async function requireAuth(){
    const { data: { session } } = await supabaseClient.auth.getSession();
    if(!session){
      window.location.replace('login.html');
      return null;
    }
    // Required for Realtime Authorization on private channels (presence,
    // playback sync) -- without this, broadcasts get silently dropped.
    await supabaseClient.realtime.setAuth(session.access_token);
    const { data: profile, error } = await supabaseClient
      .from('profiles').select('*').eq('id', session.user.id).single();
    if(error || !profile){
      window.location.replace('login.html');
      return null;
    }
    currentUser = profile;
    supabaseClient.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', currentUser.id).then(() => {});
    return profile;
  }

  function formatDuration(seconds){
    const mins = Math.floor(seconds / 60);
    if(mins < 60) return mins + 'm';
    return Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
  }

  function updateProfileHeader(){
    document.getElementById('myUsername').textContent = currentUser.username;
    document.getElementById('listenStatItem').textContent = 'Listened: ' + formatDuration(currentUser.total_listen_seconds || 0);
    document.getElementById('adminLink').style.display = currentUser.is_admin ? 'block' : 'none';
    setAvatarElement(document.getElementById('myAvatar'), currentUser);
  }

  function markPlaying(){
    isPlaying = true;
    if(listenStartTs === null) listenStartTs = Date.now();
    hideRemoteBanner();
    if('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    const track = playOrder[currentIndex];
    if(track) broadcastNowPlaying(track.title);
  }

  function markPaused(){
    isPlaying = false;
    flushListenTime();
    if('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    if(!suppressBroadcastOnStop) broadcastStopped();
  }

  async function flushListenTime(){
    if(listenStartTs === null) return;
    const elapsed = Math.round((Date.now() - listenStartTs) / 1000);
    listenStartTs = null;
    if(elapsed < 1 || !currentUser) return;
    currentUser.total_listen_seconds = (currentUser.total_listen_seconds || 0) + elapsed;
    updateProfileHeader();
    try{
      await supabaseClient.rpc('increment_listen_time', { seconds: elapsed });
    }catch(e){ /* will catch up next flush */ }
  }

  window.addEventListener('beforeunload', () => { flushListenTime(); broadcastStopped(); });

  /* ---- playback sync (one device plays at a time) ---- */

  function setupPlaybackSync(){
    playbackChannel = supabaseClient.channel('playback-' + currentUser.id, {
      config: { private: true }
    });
    playbackChannel.on('broadcast', { event: 'now_playing' }, (msg) => {
      const payload = msg.payload;
      if(payload.deviceId === deviceId) return;
      if(isPlaying){
        suppressBroadcastOnStop = true;
        stopAll();
        suppressBroadcastOnStop = false;
      }
      remoteIsPlaying = true;
      showRemoteBanner(payload.title);
    });
    playbackChannel.on('broadcast', { event: 'stopped' }, (msg) => {
      if(msg.payload.deviceId === deviceId) return;
      remoteIsPlaying = false;
      hideRemoteBanner();
    });
    playbackChannel.subscribe();
  }

  function broadcastNowPlaying(title){
    if(!playbackChannel) return;
    playbackChannel.send({ type: 'broadcast', event: 'now_playing', payload: { deviceId, title } });
  }

  function broadcastStopped(){
    if(!playbackChannel) return;
    playbackChannel.send({ type: 'broadcast', event: 'stopped', payload: { deviceId } });
  }

  function showRemoteBanner(title){
    const banner = document.getElementById('remoteBanner');
    document.getElementById('remoteTrackTitle').textContent = title;
    banner.style.display = 'flex';
  }

  function hideRemoteBanner(){
    remoteIsPlaying = false;
    document.getElementById('remoteBanner').style.display = 'none';
  }

  /* ---- presence (who's online) ---- */

  function setupPresence(){
    presenceChannel = supabaseClient.channel('online-users', {
      config: { presence: { key: currentUser.id }, private: true }
    });
    presenceChannel.on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      onlineUserIds = new Set(Object.keys(state));
      if(activeView === 'people') renderPeople();
    });
    presenceChannel.subscribe(async (status) => {
      if(status === 'SUBSCRIBED'){
        await presenceChannel.track({ username: currentUser.username, online_at: new Date().toISOString() });
      }
    });
  }

  /* ---- people / follow ---- */


  async function loadPeople(){
    const { data: profiles } = await supabaseClient.from('profiles').select('*');
    allProfiles = (profiles || []).filter(p => p.id !== currentUser.id);
    const { data: follows } = await supabaseClient.from('follows').select('following_id').eq('follower_id', currentUser.id);
    followingIds = new Set((follows || []).map(f => f.following_id));
    if(activeView === 'people') renderPeopleView();
  }

  async function toggleFollow(userId){
    if(followingIds.has(userId)){
      await supabaseClient.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', userId);
      followingIds.delete(userId);
    } else {
      await supabaseClient.from('follows').insert({ follower_id: currentUser.id, following_id: userId });
      followingIds.add(userId);
    }
    renderPeopleView();
  }

  function initials(name){
    return (name || '?').trim().slice(0,2).toUpperCase();
  }

  function setAvatarElement(el, profile){
    if(profile && profile.avatar_url){
      el.innerHTML = `<img src="${profile.avatar_url}" alt="">`;
    } else {
      el.textContent = initials(profile ? profile.username : '?');
    }
  }

  document.getElementById('changeAvatarItem').onclick = () => {
    document.getElementById('profileDropdown').classList.remove('open');
    document.getElementById('avatarInput').click();
  };

  document.getElementById('avatarInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    showToast('Updating profile picture…');
    try{
      const path = currentUser.id + '/avatar-' + Date.now() + '-' + file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const { error: uploadError } = await supabaseClient.storage.from('avatars').upload(path, file);
      if(uploadError){ showToast('Failed to upload: ' + uploadError.message); return; }
      const { data } = supabaseClient.storage.from('avatars').getPublicUrl(path);
      const { error: updateError } = await supabaseClient.from('profiles').update({ avatar_url: data.publicUrl }).eq('id', currentUser.id);
      if(updateError){ showToast('Failed to save: ' + updateError.message); return; }
      currentUser.avatar_url = data.publicUrl;
      setAvatarElement(document.getElementById('myAvatar'), currentUser);
      showToast('Profile picture updated');
      if(activeView === 'people') renderPeopleView();
      if(activeView === 'messages') renderConversationList();
    }catch(err){
      showToast('Something went wrong updating your picture');
    }
  });

  function renderPeopleView(){
    const filter = document.getElementById('peopleFilter').value;
    if(filter === 'feed'){
      document.getElementById('peopleList').style.display = 'none';
      document.getElementById('feedList').style.display = 'block';
      document.getElementById('peopleLabel').textContent = "Following's activity";
      loadFeed();
    } else {
      document.getElementById('peopleList').style.display = 'block';
      document.getElementById('feedList').style.display = 'none';
      document.getElementById('peopleLabel').textContent = 'Everyone';
      renderPeople();
    }
  }

  function renderPeople(){
    const list = document.getElementById('peopleList');
    list.innerHTML = '';
    if(allProfiles.length === 0){
      list.innerHTML = '<div class="empty">No one else has signed up yet.</div>';
      return;
    }
    allProfiles.forEach(p => {
      const row = document.createElement('div');
      row.className = 'person-row';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      setAvatarElement(avatar, p);
      row.appendChild(avatar);
      const dot = document.createElement('span');
      dot.className = 'person-dot' + (onlineUserIds.has(p.id) ? ' online' : '');
      row.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'person-name';
      name.textContent = p.username;
      row.appendChild(name);
      if(unreadFromUserIds.has(p.id)){
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = 'New message';
        row.appendChild(badge);
      }
      const msgBtn = document.createElement('button');
      msgBtn.className = 'person-btn';
      msgBtn.textContent = 'Message';
      msgBtn.onclick = () => { switchView('messages'); openConversation(p.id, p.username); };
      row.appendChild(msgBtn);
      const followBtn = document.createElement('button');
      followBtn.className = 'person-btn' + (followingIds.has(p.id) ? ' following' : '');
      followBtn.textContent = followingIds.has(p.id) ? 'Following' : 'Follow';
      followBtn.onclick = () => toggleFollow(p.id);
      row.appendChild(followBtn);
      list.appendChild(row);
    });
  }

  async function loadFeed(){
    const ids = Array.from(followingIds);
    const list = document.getElementById('feedList');
    if(ids.length === 0){
      list.innerHTML = '<div class="empty">Follow people to see what they\'re listening to here.</div>';
      return;
    }
    const { data } = await supabaseClient
      .from('listening_events')
      .select('track_title, played_at, user_id')
      .in('user_id', ids)
      .order('played_at', { ascending: false })
      .limit(30);
    const events = data || [];
    if(events.length === 0){
      list.innerHTML = '<div class="empty">No activity yet from people you follow.</div>';
      return;
    }
    const nameById = {};
    allProfiles.forEach(p => nameById[p.id] = p.username);
    list.innerHTML = events.map(ev => `
      <div class="feed-item">
        <span class="avatar">${escapeHtml(initials(nameById[ev.user_id] || '?'))}</span>
        <span class="feed-text"><strong>${escapeHtml(nameById[ev.user_id] || 'Someone')}</strong> played ${escapeHtml(ev.track_title)}</span>
        <span class="feed-time">${timeAgo(ev.played_at)}</span>
      </div>
    `).join('');
  }

  function timeAgo(iso){
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if(secs < 60) return 'just now';
    const mins = Math.floor(secs/60);
    if(mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins/60);
    if(hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs/24) + 'd ago';
  }

  async function logListeningEvent(track){
    if(!currentUser) return;
    try{
      await supabaseClient.from('listening_events').insert({
        user_id: currentUser.id,
        track_title: track.title,
        url: track.type === 'local' ? null : track.url,
        type: track.type,
        yt_id: track.ytId
      });
    }catch(e){ /* non-critical */ }
  }

  document.getElementById('peopleFilter').addEventListener('change', renderPeopleView);

  /* ---- messaging ---- */

  function renderConversationList(){
    const list = document.getElementById('conversationList');
    list.innerHTML = '';
    if(allProfiles.length === 0){
      list.innerHTML = '<div class="empty">No one to message yet.</div>';
      return;
    }
    const sorted = allProfiles.slice().sort((a, b) => {
      const ta = lastMessageTimeByUser[a.id] || '';
      const tb = lastMessageTimeByUser[b.id] || '';
      if(ta && !tb) return -1;
      if(!ta && tb) return 1;
      if(ta !== tb) return ta > tb ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
    sorted.forEach(p => {
      const row = document.createElement('div');
      row.className = 'conversation-row';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      setAvatarElement(avatar, p);
      row.appendChild(avatar);
      const dot = document.createElement('span');
      dot.className = 'person-dot' + (onlineUserIds.has(p.id) ? ' online' : '');
      row.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'person-name';
      name.textContent = p.username;
      row.appendChild(name);
      if(unreadFromUserIds.has(p.id)){
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = 'New message';
        row.appendChild(badge);
      }
      row.onclick = () => openConversation(p.id, p.username);
      list.appendChild(row);
    });
  }

  async function openConversation(otherUserId, otherUsername){
    activeConversationUserId = otherUserId;
    document.getElementById('conversationList').style.display = 'none';
    document.getElementById('chatView').style.display = 'block';
    document.getElementById('chatWithLabel').textContent = otherUsername;
    document.getElementById('emojiPicker').style.display = 'none';
    await loadMessages(otherUserId);
    await markConversationRead(otherUserId);
    subscribeToMessages(otherUserId);
  }

  async function markConversationRead(otherUserId){
    await supabaseClient.from('messages')
      .update({ read: true })
      .eq('sender_id', otherUserId)
      .eq('recipient_id', currentUser.id)
      .eq('read', false);
    unreadFromUserIds.delete(otherUserId);
    refreshUnreadCount();
    if(activeView === 'people') renderPeopleView();
    if(activeView === 'messages') renderConversationList();
  }

  async function refreshUnreadCount(){
    const dotTop = document.getElementById('messagesDot');
    const dotNav = document.getElementById('navMessagesDot');
    try{
      const { data, error } = await supabaseClient
        .from('messages')
        .select('sender_id')
        .eq('recipient_id', currentUser.id)
        .eq('read', false);
      if(error) throw error;
      const rows = data || [];
      const hasUnread = rows.length > 0;
      dotTop.style.display = hasUnread ? 'inline-block' : 'none';
      dotNav.style.display = hasUnread ? 'inline-block' : 'none';
      unreadFromUserIds = new Set(rows.map(m => m.sender_id));
    }catch(e){
      console.error('refreshUnreadCount failed:', e);
      dotTop.style.display = 'none';
      dotNav.style.display = 'none';
      unreadFromUserIds = new Set();
    }
  }

  function subscribeToGlobalMessages(){
    supabaseClient
      .channel('inbox-' + currentUser.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new;
        if(m.recipient_id !== currentUser.id) return;
        lastMessageTimeByUser[m.sender_id] = m.created_at;
        if(activeView === 'messages' && activeConversationUserId === m.sender_id){
          loadMessages(m.sender_id);
          markConversationRead(m.sender_id);
        } else {
          unreadFromUserIds.add(m.sender_id);
          refreshUnreadCount();
          notifyNewMessage(m);
          if(activeView === 'people') renderPeopleView();
          if(activeView === 'messages') renderConversationList();
        }
      })
      .subscribe();
  }

  async function loadConversationOrder(){
    const { data } = await supabaseClient
      .from('messages')
      .select('sender_id, recipient_id, created_at')
      .or(`sender_id.eq.${currentUser.id},recipient_id.eq.${currentUser.id}`)
      .order('created_at', { ascending: false });
    const seen = {};
    (data || []).forEach(m => {
      const other = m.sender_id === currentUser.id ? m.recipient_id : m.sender_id;
      if(!(other in seen)) seen[other] = m.created_at; // first hit per person is the most recent, since sorted desc
    });
    lastMessageTimeByUser = seen;
  }

  async function notifyNewMessage(m){
    if(document.visibilityState === 'visible') return; // no need to alert if they're already looking at it
    if(!('Notification' in window) || Notification.permission !== 'granted') return;
    const sender = allProfiles.find(p => p.id === m.sender_id);
    const body = m.content.startsWith('STICKER::') ? 'Sent a sticker'
      : /^https?:\/\/.*\.(png|jpe?g|gif|webp)/i.test(m.content) ? 'Sent an image'
      : m.content;
    try{
      const reg = await navigator.serviceWorker.getRegistration();
      if(reg){
        reg.showNotification((sender ? sender.username : 'New message') + ' — Tape Deck', {
          body,
          icon: 'icons/icon-192.png',
          badge: 'icons/icon-192.png'
        });
      } else {
        new Notification((sender ? sender.username : 'New message') + ' — Tape Deck', { body, icon: 'icons/icon-192.png' });
      }
    }catch(e){ /* notifications unavailable */ }
  }

  async function loadMessages(otherUserId){
    const { data } = await supabaseClient
      .from('messages').select('*')
      .or(`and(sender_id.eq.${currentUser.id},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${currentUser.id})`)
      .order('created_at', { ascending: true });
    renderMessages(data || []);
  }

  function isImageUrl(content){
    return /^https?:\/\/.*\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(content) || content.includes('/chat-uploads/');
  }

  function renderMessages(msgs){
    const box = document.getElementById('chatMessages');
    box.innerHTML = '';
    msgs.forEach(m => {
      const bubble = document.createElement('div');
      const mine = m.sender_id === currentUser.id;
      if(m.content.startsWith('STICKER::')){
        bubble.className = 'chat-bubble sticker ' + (mine ? 'mine' : 'theirs');
        bubble.textContent = m.content.replace('STICKER::', '');
      } else if(isImageUrl(m.content)){
        bubble.className = 'chat-bubble ' + (mine ? 'mine' : 'theirs');
        const img = document.createElement('img');
        img.src = m.content;
        bubble.appendChild(img);
      } else {
        bubble.className = 'chat-bubble ' + (mine ? 'mine' : 'theirs');
        bubble.textContent = m.content;
      }
      box.appendChild(bubble);
    });
    box.scrollTop = box.scrollHeight;
  }

  function subscribeToMessages(otherUserId){
    if(messagesChannel) supabaseClient.removeChannel(messagesChannel);
    messagesChannel = supabaseClient
      .channel('messages-' + otherUserId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new;
        const belongsHere = (m.sender_id === currentUser.id && m.recipient_id === otherUserId) ||
                             (m.sender_id === otherUserId && m.recipient_id === currentUser.id);
        if(belongsHere && activeConversationUserId === otherUserId){
          loadMessages(otherUserId);
          if(m.sender_id === otherUserId) markConversationRead(otherUserId);
        }
      })
      .subscribe();
  }

  async function sendMessageContent(content){
    if(!content || !activeConversationUserId) return;
    await supabaseClient.from('messages').insert({
      sender_id: currentUser.id,
      recipient_id: activeConversationUserId,
      content
    });
    lastMessageTimeByUser[activeConversationUserId] = new Date().toISOString();
    loadMessages(activeConversationUserId);
  }

  async function sendMessage(){
    const input = document.getElementById('chatInput');
    const content = input.value.trim();
    if(!content) return;
    input.value = '';
    sendMessageContent(content);
  }

  async function sendChatImage(file){
    if(!activeConversationUserId) return;
    const path = currentUser.id + '/' + Date.now() + '-' + file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const { error } = await supabaseClient.storage.from('chat-uploads').upload(path, file);
    if(error){ alert('Image upload failed: ' + error.message); return; }
    const { data } = supabaseClient.storage.from('chat-uploads').getPublicUrl(path);
    sendMessageContent(data.publicUrl);
  }

  const EMOJI_LIST = ['😀','😂','😍','🥲','😎','😢','😡','🤔','👍','👎','🙏','🎉','🔥','❤️','🎵','🎧','⭐','✨','🥳','😴'];

  function buildEmojiPicker(){
    const picker = document.getElementById('emojiPicker');
    picker.innerHTML = EMOJI_LIST.map(e => `<button type="button">${e}</button>`).join('');
    picker.querySelectorAll('button').forEach((btn, i) => {
      btn.onclick = () => {
        const input = document.getElementById('chatInput');
        input.value += EMOJI_LIST[i];
        input.focus();
      };
    });
  }

  function updateNotifToggle(){
    const item = document.getElementById('notifToggleItem');
    if(!('Notification' in window)){
      item.textContent = 'Notifications not supported here';
      item.disabled = true;
      return;
    }
    if(Notification.permission === 'granted'){
      item.textContent = 'Message notifications: on';
    } else if(Notification.permission === 'denied'){
      item.textContent = 'Notifications blocked (check browser settings)';
    } else {
      item.textContent = 'Enable message notifications';
    }
  }

  document.getElementById('notifToggleItem').onclick = async () => {
    if(!('Notification' in window)) return;
    if(Notification.permission === 'default'){
      await Notification.requestPermission();
      updateNotifToggle();
    }
  };

  function updateDataSaverBtn(){
    document.getElementById('dataSaverItem').textContent = 'Data saver: ' + (dataSaver ? 'on' : 'off');
  }

  document.getElementById('dataSaverItem').onclick = () => {
    dataSaver = !dataSaver;
    updateDataSaverBtn();
    persistPrefs();
  };

  document.getElementById('signOutEverywhereItem').onclick = async () => {
    if(!confirm('This signs out every device currently logged into your account, including this one. Continue?')) return;
    await flushListenTime();
    await supabaseClient.auth.signOut({ scope: 'global' });
    window.location.replace('login.html');
  };

  document.getElementById('profileBtn').onclick = () => {
    document.getElementById('profileDropdown').classList.toggle('open');
  };
  document.addEventListener('click', (e) => {
    if(!document.getElementById('profileMenu').contains(e.target)){
      document.getElementById('profileDropdown').classList.remove('open');
    }
  });
  document.getElementById('logoutBtn').onclick = async () => {
    await flushListenTime();
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
  };
  document.getElementById('backToConversations').onclick = () => {
    activeConversationUserId = null;
    document.getElementById('conversationList').style.display = 'block';
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('emojiPicker').style.display = 'none';
  };
  document.getElementById('chatSendBtn').onclick = sendMessage;
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if(e.key === 'Enter') sendMessage();
  });
  document.getElementById('emojiBtn').onclick = () => {
    const picker = document.getElementById('emojiPicker');
    if(picker.innerHTML === '') buildEmojiPicker();
    picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
  };
  document.getElementById('chatImageInput').addEventListener('change', (e) => {
    if(e.target.files[0]) sendChatImage(e.target.files[0]);
    e.target.value = '';
  });
  document.querySelectorAll('.sticker-btn').forEach(btn => {
    btn.onclick = () => sendMessageContent('STICKER::' + btn.dataset.sticker);
  });

  /* ---- welcome banner (new accounts only) ---- */

  async function checkWelcomeBanner(){
    if(currentUser.welcome_seen) return;
    const { data } = await supabaseClient.from('app_settings').select('welcome_message').eq('id', 1).single();
    document.getElementById('welcomeBody').textContent = (data && data.welcome_message) || 'Welcome! Paste a link or upload a song to get started.';
    document.getElementById('welcomeBanner').style.display = 'flex';
  }

  document.getElementById('welcomeDismiss').onclick = async () => {
    document.getElementById('welcomeBanner').style.display = 'none';
    currentUser.welcome_seen = true;
    try{ await supabaseClient.from('profiles').update({ welcome_seen: true }).eq('id', currentUser.id); }
    catch(e){ /* non-critical */ }
  };

  /* ---- music taste requests ---- */

  function showTasteBanner(){
    document.getElementById('tasteInput').value = '';
    document.getElementById('tasteBanner').style.display = 'flex';
  }

  function hideTasteBanner(){
    document.getElementById('tasteBanner').style.display = 'none';
  }

  async function markTastePrompted(){
    currentUser.music_taste_prompted = true;
    try{ await supabaseClient.from('profiles').update({ music_taste_prompted: true }).eq('id', currentUser.id); }
    catch(e){ /* non-critical */ }
  }

  document.getElementById('tasteSubmitBtn').onclick = async () => {
    const content = document.getElementById('tasteInput').value.trim();
    if(!content) return;
    try{
      await supabaseClient.from('music_requests').insert({ user_id: currentUser.id, content });
    }catch(e){ /* non-critical -- worst case it just didn't save this time */ }
    if(!currentUser.music_taste_prompted) await markTastePrompted();
    hideTasteBanner();
  };

  document.getElementById('tasteSkipBtn').onclick = async () => {
    if(!currentUser.music_taste_prompted) await markTastePrompted();
    hideTasteBanner();
  };

  document.getElementById('suggestMusicItem').onclick = () => {
    document.getElementById('profileDropdown').classList.remove('open');
    showTasteBanner();
  };

  /* ---- announcements ---- */

  async function checkAnnouncements(){
    const { data } = await supabaseClient.from('announcements')
      .select('*').order('created_at', { ascending: false }).limit(1);
    const latest = (data || [])[0];
    if(!latest) return;
    if(latest.id <= (currentUser.last_seen_announcement_id || 0)) return;
    document.getElementById('announcementTitle').textContent = latest.title;
    document.getElementById('announcementBody').textContent = latest.body;
    document.getElementById('announcementBanner').style.display = 'flex';
    document.getElementById('announcementDismiss').onclick = async () => {
      document.getElementById('announcementBanner').style.display = 'none';
      currentUser.last_seen_announcement_id = latest.id;
      await supabaseClient.from('profiles').update({ last_seen_announcement_id: latest.id }).eq('id', currentUser.id);
    };
  }

  /* ---- song search ---- */

  document.getElementById('searchToggleBtn').onclick = () => {
    const bar = document.getElementById('searchBar');
    const showing = bar.style.display !== 'none';
    bar.style.display = showing ? 'none' : 'flex';
    document.getElementById('searchResults').style.display = 'none';
    if(!showing) document.getElementById('searchInput').focus();
    else document.getElementById('searchInput').value = '';
  };

  document.getElementById('searchCloseBtn').onclick = () => {
    document.getElementById('searchBar').style.display = 'none';
    document.getElementById('searchResults').style.display = 'none';
    document.getElementById('searchInput').value = '';
  };

  function normalizeForSearch(s){
    return s.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  document.getElementById('searchInput').addEventListener('input', (e) => {
    const q = normalizeForSearch(e.target.value);
    const resultsBox = document.getElementById('searchResults');
    if(!q){ resultsBox.style.display = 'none'; return; }
    const matches = library.filter(t => normalizeForSearch(t.title).includes(q)).slice(0, 20);
    resultsBox.innerHTML = '';
    if(matches.length === 0){
      resultsBox.innerHTML = '<div class="empty">No songs match that.</div>';
    } else {
      matches.forEach(t => {
        const row = makeTrackRow(t, {
          isActive: playOrder[currentIndex] && playOrder[currentIndex].url === t.url,
          showPlaylistSelect: false,
          onClick: () => playAdhoc(t)
        });
        resultsBox.appendChild(row);
      });
    }
    resultsBox.style.display = 'block';
  });

  /* ---- onboarding tour ---- */

  const ONBOARDING_STEPS = [
    { el: '#profileBtn', title: 'Your profile', desc: 'Your name, listening time, Help & Support, About, and Sign out all live here.' },
    { el: '#addBtn', title: 'Add a song', desc: 'Paste a YouTube link or a direct audio file URL here, then tap this button to add it.' },
    { el: '#fileInput', title: 'Or upload from your device', desc: 'Use the upload button below the link box to add songs straight from your phone or computer.', labelFor: true },
    { el: '.tabs', title: 'Everything else lives here', desc: 'Library, Playlists, Recently played, People, and Messages — switch between them with these tabs.' },
    { el: '.controls-secondary', title: 'Shuffle, repeat, volume', desc: 'Fine-tune playback here — tap Repeat to cycle through off, repeat all, and repeat one song.' },
    { el: '#libraryToggle', title: 'Your song list', desc: 'The library starts collapsed to keep things tidy — tap here to show or hide it.' }
  ];
  let onboardingIndex = 0;
  let onboardingLastEl = null;

  function showOnboardingStep(i){
    if(onboardingLastEl) onboardingLastEl.classList.remove('onboarding-highlight');
    const step = ONBOARDING_STEPS[i];
    const target = step.labelFor
      ? document.querySelector(`label[for="${step.el.slice(1)}"]`)
      : document.querySelector(step.el);
    onboardingLastEl = target;
    if(target){
      target.classList.add('onboarding-highlight');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    document.getElementById('onboardingStepNum').textContent = `Step ${i+1} of ${ONBOARDING_STEPS.length}`;
    document.getElementById('onboardingTitle').textContent = step.title;
    document.getElementById('onboardingDesc').textContent = step.desc;
    document.getElementById('onboardingNext').textContent = (i === ONBOARDING_STEPS.length - 1) ? 'Got it!' : 'Got it, next';
  }

  async function endOnboarding(){
    if(onboardingLastEl) onboardingLastEl.classList.remove('onboarding-highlight');
    document.getElementById('onboardingOverlay').style.display = 'none';
    currentUser.onboarding_seen = true;
    const { error } = await supabaseClient.from('profiles').update({ onboarding_seen: true }).eq('id', currentUser.id);
    if(error) console.error('Failed to save onboarding_seen:', error);
  }

  function maybeStartOnboarding(){
    if(currentUser.onboarding_seen) return;
    onboardingIndex = 0;
    document.getElementById('onboardingOverlay').style.display = 'flex';
    showOnboardingStep(0);
  }

  document.getElementById('onboardingNext').onclick = () => {
    onboardingIndex++;
    if(onboardingIndex >= ONBOARDING_STEPS.length){ endOnboarding(); return; }
    showOnboardingStep(onboardingIndex);
  };
  document.getElementById('onboardingClose').onclick = endOnboarding;

  /* ================= player ================= */

  let library = [];        // every track ever added (links + local uploads + folder manifest)
  let playOrder = [];      // the track objects currently being played through, in order
  let currentIndex = -1;   // index into playOrder
  let activeScope = {type:'library'};
  let playlists = {};      // { name: [url, url, ...] }
  let recentlyPlayed = []; // track objects, most recent first
  let hideLocal = false;
  let repeatMode = 'off';  // 'off' | 'all' | 'one'
  let shuffleOn = false;
  let volume = 80;
  let dataSaver = false;
  let activeView = 'library';
  let activePlaylistName = null;

  let ytPlayer = null;
  let ytReady = false;
  let ytPendingId = null;
  let isPlaying = false;

  window.onYouTubeIframeAPIReady = function(){
    ytReady = true;
    if(ytPendingId){ createYtPlayer(ytPendingId); ytPendingId = null; }
  };

  function extractYouTubeId(url){
    const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function detectType(url){
    const ytId = extractYouTubeId(url);
    if(ytId) return {type:'youtube', id:ytId};
    if(/\.(mp3|wav|ogg|m4a|flac|aac)(\?.*)?$/i.test(url)) return {type:'audio'};
    if(/soundcloud\.com/i.test(url)) return {type:'soundcloud'};
    return {type:'generic'};
  }

  function shortLabel(url, type){
    try{
      const u = new URL(url);
      if(type === 'audio') return decodeURIComponent(u.pathname.split('/').pop());
      return u.hostname.replace('www.','');
    }catch(e){
      return url.slice(0,40);
    }
  }

  function escapeHtml(s){
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---------- adding tracks ---------- */

  function isDuplicateTitle(title, excludeTrack){
    const normalized = normalizeForSearch(title);
    return library.some(t => t !== excludeTrack && normalizeForSearch(t.title) === normalized);
  }

  function addTrack(url){
    url = url.trim();
    if(!url) return;
    const info = detectType(url);
    const title = info.type === 'youtube' ? 'Loading title…' : shortLabel(url, info.type);

    if(info.type !== 'youtube' && isDuplicateTitle(title)){
      showToast('Already in the library — skipped duplicate');
      return;
    }

    const track = { url, type: info.type, ytId: info.id || null, title };
    library.push(track);
    if(info.type === 'youtube'){
      fetchYoutubeTitle(track); // duplicate check happens once the real title resolves
    } else {
      saveSharedTrack(track);
    }
    renderLibrary();
    if(currentIndex === -1){
      setScopeLibrary();
      const idx = playOrder.findIndex(t => t.url === track.url);
      if(idx > -1) playIndex(idx);
    }
  }

  async function saveSharedTrack(track){
    try{
      const { error } = await supabaseClient.from('shared_tracks').upsert({
        url: track.url,
        type: track.type,
        yt_id: track.ytId,
        title: track.title,
        added_by: currentUser.id
      }, { onConflict: 'url' });
      if(error && error.code === '23505'){
        // Someone else added the same song title just before this saved --
        // remove the duplicate from view rather than showing it twice.
        library = library.filter(t => t !== track);
        renderLibrary();
        showToast('Already in the library — skipped duplicate: ' + track.title);
      }
    }catch(e){ /* non-critical */ }
  }

  async function loadSharedTracks(){
    try{
      const { data } = await supabaseClient.from('shared_tracks').select('*');
      (data || []).forEach(row => {
        if(library.some(t => t.url === row.url)) return;
        if(isDuplicateTitle(row.title)) return; // same song already present from another source
        library.push({
          url: row.url,
          type: row.type,
          ytId: row.yt_id,
          title: row.title
        });
      });
      renderLibrary();
    }catch(e){ /* shared library unavailable */ }
  }

  async function addLocalFiles(files){
    const fileList = Array.from(files);
    if(fileList.length === 0) return;

    const existingTitles = new Set(library.map(t => normalizeForSearch(t.title)));
    const toUpload = [];
    let skipped = 0;
    fileList.forEach(file => {
      const title = file.name.replace(/\.[^/.]+$/, '');
      const normalized = normalizeForSearch(title);
      if(existingTitles.has(normalized)){
        skipped++;
      } else {
        existingTitles.add(normalized); // also catch duplicates within this same batch
        toUpload.push(file);
      }
    });

    if(toUpload.length === 0){
      showToast(skipped > 0
        ? `Skipped ${skipped} song${skipped > 1 ? 's' : ''} — already in the library`
        : 'Nothing to upload');
      return;
    }

    showToast(`Uploading ${toUpload.length} song${toUpload.length > 1 ? 's' : ''}…`);
    let uploaded = 0;
    let lastError = null;
    for(const file of toUpload){
      try{
        const path = currentUser.id + '/' + Date.now() + '-' + file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const { error: uploadError } = await supabaseClient.storage.from('music').upload(path, file);
        if(uploadError){ lastError = uploadError; console.error('Song upload failed:', uploadError); continue; }
        const { data } = supabaseClient.storage.from('music').getPublicUrl(path);
        const track = {
          url: data.publicUrl,
          type: 'audio',
          ytId: null,
          title: file.name.replace(/\.[^/.]+$/, '')
        };
        library.push(track);
        saveSharedTrack(track);
        uploaded++;
      }catch(e){ lastError = e; console.error('Song upload failed:', e); }
    }
    renderLibrary();
    if(currentIndex === -1 && library.length > 0){
      setScopeLibrary();
      if(playOrder.length > 0) playIndex(0);
    }

    let summary = [];
    if(uploaded > 0) summary.push(`Uploaded ${uploaded} song${uploaded > 1 ? 's' : ''} — visible to everyone now`);
    if(skipped > 0) summary.push(`skipped ${skipped} duplicate${skipped > 1 ? 's' : ''}`);
    if(uploaded === 0 && skipped === 0) summary.push('Upload failed: ' + (lastError ? lastError.message : 'unknown error') + ' (check console for details)');
    showToast(summary.join(', '));
  }

  function showToast(message){
    let toast = document.getElementById('tapeDeckToast');
    if(!toast){
      toast = document.createElement('div');
      toast.id = 'tapeDeckToast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 4000);
  }

  async function fetchYoutubeTitle(track){
    try{
      const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(track.url) + '&format=json');
      if(res.ok){
        const data = await res.json();
        if(isDuplicateTitle(data.title, track)){
          library = library.filter(t => t !== track);
          renderLibrary();
          showToast('Already in the library — skipped duplicate: ' + data.title);
          return;
        }
        track.title = data.title;
        renderLibrary();
        saveSharedTrack(track);
        if(playOrder[currentIndex] === track) updateNowPlaying();
      }
    }catch(e){
      track.title = 'YouTube video';
      renderLibrary();
    }
  }

  async function loadLibrary(){
    try{
      const res = await fetch('music/songs.json');
      if(!res.ok) return;
      const files = await res.json();
      files.forEach(entry => {
        // entry can be a plain filename ("song.mp3", served from the local
        // music/ folder) or a full URL (e.g. a Cloudflare R2 link) --
        // either works.
        const isFullUrl = /^https?:\/\//i.test(entry);
        const url = isFullUrl ? entry : 'music/' + encodeURIComponent(entry);
        if(library.some(t => t.url === url)) return;
        const nameOnly = isFullUrl ? decodeURIComponent(entry.split('/').pop()) : entry;
        const title = nameOnly.replace(/\.[^/.]+$/, '');
        if(isDuplicateTitle(title)) return; // same song already present from another source
        library.push({
          url,
          type: 'audio',
          ytId: null,
          title
        });
      });
      renderLibrary();
    }catch(e){ /* no local music library found */ }
  }

  /* ---------- scopes (what "next/prev" walks through) ---------- */

  function filteredLibrary(){
    return hideLocal ? library.filter(t => t.type !== 'local') : library.slice();
  }

  function shuffleArray(arr){
    for(let i = arr.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function setScopeLibrary(){
    activeScope = {type:'library'};
    playOrder = filteredLibrary();
    if(shuffleOn) shuffleArray(playOrder);
  }

  function setScopePlaylist(name){
    activeScope = {type:'playlist', name};
    const urls = playlists[name] || [];
    playOrder = urls.map(u => library.find(t => t.url === u)).filter(Boolean);
    if(shuffleOn) shuffleArray(playOrder);
  }

  function playAdhoc(track){
    activeScope = {type:'adhoc'};
    playOrder = [track];
    playIndex(0);
  }

  /* ---------- playback ---------- */

  function recordRecentlyPlayed(track){
    recentlyPlayed = recentlyPlayed.filter(t => t.url !== track.url);
    recentlyPlayed.unshift(track);
    if(recentlyPlayed.length > 20) recentlyPlayed = recentlyPlayed.slice(0, 20);
    if(activeView === 'recent') renderRecent();
    renderHomeDashboard();
  }

  function stopAll(){
    document.getElementById('ytHolder').style.display = 'none';
    document.getElementById('genericHolder').style.display = 'none';
    document.getElementById('genericHolder').innerHTML = '';
    const audio = document.getElementById('audioPlayer');
    audio.pause();
    audio.style.display = 'none';
    if(ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    stopProgressTracking();
    resetSeekUI();
    setSpinning(false);
    markPaused();
    updatePlayIcon();
  }

  /* ---- seek bar / elapsed & remaining time ---- */

  let seeking = false;
  let ytProgressInterval = null;

  function formatTime(seconds){
    if(!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function updateSeekUI(current, duration){
    const bar = document.getElementById('seekBar');
    const miniBar = document.getElementById('miniSeekBar');
    if(duration && !seeking){ bar.max = duration; miniBar.max = duration; }
    if(!seeking){ bar.value = current; miniBar.value = current; }
    document.getElementById('timeElapsed').textContent = formatTime(current);
    document.getElementById('timeRemaining').textContent = '-' + formatTime(Math.max(0, (duration || 0) - current));
  }

  function resetSeekUI(){
    document.getElementById('seekBar').value = 0;
    document.getElementById('seekBar').max = 0;
    document.getElementById('miniSeekBar').value = 0;
    document.getElementById('miniSeekBar').max = 0;
    document.getElementById('timeElapsed').textContent = '0:00';
    document.getElementById('timeRemaining').textContent = '-0:00';
  }

  function stopProgressTracking(){
    if(ytProgressInterval){ clearInterval(ytProgressInterval); ytProgressInterval = null; }
  }

  function startYtProgressTracking(){
    stopProgressTracking();
    ytProgressInterval = setInterval(() => {
      if(ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getDuration){
        updateSeekUI(ytPlayer.getCurrentTime(), ytPlayer.getDuration() || 0);
      }
    }, 500);
  }

  const audioPlayerEl = document.getElementById('audioPlayer');
  audioPlayerEl.addEventListener('timeupdate', () => {
    updateSeekUI(audioPlayerEl.currentTime, audioPlayerEl.duration || 0);
  });
  audioPlayerEl.addEventListener('loadedmetadata', () => {
    document.getElementById('seekBar').max = audioPlayerEl.duration || 0;
  });

  function handleSeekInput(value){
    seeking = true;
    document.getElementById('timeElapsed').textContent = formatTime(value);
    document.getElementById('seekBar').value = value;
    document.getElementById('miniSeekBar').value = value;
  }

  function handleSeekCommit(value){
    const track = playOrder[currentIndex];
    if(track && (track.type === 'audio' || track.type === 'local')){
      audioPlayerEl.currentTime = value;
    } else if(track && track.type === 'youtube' && ytPlayer && ytPlayer.seekTo){
      ytPlayer.seekTo(value, true);
    }
    seeking = false;
  }

  document.getElementById('seekBar').addEventListener('input', (e) => handleSeekInput(Number(e.target.value)));
  document.getElementById('seekBar').addEventListener('change', (e) => handleSeekCommit(Number(e.target.value)));
  document.getElementById('miniSeekBar').addEventListener('click', (e) => e.stopPropagation());
  document.getElementById('miniSeekBar').addEventListener('input', (e) => { e.stopPropagation(); handleSeekInput(Number(e.target.value)); });
  document.getElementById('miniSeekBar').addEventListener('change', (e) => { e.stopPropagation(); handleSeekCommit(Number(e.target.value)); });

  function playIndex(i){
    if(i < 0 || i >= playOrder.length) return;
    stopAll();
    currentIndex = i;
    const track = playOrder[i];
    updateNowPlaying();
    recordRecentlyPlayed(track);
    logListeningEvent(track);

    if(track.type === 'youtube'){
      document.getElementById('ytHolder').style.display = 'block';
      if(!ytReady){
        ytPendingId = track.ytId;
      } else if(!ytPlayer){
        createYtPlayer(track.ytId);
      } else {
        ytPlayer.loadVideoById(track.ytId);
      }
    } else if(track.type === 'audio' || track.type === 'local'){
      const audio = document.getElementById('audioPlayer');
      audio.style.display = 'block';
      audio.src = track.url;
      audio.volume = volume / 100;
      audio.play().then(()=>{ markPlaying(); setSpinning(true); updatePlayIcon(); }).catch(()=>{});
      audio.onended = handleTrackEnded;
      audio.onpause = () => { markPaused(); setSpinning(false); updatePlayIcon(); };
      audio.onplay = () => { markPlaying(); setSpinning(true); updatePlayIcon(); };
    } else if(track.type === 'soundcloud'){
      const holder = document.getElementById('genericHolder');
      holder.style.display = 'block';
      holder.innerHTML = `<iframe src="https://w.soundcloud.com/player/?url=${encodeURIComponent(track.url)}&auto_play=true"></iframe>`;
      markPlaying(); setSpinning(true); updatePlayIcon();
    } else {
      const holder = document.getElementById('genericHolder');
      holder.style.display = 'block';
      holder.innerHTML = `<iframe src="${track.url}" allow="autoplay"></iframe>`;
      markPlaying(); setSpinning(true); updatePlayIcon();
    }
    renderLibrary();
    if(activeView === 'playlists') renderPlaylists();
    preloadNextTrack();
  }

  function preloadNextTrack(){
    const next = playOrder[currentIndex + 1];
    const preload = document.getElementById('preloadAudio');
    if(next && (next.type === 'audio' || next.type === 'local')){
      if(preload.src !== next.url){
        preload.src = next.url;
        preload.load(); // starts fetching in the background; browser cache
                          // serves it instantly when the real player needs it
      }
    } else {
      preload.removeAttribute('src');
    }
  }

  function createYtPlayer(id){
    ytPlayer = new YT.Player('ytHolder', {
      videoId: id,
      playerVars: { autoplay: dataSaver ? 0 : 1 },
      events: {
        onReady: (e) => {
          e.target.setVolume(volume);
          if(!dataSaver){ e.target.playVideo(); markPlaying(); setSpinning(true); updatePlayIcon(); startYtProgressTracking(); }
        },
        onStateChange: (e) => {
          if(e.data === YT.PlayerState.ENDED) handleTrackEnded();
          if(e.data === YT.PlayerState.PLAYING){ markPlaying(); setSpinning(true); updatePlayIcon(); startYtProgressTracking(); }
          if(e.data === YT.PlayerState.PAUSED){ markPaused(); setSpinning(false); updatePlayIcon(); stopProgressTracking(); }
        }
      }
    });
  }

  function handleTrackEnded(){
    if(repeatMode === 'one'){
      playIndex(currentIndex);
      return;
    }
    if(currentIndex < playOrder.length - 1){
      playIndex(currentIndex + 1);
    } else if(repeatMode === 'all' && playOrder.length > 0){
      if(shuffleOn) shuffleArray(playOrder);
      playIndex(0);
    } else if(activeScope.type === 'adhoc' && library.length > 1){
      // A single searched/recently-played track ended with nothing queued
      // after it -- keep the music going instead of stopping dead.
      const justPlayed = playOrder[currentIndex];
      const candidates = library.filter(t => t.url !== justPlayed.url);
      const next = candidates[Math.floor(Math.random() * candidates.length)];
      playAdhoc(next);
    } else {
      stopAll();
    }
  }

  function updateNowPlaying(){
    const t = playOrder[currentIndex];
    document.getElementById('trackTitle').textContent = t ? t.title : 'Nothing queued';
    let sub = 'Add a link below to get started';
    if(t){
      if(t.type === 'local') sub = 'Playing from this device';
      else if(activeScope.type === 'playlist') sub = 'Playlist: ' + activeScope.name;
      else sub = 'Now playing';
    }
    document.getElementById('trackSub').textContent = sub;
    document.getElementById('ctrTotal').textContent = String(playOrder.length).padStart(3,'0');
    document.getElementById('ctrCurrent').textContent = String(currentIndex+1).padStart(3,'0');
    document.getElementById('prevBtn').disabled = currentIndex <= 0;
    document.getElementById('nextBtn').disabled = currentIndex >= playOrder.length - 1 || currentIndex === -1;
    updateMediaSession(t);
    updateMiniPlayer(t);
  }

  function updateMiniPlayer(track){
    const bar = document.getElementById('miniPlayer');
    if(!track){ bar.style.display = 'none'; return; }
    bar.style.display = isNowPlayingOpen() ? 'none' : 'flex';
    document.getElementById('miniPlayerTitle').textContent = track.title;
  }

  function updateMediaSession(track){
    if(!('mediaSession' in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: 'Tape Deck',
      album: activeScope.type === 'playlist' ? activeScope.name : 'Library',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  }

  if('mediaSession' in navigator){
    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
  }

  function setSpinning(on){
    document.getElementById('reelL').classList.toggle('spin', on);
    document.getElementById('reelR').classList.toggle('spin', on);
  }

  function updatePlayIcon(){
    const icon = isPlaying ? '&#10074;&#10074;' : '&#9654;';
    document.getElementById('playBtn').innerHTML = icon;
    document.getElementById('miniPlayerPlayBtn').innerHTML = icon;
  }

  function togglePlayPause(){
    if(currentIndex === -1){
      setScopeLibrary();
      if(playOrder.length === 0) return; // library is genuinely empty, nothing to play
      const startAt = Math.floor(Math.random() * playOrder.length);
      playIndex(startAt);
      return;
    }
    const track = playOrder[currentIndex];
    if(track.type === 'youtube' && ytPlayer){
      isPlaying ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
    } else if(track.type === 'audio' || track.type === 'local'){
      const audio = document.getElementById('audioPlayer');
      isPlaying ? audio.pause() : audio.play();
    }
  }

  function playNext(){ if(currentIndex < playOrder.length - 1) playIndex(currentIndex + 1); }
  function playPrev(){ if(currentIndex > 0) playIndex(currentIndex - 1); }

  /* ---------- library panel ---------- */

  function makeTrackRow(track, {onClick, isActive, showPlaylistSelect, onRemove, removeLabel, tag, confirmMessage}){
    const item = document.createElement('div');
    item.className = 'queue-item' + (isActive ? ' active' : '');
    item.onclick = onClick;

    const idxOrTag = document.createElement('span');
    idxOrTag.className = 'queue-index';
    idxOrTag.textContent = tag || '';
    item.appendChild(idxOrTag);

    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = track.title;
    item.appendChild(title);

    if(track.type === 'local'){
      const badge = document.createElement('span');
      badge.className = 'queue-type';
      badge.textContent = 'this device';
      item.appendChild(badge);
    }

    if(showPlaylistSelect){
      const names = Object.keys(playlists);
      const select = document.createElement('select');
      select.className = 'playlist-select';
      select.onclick = (e) => e.stopPropagation();
      if(names.length === 0){
        select.innerHTML = '<option>No playlists</option>';
        select.disabled = true;
      } else {
        select.innerHTML = '<option value="" selected disabled>Add to…</option>' +
          names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        select.onchange = () => {
          if(select.value){ addToPlaylist(select.value, track.url); select.value = ''; }
        };
      }
      item.appendChild(select);
    }

    if(track.type === 'audio' || track.type === 'local'){
      const dl = document.createElement('button');
      dl.className = 'download-btn';
      dl.title = 'Download';
      dl.innerHTML = '&#8595;';
      dl.onclick = async (e) => {
        e.stopPropagation();
        if(track.type === 'local'){
          // Local uploads are already a same-origin blob URL -- the simple
          // approach works fine and is instant.
          const a = document.createElement('a');
          a.href = track.url;
          a.download = track.title;
          a.click();
          return;
        }
        dl.innerHTML = '&#8230;';
        try{
          const res = await fetch(track.url);
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = track.title;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        }catch(err){
          showToast('Download failed — opening in a new tab instead');
          window.open(track.url, '_blank');
        }
        dl.innerHTML = '&#8595;';
      };
      item.appendChild(dl);
    }

    if(onRemove){
      const rm = document.createElement('button');
      rm.className = 'remove-btn';
      rm.innerHTML = removeLabel || '&times;';
      rm.title = 'Remove';
      rm.onclick = (e) => {
        e.stopPropagation();
        if(confirmMessage && !confirm(confirmMessage)) return;
        onRemove();
      };
      item.appendChild(rm);
    }

    return item;
  }

  function renderHomeDashboard(){
    // Suggested: a handful of random songs from the library, refreshed
    // whenever the library changes.
    const suggestedBox = document.getElementById('suggestedGrid');
    if(library.length === 0){
      suggestedBox.innerHTML = '<div class="dashboard-empty">No songs yet — paste a link or upload one above.</div>';
    } else {
      const shuffled = library.slice().sort(() => Math.random() - 0.5).slice(0, 6);
      suggestedBox.innerHTML = '';
      shuffled.forEach(t => {
        const tile = document.createElement('div');
        tile.className = 'dashboard-tile';
        tile.innerHTML = `<div class="dashboard-tile-icon">&#9835;</div><div class="dashboard-tile-title">${escapeHtml(t.title)}</div>`;
        tile.onclick = () => playAdhoc(t);
        suggestedBox.appendChild(tile);
      });
    }

    // Playlists
    const playlistBox = document.getElementById('dashPlaylistsGrid');
    const playlistNames = Object.keys(playlists);
    if(playlistNames.length === 0){
      playlistBox.innerHTML = '<div class="dashboard-empty">No playlists yet.</div>';
    } else {
      playlistBox.innerHTML = '';
      playlistNames.slice(0, 6).forEach(name => {
        const tile = document.createElement('div');
        tile.className = 'dashboard-tile';
        tile.innerHTML = `<div class="dashboard-tile-icon">&#9776;</div><div class="dashboard-tile-title">${escapeHtml(name)}</div>`;
        tile.onclick = () => {
          switchView('playlists');
          activePlaylistName = name;
          renderPlaylistsPanelOnly();
        };
        playlistBox.appendChild(tile);
      });
    }

    // Recently played
    const recentBox = document.getElementById('dashRecentGrid');
    if(recentlyPlayed.length === 0){
      recentBox.innerHTML = '<div class="dashboard-empty">Nothing played yet.</div>';
    } else {
      recentBox.innerHTML = '';
      recentlyPlayed.slice(0, 6).forEach(t => {
        const tile = document.createElement('div');
        tile.className = 'dashboard-tile';
        tile.innerHTML = `<div class="dashboard-tile-icon">&#9835;</div><div class="dashboard-tile-title">${escapeHtml(t.title)}</div>`;
        tile.onclick = () => playAdhoc(t);
        recentBox.appendChild(tile);
      });
    }
  }

  function renderPlaylistsPanelOnly(){
    document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.view === 'playlists'));
    document.querySelectorAll('.panel').forEach(p => p.style.display = 'none');
    document.getElementById('playlistsPanel').style.display = 'block';
    renderPlaylists();
  }

  function renderLibrary(){
    const list = document.getElementById('queueList');
    const navBar = document.getElementById('libraryAlphaNav');
    list.innerHTML = '';
    const tracks = filteredLibrary();
    document.getElementById('libraryCount').textContent = tracks.length;
    if(tracks.length === 0){
      list.innerHTML = '<div class="empty">Nothing here yet. Paste a link or upload a song above.</div>';
      navBar.innerHTML = '';
      renderHomeDashboard();
      return;
    }

    // Sorted alphabetically for browsing only -- actual playback order
    // (setScopeLibrary/filteredLibrary) is untouched by this and keeps
    // playing in the original add order.
    const sorted = tracks.slice().sort((a, b) => a.title.localeCompare(b.title, undefined, {sensitivity:'base'}));
    const groups = {};
    sorted.forEach(t => {
      const letter = /[a-zA-Z]/.test(t.title[0]) ? t.title[0].toUpperCase() : '#';
      if(!groups[letter]) groups[letter] = [];
      groups[letter].push(t);
    });
    const letters = Object.keys(groups).sort();

    navBar.innerHTML = letters.map(l => `<button class="alpha-btn" data-letter="${l}">${l}</button>`).join('');
    navBar.querySelectorAll('.alpha-btn').forEach(btn => {
      btn.onclick = () => {
        const el = document.getElementById('lib-letter-' + btn.dataset.letter);
        if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    let counter = 0;
    letters.forEach(letter => {
      const header = document.createElement('div');
      header.className = 'alpha-header';
      header.id = 'lib-letter-' + letter;
      header.textContent = letter;
      list.appendChild(header);
      groups[letter].forEach(t => {
        counter++;
        const isActive = activeScope.type === 'library' && playOrder[currentIndex] && playOrder[currentIndex].url === t.url;
        const canRemove = t.type === 'local' || currentUser.is_admin;
        const row = makeTrackRow(t, {
          tag: String(counter).padStart(2,'0'),
          isActive,
          showPlaylistSelect: true,
          onClick: () => {
            setScopeLibrary();
            const idx = playOrder.findIndex(pt => pt.url === t.url);
            if(idx > -1) playIndex(idx);
          },
          onRemove: canRemove ? () => removeFromLibrary(t) : null,
          confirmMessage: t.type === 'local'
            ? 'Remove this song from your device?'
            : `Remove "${t.title}" for every user of this app? This can't be undone.`
        });
        list.appendChild(row);
      });
    });
    renderHomeDashboard();
  }

  async function removeFromLibrary(track){
    if(track.type === 'local'){
      URL.revokeObjectURL(track.url);
    } else {
      // Only admin accounts can delete a shared track, period -- enforced
      // both here and at the database level (Row Level Security).
      if(!currentUser.is_admin){
        alert("Only the app's admin can remove songs from the shared library.");
        return;
      }
      const { error } = await supabaseClient.from('shared_tracks').delete().eq('url', track.url);
      if(error){
        alert('Could not remove this song: ' + error.message);
        return; // don't touch the local view if the real deletion failed
      }
    }
    library = library.filter(t => t !== track);
    for(const name of Object.keys(playlists)){
      if(playlists[name].includes(track.url)){
        playlists[name] = playlists[name].filter(u => u !== track.url);
        savePlaylistTracks(name);
      }
    }
    if(playOrder[currentIndex] === track){
      stopAll();
      currentIndex = -1;
      updateNowPlaying();
    }
    renderLibrary();
    if(activeView === 'playlists') renderPlaylists();
  }

  /* ---------- playlists panel ---------- */

  async function savePlaylistTracks(name){
    try{
      await supabaseClient.from('playlists')
        .update({ track_urls: playlists[name] })
        .eq('user_id', currentUser.id).eq('name', name);
    }catch(e){ /* will retry on next change */ }
  }

  async function createPlaylist(name){
    name = name.trim();
    if(!name || playlists[name]) return;
    playlists[name] = [];
    activePlaylistName = name;
    renderPlaylists();
    try{
      await supabaseClient.from('playlists').insert({ user_id: currentUser.id, name, track_urls: [] });
    }catch(e){ /* will still work locally this session */ }
  }

  function addToPlaylist(name, url){
    if(!playlists[name]) return;
    if(!playlists[name].includes(url)) playlists[name].push(url);
    savePlaylistTracks(name);
    if(activeView === 'playlists') renderPlaylists();
  }

  function removeFromPlaylist(name, url){
    if(!playlists[name]) return;
    playlists[name] = playlists[name].filter(u => u !== url);
    savePlaylistTracks(name);
    renderPlaylists();
  }

  async function deletePlaylist(name){
    delete playlists[name];
    if(activePlaylistName === name) activePlaylistName = null;
    renderPlaylists();
    try{
      await supabaseClient.from('playlists').delete().eq('user_id', currentUser.id).eq('name', name);
    }catch(e){ /* non-critical */ }
  }

  function renderPlaylists(){
    renderHomeDashboard();
    const chips = document.getElementById('playlistChips');
    const names = Object.keys(playlists);
    chips.innerHTML = '';
    if(names.length === 0){
      chips.innerHTML = '<p class="hint" style="margin:0 0 1rem;">No playlists yet — create one above.</p>';
    } else {
      names.forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'playlist-chip' + (activePlaylistName === name ? ' active' : '');
        const label = document.createElement('span');
        label.textContent = name + ' (' + playlists[name].length + ')';
        label.onclick = () => { activePlaylistName = name; renderPlaylists(); };
        chip.appendChild(label);
        const x = document.createElement('button');
        x.className = 'chip-x';
        x.innerHTML = '&times;';
        x.title = 'Delete playlist';
        x.onclick = (e) => { e.stopPropagation(); deletePlaylist(name); };
        chip.appendChild(x);
        chips.appendChild(chip);
      });
    }

    const tracksEl = document.getElementById('playlistTracks');
    tracksEl.innerHTML = '';
    if(!activePlaylistName || !playlists[activePlaylistName]){
      if(names.length > 0) tracksEl.innerHTML = '<div class="empty">Pick a playlist above to see its songs.</div>';
      return;
    }
    const urls = playlists[activePlaylistName];
    const tracks = urls.map(u => library.find(t => t.url === u)).filter(Boolean);
    if(tracks.length === 0){
      tracksEl.innerHTML = '<div class="empty">This playlist is empty. Add songs from the Library tab.</div>';
      return;
    }
    tracks.forEach((t, i) => {
      const isActive = activeScope.type === 'playlist' && activeScope.name === activePlaylistName &&
        playOrder[currentIndex] && playOrder[currentIndex].url === t.url;
      const row = makeTrackRow(t, {
        tag: String(i+1).padStart(2,'0'),
        isActive,
        showPlaylistSelect: false,
        onClick: () => {
          setScopePlaylist(activePlaylistName);
          const idx = playOrder.findIndex(pt => pt.url === t.url);
          if(idx > -1) playIndex(idx);
        },
        onRemove: () => removeFromPlaylist(activePlaylistName, t.url)
      });
      tracksEl.appendChild(row);
    });
  }

  /* ---------- recently played panel ---------- */

  function renderRecent(){
    const list = document.getElementById('recentList');
    list.innerHTML = '';
    if(recentlyPlayed.length === 0){
      list.innerHTML = '<div class="empty">Nothing played yet.</div>';
      return;
    }
    recentlyPlayed.forEach((t, i) => {
      const isActive = playOrder[currentIndex] && playOrder[currentIndex].url === t.url;
      const row = makeTrackRow(t, {
        tag: String(i+1).padStart(2,'0'),
        isActive,
        showPlaylistSelect: false,
        onClick: () => playAdhoc(t)
      });
      list.appendChild(row);
    });
  }

  /* ---------- view switching ---------- */

  function switchView(view){
    activeView = view;
    ['library','playlists','recent','people','messages'].forEach(v => {
      const tabId = 'tab' + v.charAt(0).toUpperCase() + v.slice(1);
      const tabEl = document.getElementById(tabId);
      if(tabEl) tabEl.classList.toggle('active', v === view);
      document.getElementById(v + 'Panel').style.display = v === view ? 'block' : 'none';
    });
    if(view === 'library') renderLibrary();
    if(view === 'playlists') renderPlaylists();
    if(view === 'recent') renderRecent();
    if(view === 'people') renderPeopleView();
    if(view === 'messages') renderConversationList();
  }

  /* ---------- persistence ---------- */
  // library and recentlyPlayed no longer need their own persistence:
  // library is rebuilt each load from the shared_tracks table + music
  // manifest, and recentlyPlayed is rebuilt from your own listening_events.
  // Playlists and prefs (hideLocal/repeat/shuffle/volume/onboarding) are
  // stored for real in Supabase below.

  async function persistPrefs(){
    try{
      await supabaseClient.from('profiles')
        .update({ prefs: { hideLocal, repeatMode, shuffleOn, volume, dataSaver } })
        .eq('id', currentUser.id);
    }catch(e){ /* will retry on next change */ }
  }

  function restorePrefs(){
    const saved = (currentUser && currentUser.prefs) || {};
    if(typeof saved.hideLocal === 'boolean') hideLocal = saved.hideLocal;
    if(saved.repeatMode) repeatMode = saved.repeatMode;
    if(typeof saved.shuffleOn === 'boolean') shuffleOn = saved.shuffleOn;
    if(typeof saved.volume === 'number') volume = saved.volume;
    if(typeof saved.dataSaver === 'boolean') dataSaver = saved.dataSaver;
    document.getElementById('hideLocalToggle').checked = hideLocal;
    document.getElementById('volumeSlider').value = volume;
    updateRepeatBtn();
    updateShuffleBtn();
    updateDataSaverBtn();
  }

  async function restoreRecentFromHistory(){
    try{
      const { data } = await supabaseClient
        .from('listening_events')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('played_at', { ascending: false })
        .limit(60);
      const seen = new Set();
      recentlyPlayed = [];
      (data || []).forEach(ev => {
        if(!ev.url || seen.has(ev.url)) return;
        seen.add(ev.url);
        recentlyPlayed.push({ url: ev.url, type: ev.type || 'audio', ytId: ev.yt_id, title: ev.track_title });
        if(recentlyPlayed.length >= 20) return;
      });
    }catch(e){ /* no history yet */ }
  }

  async function loadPlaylistsFromDb(){
    try{
      const { data } = await supabaseClient.from('playlists').select('*').eq('user_id', currentUser.id);
      playlists = {};
      (data || []).forEach(row => { playlists[row.name] = row.track_urls || []; });
    }catch(e){ /* none yet */ }
  }

  function updateRepeatBtn(){
    const btn = document.getElementById('repeatBtn');
    btn.textContent = 'Repeat: ' + repeatMode;
    btn.classList.toggle('active', repeatMode !== 'off');
  }

  function updateShuffleBtn(){
    document.getElementById('shuffleBtn').classList.toggle('active', shuffleOn);
  }

  /* ---------- wiring ---------- */

  document.getElementById('addBtn').onclick = () => {
    const input = document.getElementById('urlInput');
    addTrack(input.value);
    input.value = '';
  };
  document.getElementById('urlInput').addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ addTrack(e.target.value); e.target.value = ''; }
  });
  document.getElementById('fileInput').addEventListener('change', (e) => {
    addLocalFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('playBtn').onclick = togglePlayPause;
  document.getElementById('nextBtn').onclick = playNext;
  document.getElementById('prevBtn').onclick = playPrev;

  /* ---- mini player + bottom nav ---- */

  document.getElementById('miniPlayerPlayBtn').onclick = (e) => {
    e.stopPropagation();
    togglePlayPause();
  };
  function openNowPlaying(){
    document.getElementById('homeContent').style.display = 'none';
    document.getElementById('nowPlayingView').style.display = 'block';
    document.getElementById('miniPlayer').style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeNowPlaying(){
    document.getElementById('nowPlayingView').style.display = 'none';
    document.getElementById('homeContent').style.display = 'block';
    if(playOrder[currentIndex]) document.getElementById('miniPlayer').style.display = 'flex';
  }

  function isNowPlayingOpen(){
    return document.getElementById('nowPlayingView').style.display !== 'none';
  }

  document.getElementById('miniPlayerRow').onclick = () => {
    openNowPlaying();
  };
  document.getElementById('fullscreenClose').onclick = () => {
    closeNowPlaying();
  };

  function setBottomNavActive(name){
    document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.nav === name);
    });
  }

  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.nav;
      if(isNowPlayingOpen()) closeNowPlaying();
      if(action === 'home'){
        switchView('library');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setBottomNavActive('home');
      } else if(action === 'search'){
        document.getElementById('searchToggleBtn').click();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if(action === 'add'){
        switchView('playlists');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => document.getElementById('playlistNameInput').focus(), 300);
        setBottomNavActive('add');
      } else if(action === 'messages'){
        switchView('messages');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setBottomNavActive('messages');
      } else if(action === 'people'){
        switchView('people');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setBottomNavActive('people');
      }
    };
  });

  document.getElementById('libraryToggle').onclick = () => {
    const list = document.getElementById('queueList');
    const btn = document.getElementById('libraryToggle');
    const showing = list.style.display !== 'none';
    list.style.display = showing ? 'none' : 'block';
    btn.innerHTML = (showing ? 'Show library (' : 'Hide library (') + '<span id="libraryCount">' + filteredLibrary().length + '</span> songs)';
  };

  document.getElementById('shuffleBtn').onclick = () => {
    shuffleOn = !shuffleOn;
    updateShuffleBtn();
    persistPrefs();
  };

  document.getElementById('repeatBtn').onclick = () => {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    updateRepeatBtn();
    persistPrefs();
  };

  document.getElementById('volumeSlider').addEventListener('input', (e) => {
    volume = Number(e.target.value);
    const audio = document.getElementById('audioPlayer');
    audio.volume = volume / 100;
    if(ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(volume);
    persistPrefs();
  });

  document.getElementById('hideLocalToggle').addEventListener('change', (e) => {
    hideLocal = e.target.checked;
    renderLibrary();
    persistPrefs();
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  document.getElementById('createPlaylistBtn').onclick = () => {
    const input = document.getElementById('playlistNameInput');
    createPlaylist(input.value);
    input.value = '';
  };
  document.getElementById('playlistNameInput').addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ createPlaylist(e.target.value); e.target.value = ''; }
  });

  /* ---------- init ---------- */

  async function init(){
    const profile = await requireAuth();
    if(!profile) return; // requireAuth already redirected to login.html

    updateProfileHeader();

    // Critical path first: get the library and playback state loaded
    // before anything else runs, so a failure in a secondary feature below
    // can never leave the queue looking empty.
    renderLibrary();
    renderPlaylists();
    renderRecent();
    restorePrefs();
    try{ await loadPlaylistsFromDb(); }catch(e){ console.error('loadPlaylistsFromDb failed:', e); }
    try{ await restoreRecentFromHistory(); }catch(e){ console.error('restoreRecentFromHistory failed:', e); }
    try{ await loadLibrary(); }catch(e){ console.error('loadLibrary failed:', e); }
    try{ await loadSharedTracks(); }catch(e){ console.error('loadSharedTracks failed:', e); }
    renderLibrary();
    renderPlaylists();
    renderRecent();

    // Secondary features -- each wrapped so one failing can't take down
    // anything else, including the critical path above.
    try{ updateNotifToggle(); }catch(e){ console.error(e); }
    try{ setupPresence(); }catch(e){ console.error(e); }
    try{ setupPlaybackSync(); }catch(e){ console.error(e); }
    try{ loadPeople(); }catch(e){ console.error(e); }
    try{ refreshUnreadCount(); }catch(e){ console.error(e); }
    try{ loadConversationOrder(); }catch(e){ console.error(e); }
    try{ subscribeToGlobalMessages(); }catch(e){ console.error(e); }
    try{ checkAnnouncements(); }catch(e){ console.error(e); }
    try{ checkWelcomeBanner(); }catch(e){ console.error(e); }
    try{ if(!currentUser.music_taste_prompted) showTasteBanner(); }catch(e){ console.error(e); }
    try{ maybeStartOnboarding(); }catch(e){ console.error(e); }
  }
  init();