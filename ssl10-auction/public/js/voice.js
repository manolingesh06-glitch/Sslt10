const joinBtn = document.getElementById('joinBtn');
const joinBtnTxt = document.getElementById('joinBtnTxt');
const micToggleBtn = document.getElementById('micToggleBtn');
const leaveVoiceBtn = document.getElementById('leaveVoiceBtn');
const statusDiv = document.getElementById('status');
const voicePeopleBtn = document.getElementById('voicePeopleBtn');
const voicePeopleCount = document.getElementById('voicePeopleCount');
const voicePulseDot = document.getElementById('voicePulseDot');
const voiceDropdownHostRow = document.getElementById('voiceDropdownHostRow');
const muteAllBtn = document.getElementById('muteAllBtn');
const unmuteAllBtn = document.getElementById('unmuteAllBtn');
const voiceDropdown = document.getElementById('voiceDropdown');
const voiceDropdownBackdrop = document.getElementById('voiceDropdownBackdrop');
const voiceDropdownList = document.getElementById('voiceDropdownList');
const participantsDiv = voiceDropdownList; // legacy alias — dropdown list is the render target
const joinNameModalOverlay = document.getElementById('joinNameModalOverlay');
const joinNameInput = document.getElementById('joinNameInput');
const joinNameError = document.getElementById('joinNameError');
const joinNameCancelBtn = document.getElementById('joinNameCancelBtn');
const joinNameConfirmBtn = document.getElementById('joinNameConfirmBtn');

let room = null;      // tracks whether we're already connected
let micEnabled = true; // tracks mic state
let mutedRemotes = {}; // identity -> true/false, this listener's personal mute choices
let remoteMicMuted = {}; // identity -> true/false, that person's REAL mic state (visible to everyone)
let activeSpeakerIds = new Set(); // identities currently talking (LiveKit audio-level detection)
let connQuality = {}; // identity -> 'excellent' | 'good' | 'poor' | 'unknown'
let lastJoinUsername = null; // remembered so we can silently rejoin after a drop
let manualLeave = false;     // true once the user deliberately disconnects (not exposed yet, but guards future "Leave" button from auto-reconnecting)
let reconnectAttempt = 0;
let reconnectTimer = null;

function setVoiceDropdownOpen(open){
  voiceDropdown.classList.toggle('hidden', !open);
  voiceDropdownBackdrop.classList.toggle('show', open);
}

// Step 1: clicking the header button just opens the name modal
joinBtn.addEventListener('click', () => {
  if (room) {
    setVoiceDropdownOpen(voiceDropdown.classList.contains('hidden'));
    return;
  }
  joinNameError.textContent = '';
  // Prefill with the logged-in identity (team code for owners, HOST for the
  // host) so voice identities line up with franchise names in the dropdown —
  // still editable in case someone wants a different display name.
  try{
    if (session && session.role === 'host') joinNameInput.value = 'HOST';
    else if (session && session.team) joinNameInput.value = session.team;
    else joinNameInput.value = '';
  }catch(e){ joinNameInput.value = ''; }
  joinNameModalOverlay.style.display = 'flex';
  joinNameInput.focus();
  joinNameInput.select();
});

// Toggle the "who's in voice" dropdown open/closed
voicePeopleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setVoiceDropdownOpen(voiceDropdown.classList.contains('hidden'));
});
voiceDropdownBackdrop.addEventListener('click', () => setVoiceDropdownOpen(false));
document.addEventListener('click', (e) => {
  if (!voiceDropdown.classList.contains('hidden') &&
      !voiceDropdown.contains(e.target) && e.target !== voicePeopleBtn) {
    setVoiceDropdownOpen(false);
  }
});

joinNameCancelBtn.addEventListener('click', () => {
  joinNameModalOverlay.style.display = 'none';
});

joinNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinNameConfirmBtn.click();
});

// Step 2: modal's own Join button does the actual connecting
joinNameConfirmBtn.addEventListener('click', async () => {
  const username = joinNameInput.value.trim();
  if (!username) {
    joinNameError.textContent = 'Please enter a name.';
    return;
  }
  joinNameModalOverlay.style.display = 'none';
  lastJoinUsername = username;
  manualLeave = false;
  reconnectAttempt = 0;
  await connectToVoiceRoom(username, false);
});

// Removes any leftover hidden <audio> elements from a previous connection —
// called before a fresh connect/reconnect so nothing doubles up.
function clearVoiceAudioElements() {
  document.querySelectorAll('audio[id^="audio-"]').forEach(el => el.remove());
}

// Retry with growing delays (2s, 4s, 8s, 16s, 30s) up to 5 tries. After that
// we stop and let the person tap Join manually — avoids retrying forever if
// they've actually lost their network or left the auction.
function scheduleReconnect(username) {
  if (manualLeave) return;
  reconnectAttempt++;
  if (reconnectAttempt > 5) {
    statusDiv.innerText = "🔴 Connection lost — tap \"Join Voice\" to reconnect.";
    joinBtn.disabled = false;
    joinBtn.classList.remove('is-live');
    joinBtnTxt.innerText = "Join Voice";
    reconnectAttempt = 0;
    return;
  }
  const delaySec = Math.min(2 * Math.pow(2, reconnectAttempt - 1), 30);
  statusDiv.innerText = `🔴 Connection lost — retrying in ${delaySec}s… (attempt ${reconnectAttempt}/5)`;
  joinBtn.disabled = true;
  joinBtnTxt.innerText = "Reconnecting…";
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectToVoiceRoom(username, true), delaySec * 1000);
}

// Handles a FULL drop — i.e. LiveKit's own internal reconnection attempts
// (which cover brief network blips automatically) were exhausted. Resets
// the voice UI back to "not connected" and kicks off our own retry loop.
function handleFullDisconnect(username) {
  room = null;
  joinBtn.classList.remove('is-live');
  micToggleBtn.classList.add('hidden');
  leaveVoiceBtn.classList.add('hidden');
  voicePeopleCount.textContent = '0 in voice';
  voicePulseDot.classList.add('hidden');
  voiceDropdownHostRow.classList.add('hidden');
  voiceDropdownList.innerHTML = '<div class="voice-dropdown-empty">No one connected yet</div>';
  activeSpeakerIds = new Set();
  connQuality = {};
  clearVoiceAudioElements();
  scheduleReconnect(username);
}

async function connectToVoiceRoom(username, isRetry) {
  joinBtn.disabled = true;
  joinBtnTxt.innerText = isRetry ? "Reconnecting…" : "Connecting…";
  if (!isRetry) statusDiv.innerText = "";

  try {
    const res = await fetch(`https://auction-backend-8zyu.onrender.com/token?room=auction-room&username=${username}`);
    const data = await res.json();

    clearVoiceAudioElements();
    room = new LivekitClient.Room({
      // Turns on the browser's own built-in audio processing for the mic
      // capture — real noise suppression / echo cancellation / auto-gain,
      // no paid add-on needed. Every modern mobile/desktop browser ships this.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    await room.connect('wss://spl-season-3-s0vwgpsr.livekit.cloud', data.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    micEnabled = true;
    reconnectAttempt = 0;

    statusDiv.innerText = "";
    joinBtn.disabled = false;
    joinBtn.classList.add('is-live');
    joinBtnTxt.innerText = "Connected";
    micToggleBtn.classList.remove('hidden');
    micToggleBtn.classList.add('is-on');
    micToggleBtn.textContent = "🎤";
    micToggleBtn.title = "Mute microphone";
    leaveVoiceBtn.classList.remove('hidden');

    // Apply (or re-apply) this listener's personal mute choice to one participant's audio
    function applyMuteState(participant) {
      const muted = !!mutedRemotes[participant.identity];
      participant.audioTrackPublications.forEach(pub => {
        if (pub.track) pub.track.setVolume(muted ? 0 : 1);
      });
    }

    // Short 2-letter tag for the round avatar — team code as-is, or first
    // two letters of a free-typed name.
    function avatarTag(identity) {
      return (identity || '?').slice(0, 3).toUpperCase();
    }

    const isHost = !!(session && session.role === 'host');

    // Data-channel messaging so the host can ask someone else's device to
    // mute/unmute their own real microphone — a remote client can never
    // touch another participant's mic directly, only that person's own
    // client can, so we ask and their client complies automatically.
    const dataEncoder = new TextEncoder();
    const dataDecoder = new TextDecoder();
    function sendForceMic(targetIdentity, muted) {
      if (!isHost || !room) return;
      const payload = dataEncoder.encode(JSON.stringify({ type: 'force-mic', muted }));
      room.localParticipant.publishData(payload, { reliable: true, destinationIdentities: [targetIdentity] });
      // Optimistically reflect it immediately so the host's list feels responsive;
      // the real trackMuted/trackUnmuted event will confirm it shortly after.
      remoteMicMuted[targetIdentity] = muted;
      renderParticipantsList();
    }
    room.on('dataReceived', (payload, participant, kind, topic) => {
      try {
        const msg = JSON.parse(dataDecoder.decode(payload));
        if (msg && msg.type === 'force-mic') {
          micEnabled = !msg.muted;
          room.localParticipant.setMicrophoneEnabled(micEnabled);
          micToggleBtn.textContent = micEnabled ? "🎤" : "🔇";
          micToggleBtn.title = micEnabled ? "Mute microphone" : "Unmute microphone";
          micToggleBtn.classList.toggle('is-on', micEnabled);
          micToggleBtn.classList.toggle('is-off', !micEnabled);
          statusDiv.innerText = msg.muted ? "🔇 Host muted your mic" : "🎤 Host unmuted your mic";
          setTimeout(() => { statusDiv.innerText = ""; }, 3000);
        }
      } catch (e) { /* ignore malformed data messages */ }
    });

    // Small signal icon for a person's connection quality — helps everyone
    // (not just the host) see if someone's about to drop before they do.
    function qualityIcon(q){
      if(q === 'excellent' || q === 'good') return '📶';
      if(q === 'poor') return '📵';
      return '➖';
    }

    function renderParticipantsList() {
      const remotes = Array.from(room.remoteParticipants.values());
      const total = 1 + remotes.length; // you + everyone else in the room

      voicePeopleCount.textContent = total + ' in voice';
      voicePulseDot.classList.toggle('hidden', total === 0);
      voiceDropdownHostRow.classList.toggle('hidden', !isHost || remotes.length === 0);

      voiceDropdownList.innerHTML = '';

      // You, first
      const meRow = document.createElement('div');
      meRow.className = 'voice-row';
      meRow.innerHTML = `
        <div class="voice-avatar${activeSpeakerIds.has(room.localParticipant.identity) ? ' is-speaking' : ''}">${avatarTag(room.localParticipant.identity)}</div>
        <div class="voice-row-name">${room.localParticipant.identity}<span class="voice-row-you">YOU</span></div>
      `;
      voiceDropdownList.appendChild(meRow);

      remotes.forEach(p => {
        const isMuted = !!mutedRemotes[p.identity];
        const micOff = !!remoteMicMuted[p.identity];
        const row = document.createElement('div');
        row.className = 'voice-row';

        const avatar = document.createElement('div');
        avatar.className = 'voice-avatar' + (activeSpeakerIds.has(p.identity) ? ' is-speaking' : '');
        avatar.textContent = avatarTag(p.identity);

        const nameSpan = document.createElement('div');
        nameSpan.className = 'voice-row-name';
        nameSpan.textContent = p.identity;

        const connIcon = document.createElement('div');
        connIcon.className = 'voice-conn-quality';
        const q = connQuality[p.identity] || 'unknown';
        connIcon.title = p.identity + "'s connection: " + q;
        connIcon.textContent = qualityIcon(q);

        const micState = document.createElement('div');
        micState.className = 'voice-mic-state';
        micState.title = micOff ? p.identity + "'s mic is off" : p.identity + "'s mic is on";
        micState.textContent = micOff ? '🚫' : '🎤';

        const actions = document.createElement('div');
        actions.className = 'voice-row-actions';

        // Personal: only mutes this person for ME, everyone else still hears them
        const muteBtn = document.createElement('button');
        muteBtn.className = 'voice-row-mute-btn' + (isMuted ? ' is-muted' : '');
        muteBtn.title = (isMuted ? 'Unmute ' : 'Mute ') + p.identity + ' (for you only)';
        muteBtn.textContent = isMuted ? '🔇' : '🔊';
        muteBtn.onclick = () => {
          mutedRemotes[p.identity] = !mutedRemotes[p.identity];
          applyMuteState(p);
          renderParticipantsList();
        };
        actions.appendChild(muteBtn);

        // Host-only: actually mutes/unmutes their mic for the entire room
        if (isHost) {
          const forceBtn = document.createElement('button');
          forceBtn.className = 'voice-row-mute-btn is-host' + (micOff ? ' is-muted' : '');
          forceBtn.title = (micOff ? 'Unmute ' : 'Mute ') + p.identity + ' for everyone (host)';
          forceBtn.textContent = micOff ? '📢' : '🔇👥';
          forceBtn.onclick = () => sendForceMic(p.identity, !micOff);
          actions.appendChild(forceBtn);
        }

        row.appendChild(avatar);
        row.appendChild(nameSpan);
        row.appendChild(connIcon);
        row.appendChild(micState);
        row.appendChild(actions);
        voiceDropdownList.appendChild(row);
      });
    }

    // Host-only: mute/unmute every connected owner in one tap — handy right
    // as a new player comes up, to kill cross-talk before bidding starts.
    if (isHost) {
      muteAllBtn.onclick = () => {
        room.remoteParticipants.forEach(p => sendForceMic(p.identity, true));
      };
      unmuteAllBtn.onclick = () => {
        room.remoteParticipants.forEach(p => sendForceMic(p.identity, false));
      };
    }

    room.on('participantConnected', renderParticipantsList);
    room.on('participantDisconnected', (p) => {
      delete mutedRemotes[p.identity];
      delete remoteMicMuted[p.identity];
      delete connQuality[p.identity];
      activeSpeakerIds.delete(p.identity);
      renderParticipantsList();
    });
    // Highlights whoever's actively talking right now (LiveKit's own
    // audio-level detection) — fires with the full current list of speakers
    // each time it changes, local participant included.
    room.on('activeSpeakersChanged', (speakers) => {
      activeSpeakerIds = new Set(speakers.map(s => s.identity));
      renderParticipantsList();
    });
    // Per-person connection quality, visible to everyone in the dropdown —
    // a fair warning before someone's audio actually drops out.
    room.on('connectionQualityChanged', (quality, participant) => {
      if (participant === room.localParticipant) return;
      connQuality[participant.identity] = quality;
      renderParticipantsList();
    });
    // Track each participant's REAL mic state (visible to everyone) so the
    // host's "force mute" button always reflects what's actually true.
    room.on('trackMuted', (pub, participant) => {
      if (pub.kind === 'audio' && participant !== room.localParticipant) {
        remoteMicMuted[participant.identity] = true;
        renderParticipantsList();
      }
    });
    room.on('trackUnmuted', (pub, participant) => {
      if (pub.kind === 'audio' && participant !== room.localParticipant) {
        remoteMicMuted[participant.identity] = false;
        renderParticipantsList();
      }
    });
    // 🔊 This is what actually makes remote voices audible — subscribing to
    // a track only receives it, it does NOT play it until attached to a
    // hidden <audio> element in the page. Remove any stale element first —
    // a track can resubscribe (e.g. after a network blip), and without this
    // we'd end up with two <audio> tags for the same person both playing at
    // once, which sounds like doubled/laggy audio.
    room.on('trackSubscribed', (track, publication, participant) => {
      if (track.kind === 'audio') {
        const oldEl = document.getElementById('audio-' + participant.identity);
        if (oldEl) oldEl.remove();
        const audioEl = track.attach();
        audioEl.id = 'audio-' + participant.identity;
        audioEl.style.display = 'none';
        audioEl.volume = vcVolume / 100; // apply the user's chosen VC volume immediately
        document.body.appendChild(audioEl);
      }
      applyMuteState(participant);
      renderParticipantsList();
    });
    room.on('trackUnsubscribed', (track, publication, participant) => {
      track.detach().forEach(el => el.remove());
    });

    // Catch audio tracks that were already subscribed before we registered
    // the listener above — happens when you join a room that already has
    // people talking in it.
    room.remoteParticipants.forEach(p => {
      p.audioTrackPublications.forEach(pub => {
        remoteMicMuted[p.identity] = !!pub.isMuted;
        if (pub.track) {
          const oldEl = document.getElementById('audio-' + p.identity);
          if (oldEl) oldEl.remove();
          const audioEl = pub.track.attach();
          audioEl.id = 'audio-' + p.identity;
          audioEl.style.display = 'none';
          audioEl.volume = vcVolume / 100; // apply the user's chosen VC volume immediately
          document.body.appendChild(audioEl);
        }
      });
      applyMuteState(p);
    });

    // LiveKit already retries brief network blips internally (ICE restart
    // etc.) — 'reconnecting'/'reconnected' fire for those, so we just show a
    // light status message rather than tearing the call down.
    room.on('reconnecting', () => {
      statusDiv.innerText = "🟡 Network hiccup — reconnecting…";
    });
    room.on('reconnected', () => {
      statusDiv.innerText = "";
    });
    // 'disconnected' only fires once LiveKit's own internal reconnection
    // attempts are exhausted — a real drop, not a blip — so this is where
    // WE take over with our own retry loop instead of leaving the person
    // silently disconnected until they notice and click Join again.
    room.on('disconnected', () => {
      if (manualLeave) return;
      statusDiv.innerText = "🔴 Connection lost — reconnecting…";
      handleFullDisconnect(lastJoinUsername || username);
    });

    renderParticipantsList();

  } catch (err) {
    if (isRetry) {
      scheduleReconnect(username);
    } else {
      statusDiv.innerText = "❌ Failed to connect. Try again.";
      joinBtn.disabled = false;
      joinBtn.classList.remove('is-live');
      joinBtnTxt.innerText = "Join Voice";
      room = null;
    }
  }
}

micToggleBtn.addEventListener('click', async () => {
  if (!room) return;
  micEnabled = !micEnabled;
  await room.localParticipant.setMicrophoneEnabled(micEnabled);
  micToggleBtn.textContent = micEnabled ? "🎤" : "🔇";
  micToggleBtn.title = micEnabled ? "Mute microphone" : "Unmute microphone";
  micToggleBtn.classList.toggle('is-on', micEnabled);
  micToggleBtn.classList.toggle('is-off', !micEnabled);
});

// There was previously no way to leave the voice call short of closing the
// tab — this deliberately disconnects and stops the auto-reconnect loop
// from kicking back in right after. Pulled into its own function (instead
// of living only inside the click handler) so LOGOUT can call the exact
// same full teardown — mic, speakers, room connection, listeners, retry
// timer — rather than duplicating it or leaving a background connection
// behind when someone logs out without first hitting "Leave".
async function leaveVoiceRoom(){
  manualLeave = true;
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  if(room){
    const leavingRoom = room;
    room = null;
    // Stops the mic capture and every subscribed remote (speaker) track as
    // part of LiveKit's own disconnect teardown, then drops every listener
    // this room instance ever had — nothing can fire after this.
    try { await leavingRoom.disconnect(); } catch (e) { /* already gone, fine */ }
    try { leavingRoom.removeAllListeners && leavingRoom.removeAllListeners(); } catch (e) { /* not fatal either way */ }
  }

  joinBtn.disabled = false;
  joinBtn.classList.remove('is-live');
  joinBtnTxt.innerText = "Join Voice";
  micToggleBtn.classList.add('hidden');
  leaveVoiceBtn.classList.add('hidden');
  voicePeopleCount.textContent = '0 in voice';
  voicePulseDot.classList.add('hidden');
  voiceDropdownHostRow.classList.add('hidden');
  voiceDropdownList.innerHTML = '<div class="voice-dropdown-empty">No one connected yet</div>';
  activeSpeakerIds = new Set();
  connQuality = {};
  mutedRemotes = {};
  remoteMicMuted = {};
  lastJoinUsername = null;
  setVoiceDropdownOpen(false);
  clearVoiceAudioElements();
  statusDiv.innerText = "";
}
leaveVoiceBtn.addEventListener('click', leaveVoiceRoom);
