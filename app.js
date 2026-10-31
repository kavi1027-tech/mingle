import { initializeMingle, isFirebaseConfigured } from "./firebase-auth.js";
import {
  child,
  limitToLast,
  onChildAdded,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  remove,
  serverTimestamp,
  set
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const $ = (id) => document.getElementById(id);
const countryCatalog = window.ISO_COUNTRIES || [];
const countryByCode = new Map(countryCatalog.map((country) => [country.code, country]));
const languageCatalog = window.ISO_LANGUAGES || [];
const languageByCode = new Map(languageCatalog.map((language) => [language.code, language]));
const selectedLanguages = new Set();
const friends = new Map();
const incomingRequests = new Map();
const outgoingRequests = new Map();
const messageCache = new Map();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

let service = null;
let uid = "";
let toastTimeout = null;
let activeTab = "friends";
let chatFriendId = null;
let chatUnsubscribe = null;
let sessionUnsubscribe = null;
let presenceUnsubscribe = null;
let connectionUnsubscribe = null;
let friendsUnsubscribe = null;
let incomingUnsubscribe = null;
let outgoingUnsubscribe = null;
let queueInterval = null;
let queueBusy = false;
let presenceByUid = {};
let localStream = null;
let peerConnection = null;
let currentMatch = null;
let sessionStartedAt = 0;
let timerInterval = null;
let matchSubscriptions = [];
let pendingCandidates = [];
let remoteDescriptionReady = false;
let appliedDescription = "";

function showToast(message) {
  $("toastMessage").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $("toast").classList.remove("show"), 3600);
}

window.showAppToast = showToast;

function setConnectionStatus(text, ready = false) {
  $("connectionText").textContent = text;
  $("connectionStatus").querySelector(".connection-dot").classList.toggle("ready", ready);
}

function selectedProfile() {
  return {
    gender: $("profileGender").value,
    country: $("profileCountry").value,
    languages: [...selectedLanguages]
  };
}

function ownPresenceData() {
  const profile = selectedProfile();
  return {
    online: true,
    gender: profile.gender || "unspecified",
    country: profile.country || "",
    ...(profile.languages.length ? { languages: profile.languages } : {}),
    lastSeen: serverTimestamp()
  };
}

async function syncOwnPresence() {
  if (!service || !uid) return;
  try {
    await set(ref(service.database, `presence/${uid}`), ownPresenceData());
  } catch (error) {
    console.error("Presence profile could not be updated.", error);
  }
}

function selectedFilters() {
  return {
    gender: document.querySelector(".gender-btn.selected")?.dataset.gender || "everyone",
    country: $("countrySelect").value || "any"
  };
}

function isProfileReady() {
  const profile = selectedProfile();
  return Boolean(profile.gender && profile.country && profile.languages.length);
}

function updateStartAvailability() {
  const ready = Boolean(service && isProfileReady());
  $("startButton").disabled = !ready;
  if (!service) {
    $("startButton").title = "Live service setup is required.";
  } else if (!isProfileReady()) {
    $("startButton").title = "Choose your gender, country, and at least one language you speak.";
  } else {
    $("startButton").removeAttribute("title");
  }
}

function renderLanguageResults() {
  const queryText = $("languageSearch").value.trim().toLocaleLowerCase();
  const list = $("languageOptions");
  if (!queryText) {
    list.classList.remove("open");
    list.innerHTML = "";
    $("languageHint").textContent = selectedLanguages.size
      ? `${selectedLanguages.size} selected · search to add more`
      : `Choose at least one language from ${languageCatalog.length.toLocaleString()} entries`;
    return;
  }
  const matches = languageCatalog.filter((language) =>
    language.name.toLocaleLowerCase().includes(queryText) || language.code.toLocaleLowerCase().includes(queryText)
  );
  const visible = matches.slice(0, 40);
  list.classList.add("open");
  list.innerHTML = visible.length
    ? visible.map((language) => {
      const selected = selectedLanguages.has(language.code);
      return `<button type="button" class="language-option ${selected ? "selected" : ""}" role="option" aria-selected="${selected}" data-code="${escapeHtml(language.code)}"><span>${escapeHtml(language.name)}</span><small>${escapeHtml(language.code.toUpperCase())}</small></button>`;
    }).join("") + (matches.length > 40 ? `<div class="language-more">Showing 40 of ${matches.length.toLocaleString()} results. Keep typing to narrow the list.</div>` : "")
    : `<div class="language-empty">No language matches “${escapeHtml(queryText)}”.</div>`;
  $("languageHint").textContent = `${matches.length.toLocaleString()} ${matches.length === 1 ? "match" : "matches"}`;
}

function renderSelectedLanguages() {
  $("selectedLanguages").innerHTML = [...selectedLanguages].map((code) => {
    const language = languageByCode.get(code);
    if (!language) return "";
    return `<span class="selected-language">${escapeHtml(language.name)}<button type="button" aria-label="Remove ${escapeHtml(language.name)}" data-remove-language="${escapeHtml(code)}">×</button></span>`;
  }).join("");
  updateStartAvailability();
}

function populateCountries() {
  const options = countryCatalog.map((country) => `<option value="${escapeHtml(country.code)}">${escapeHtml(country.flag)} &nbsp; ${escapeHtml(country.name)}</option>`).join("");
  $("countrySelect").innerHTML = '<option value="any">🌐 &nbsp; Anywhere</option>' + options;
  $("profileCountry").innerHTML = '<option value="">Your country</option>' + options;
  $("languageCount").textContent = `${languageCatalog.length.toLocaleString()} options`;
  const region = (() => {
    try { return new Intl.Locale(navigator.language).region || ""; } catch (_) { return ""; }
  })();
  if (countryByCode.has(region)) $("profileCountry").value = region;
}

function passesLocalFilters(profile) {
  const filter = selectedFilters();
  if (filter.gender !== "everyone" && profile.gender !== filter.gender) return false;
  if (filter.country !== "any" && profile.country !== filter.country) return false;
  const spoken = profile.languages || [];
  return !selectedLanguages.size || spoken.some((code) => selectedLanguages.has(code));
}

function updateCounts() {
  const onlinePeople = Object.entries(presenceByUid).filter(([personUid, value]) => personUid !== uid && value?.online === true);
  const allOnline = Object.values(presenceByUid).filter((value) => value?.online === true);
  $("onlineCount").textContent = allOnline.length.toLocaleString();
  const pool = onlinePeople.filter(([, value]) => passesLocalFilters(value));
  $("poolCount").textContent = pool.length.toLocaleString();
}

function startWatchingPresence() {
  const connectedRef = ref(service.database, ".info/connected");
  const ownPresenceRef = ref(service.database, `presence/${uid}`);
  connectionUnsubscribe?.();
  connectionUnsubscribe = onValue(connectedRef, async (snapshot) => {
    if (snapshot.val() !== true) {
      setConnectionStatus("Reconnecting", false);
      return;
    }
    try {
      await onDisconnect(ownPresenceRef).remove();
      await syncOwnPresence();
      setConnectionStatus("Guest · online", true);
    } catch (error) {
      console.error("Presence could not be updated.", error);
      setConnectionStatus("Service unavailable", false);
    }
  }, (error) => {
    console.error("Presence connection failed.", error);
    setConnectionStatus("Service unavailable", false);
  });

  presenceUnsubscribe = onValue(ref(service.database, "presence"), (snapshot) => {
    presenceByUid = snapshot.val() || {};
    updateCounts();
  }, (error) => {
    console.error("Online count could not be loaded.", error);
    showToast("Live online count is unavailable. Check your Realtime Database rules.");
  });

}

function listenForSession() {
  sessionUnsubscribe?.();
  sessionUnsubscribe = onValue(ref(service.database, `sessions/${uid}`), async (snapshot) => {
    const session = snapshot.val();
    if (session?.status === "matched" && session.matchId && session.peerUid) {
      await enterMatch(session);
      return;
    }
    if (session?.status === "ended" && currentMatch) {
      closePeerConnection();
      currentMatch = null;
      clearInterval(queueInterval);
      endLocalMedia();
      showWelcome();
      showToast("The other person ended the chat.");
    }
  }, (error) => {
    console.error("Match session could not be read.", error);
    showToast("Match status could not be loaded. Check your Realtime Database rules.");
  });
}

async function keepSearching() {
  if (!service || !queueBusy && !$("startButton").disabled) return;
  if (queueBusy || currentMatch) return;
  queueBusy = true;
  try {
    const result = await service.call("findMatch", { profile: selectedProfile(), filters: selectedFilters() });
    if (result.status === "waiting") {
      $("stageTitle").textContent = "Waiting for another person…";
      $("matchStatus").textContent = "Looking for a match";
    }
  } catch (error) {
    console.error("Matchmaking request failed.", error);
    clearInterval(queueInterval);
    queueInterval = null;
    showWelcome();
    endLocalMedia();
    showToast(error.message || "Matching could not start. Check your Firebase Functions setup.");
  } finally {
    queueBusy = false;
  }
}

async function enableCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot access a camera. Open the site over HTTPS in a current browser.");
  return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
}

async function startMatching() {
  if (!service) return showToast("Live matching needs a Firebase project. Follow the setup steps in README.md.");
  if (!isProfileReady()) return showToast("Choose your gender, country, and at least one language you speak.");
  if (currentMatch) return;

  $("startButton").disabled = true;
  $("startButton").textContent = "Starting camera…";
  try {
    localStream = await enableCamera();
    $("localVideo").srcObject = localStream;
    $("localVideo").classList.add("on");
    $("cameraFallback").style.display = "none";
    await set(ref(service.database, `profiles/${uid}`), selectedProfile());
    const profile = selectedProfile();
    await set(ref(service.database, `presence/${uid}`), {
      online: true,
      gender: profile.gender,
      country: profile.country,
      languages: profile.languages,
      lastSeen: serverTimestamp()
    });
    listenForSession();
    $("stagePlaceholder").style.display = "none";
    $("personView").classList.remove("visible");
    $("stageTitle").textContent = "Finding someone online…";
    $("matchStatus").textContent = "Looking for a match";
    $("startButton").textContent = "Finding someone…";
    await keepSearching();
    if (!currentMatch) queueInterval = setInterval(keepSearching, 5000);
  } catch (error) {
    console.error("Camera or matching could not start.", error);
    endLocalMedia();
    showWelcome();
    showToast(error.message || "Allow camera and microphone access, then try again.");
  } finally {
    if (!currentMatch && !queueInterval) {
      $("startButton").disabled = false;
      $("startButton").textContent = "Start matching →";
    }
  }
}

async function addPendingCandidates() {
  if (!peerConnection || !remoteDescriptionReady || !pendingCandidates.length) return;
  const candidates = pendingCandidates.splice(0);
  for (const candidate of candidates) {
    try { await peerConnection.addIceCandidate(candidate); }
    catch (error) { console.warn("A connection candidate was skipped.", error); }
  }
}

async function setupPeerConnection(match) {
  closePeerConnection();
  remoteDescriptionReady = false;
  appliedDescription = "";
  pendingCandidates = [];

  const iceServers = Array.isArray(window.MINGLE_ICE_SERVERS) && window.MINGLE_ICE_SERVERS.length
    ? window.MINGLE_ICE_SERVERS
    : [{ urls: "stun:stun.l.google.com:19302" }];
  peerConnection = new RTCPeerConnection({ iceServers });
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.ontrack = (event) => {
    $("remoteVideo").srcObject = event.streams[0];
    $("remotePlaceholder").hidden = true;
    $("matchStatus").textContent = "Connected";
  };
  peerConnection.onicecandidate = async (event) => {
    if (!event.candidate || !currentMatch) return;
    try {
      const candidateRef = push(ref(service.database, `matches/${match.id}/signals/${uid}/candidates`));
      await set(candidateRef, event.candidate.toJSON());
    } catch (error) {
      console.error("Connection setup could not be completed.", error);
    }
  };
  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === "connected") $("matchStatus").textContent = "Connected";
    if (peerConnection.connectionState === "failed") {
      $("matchStatus").textContent = "Connection failed";
      showToast("The video connection could not be made. Try Next or check your network.");
    }
  };

  const ownDescriptionRef = ref(service.database, `matches/${match.id}/signals/${uid}/description`);
  const peerDescriptionRef = ref(service.database, `matches/${match.id}/signals/${match.peerUid}/description`);
  const peerCandidatesRef = ref(service.database, `matches/${match.id}/signals/${match.peerUid}/candidates`);
  const offerer = uid.localeCompare(match.peerUid) < 0;

  const stopDescription = onValue(peerDescriptionRef, async (snapshot) => {
    const description = snapshot.val();
    if (!description) return;
    const signature = `${description.type}:${description.sdp}`;
    if (signature === appliedDescription) return;
    try {
      if (!offerer && description.type === "offer") {
        appliedDescription = signature;
        await peerConnection.setRemoteDescription(description);
        remoteDescriptionReady = true;
        await addPendingCandidates();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await set(ownDescriptionRef, { type: answer.type, sdp: answer.sdp });
      } else if (offerer && description.type === "answer" && !remoteDescriptionReady) {
        appliedDescription = signature;
        await peerConnection.setRemoteDescription(description);
        remoteDescriptionReady = true;
        await addPendingCandidates();
      }
    } catch (error) {
      console.error("Signaling failed.", error);
      showToast("Could not set up the video call. Try another match.");
    }
  });
  matchSubscriptions.push(stopDescription);

  const stopCandidates = onChildAdded(peerCandidatesRef, async (snapshot) => {
    const candidate = snapshot.val();
    if (!candidate || !peerConnection) return;
    if (!remoteDescriptionReady) {
      pendingCandidates.push(candidate);
      return;
    }
    try { await peerConnection.addIceCandidate(candidate); }
    catch (error) { console.warn("A connection candidate was skipped.", error); }
  });
  matchSubscriptions.push(stopCandidates);

  if (offerer) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await set(ownDescriptionRef, { type: offer.type, sdp: offer.sdp });
  }
}

async function enterMatch(session) {
  if (currentMatch?.id === session.matchId) return;
  clearInterval(queueInterval);
  queueInterval = null;
  queueBusy = false;
  currentMatch = { id: session.matchId, peerUid: session.peerUid, peerProfile: session.peerProfile || {} };
  $("stagePlaceholder").style.display = "none";
  $("personView").classList.add("visible");
  $("remotePlaceholder").hidden = false;
  $("remoteVideo").srcObject = null;
  $("personName").textContent = currentMatch.peerProfile.label || "Your match";
  const country = countryByCode.get(currentMatch.peerProfile.country);
  $("personCountry").textContent = country ? `${country.flag} ${country.name}` : "Online now";
  const languages = (currentMatch.peerProfile.languages || []).map((code) => languageByCode.get(code)?.name).filter(Boolean);
  $("personLanguage").textContent = languages.join(", ") || "Language not listed";
  $("personTags").innerHTML = `<span>Live one-to-one</span><span>Guest session</span>`;
  $("stageTitle").textContent = `Connected to ${currentMatch.peerProfile.label || "your match"}`;
  $("matchStatus").textContent = "Setting up video…";
  $("skipButton").disabled = false;
  $("stopButton").disabled = false;
  $("likeButton").disabled = false;
  $("likeButton").classList.remove("liked");
  $("likeButton").textContent = "Like";
  sessionStartedAt = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStartedAt) / 1000);
    $("timer").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  }, 1000);
  try { await setupPeerConnection(currentMatch); }
  catch (error) {
    console.error("Video connection could not start.", error);
    $("matchStatus").textContent = "Waiting for partner";
    showToast("Your match is here, but the video setup needs another try.");
  }
}

function closePeerConnection() {
  matchSubscriptions.forEach((unsubscribe) => unsubscribe());
  matchSubscriptions = [];
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    peerConnection = null;
  }
  $("remoteVideo").srcObject = null;
  remoteDescriptionReady = false;
  pendingCandidates = [];
  appliedDescription = "";
}

function endLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  $("localVideo").srcObject = null;
  $("localVideo").classList.remove("on");
  $("cameraFallback").style.display = "block";
}

function showWelcome() {
  currentMatch = null;
  clearInterval(timerInterval);
  $("personView").classList.remove("visible");
  $("stagePlaceholder").style.display = "grid";
  $("stageTitle").textContent = "Your next conversation";
  $("matchStatus").textContent = "Live video chat";
  $("skipButton").disabled = true;
  $("stopButton").disabled = true;
  $("likeButton").disabled = true;
  $("timer").textContent = "00:00";
  $("startButton").textContent = "Start matching →";
  updateStartAvailability();
}

async function leaveMatch(showMessage = false, rematch = false) {
  clearInterval(queueInterval);
  queueInterval = null;
  closePeerConnection();
  const hadMatch = Boolean(currentMatch);
  currentMatch = null;
  if (service && hadMatch) {
    try { await service.call("endMatch"); }
    catch (error) { console.warn("The match ended locally; server cleanup may take a moment.", error); }
  }
  endLocalMedia();
  showWelcome();
  if (showMessage) showToast("Chat ended. You can meet someone else any time.");
  if (rematch) await startMatching();
}

function renderFriends() {
  const list = $("friendList");
  const entries = [...friends.entries()];
  $("friendCount").textContent = String(entries.length);
  document.querySelectorAll(".nav-friends-count").forEach((el) => { el.textContent = String(entries.length); });
  $("friendsEmpty").hidden = entries.length > 0;
  list.hidden = entries.length === 0;
  list.innerHTML = entries.map(([friendshipId, friend]) => {
    const online = presenceByUid[friend.peerUid]?.online === true;
    const country = countryByCode.get(friend.country);
    return `<div class="friend-row"><span class="friend-photo" aria-hidden="true">👋</span><div class="friend-copy"><div class="friend-name">${escapeHtml(friend.label || "Friend")}</div><div class="friend-sub">${country ? `${escapeHtml(country.flag)} ${escapeHtml(country.name)}` : "Mingle friend"} · ${online ? "Online" : "Offline"}</div></div><span class="friend-online" title="${online ? "Online" : "Offline"}" style="${online ? "" : "background:#c7c7d1"}"></span><button class="open-chat" data-chat="${escapeHtml(friendshipId)}">Chat</button></div>`;
  }).join("");
}

function renderRequests() {
  const incoming = [...incomingRequests.entries()];
  const outgoing = [...outgoingRequests.entries()];
  const total = incoming.length + outgoing.length;
  $("requestCount").textContent = String(total);
  $("requestsEmpty").hidden = total > 0;
  $("requestList").innerHTML = [
    ...incoming.map(([requestId, request]) => {
      const country = countryByCode.get(request.country);
      return `<article class="request-card"><div class="request-person"><span class="friend-photo" aria-hidden="true">👋</span><div class="friend-copy"><div class="friend-name">${escapeHtml(request.label || "Guest")}</div><div class="friend-sub">${country ? `${escapeHtml(country.flag)} ${escapeHtml(country.name)}` : "Mingle member"}</div></div></div><div class="request-status incoming">Friend request · Accept to open private chat</div><div class="request-actions"><button class="accept-request" data-accept="${escapeHtml(requestId)}">Accept request</button><button data-decline="${escapeHtml(requestId)}">Decline</button></div></article>`;
    }),
    ...outgoing.map(([requestId, request]) => {
      const country = countryByCode.get(request.country);
      return `<article class="request-card"><div class="request-person"><span class="friend-photo" aria-hidden="true">👋</span><div class="friend-copy"><div class="friend-name">${escapeHtml(request.label || "Guest")}</div><div class="friend-sub">${country ? `${escapeHtml(country.flag)} ${escapeHtml(country.name)}` : "Mingle member"}</div></div></div><div class="request-status">Friend request sent · Waiting for acceptance</div><div class="request-actions"><button data-cancel-request="${escapeHtml(requestId)}">Cancel request</button></div></article>`;
    })
  ].join("");
}

function showFriendsPanel() {
  activeTab = "friends";
  $("friendsTab").classList.add("active");
  $("requestsTab").classList.remove("active");
  $("rightHeading").textContent = "Your friends";
  $("friendContent").hidden = false;
  $("requestContent").hidden = true;
  $("chatView").classList.remove("open");
  chatUnsubscribe?.();
  chatUnsubscribe = null;
  chatFriendId = null;
}

function showRequestsPanel() {
  activeTab = "requests";
  $("friendsTab").classList.remove("active");
  $("requestsTab").classList.add("active");
  $("rightHeading").textContent = "Friend requests";
  $("friendContent").hidden = true;
  $("requestContent").hidden = false;
  $("chatView").classList.remove("open");
  chatUnsubscribe?.();
  chatUnsubscribe = null;
  chatFriendId = null;
}

function openChat(friendshipId) {
  const friend = friends.get(friendshipId);
  if (!friend) return;
  activeTab = "friends";
  chatFriendId = friendshipId;
  $("friendsTab").classList.add("active");
  $("requestsTab").classList.remove("active");
  $("rightHeading").textContent = "Your messages";
  $("friendContent").hidden = true;
  $("requestContent").hidden = true;
  $("chatView").classList.add("open");
  const country = countryByCode.get(friend.country);
  const cached = messageCache.get(friendshipId) || [];
  $("chatView").innerHTML = `<div class="chat-header"><button class="back-chat" id="backToFriends" aria-label="Back to friends">‹</button><span class="friend-photo" aria-hidden="true">👋</span><div><div class="friend-name">${escapeHtml(friend.label || "Friend")}</div><div class="friend-sub">${country ? `${escapeHtml(country.flag)} ${escapeHtml(country.name)}` : "Mingle friend"}</div></div><span class="mutual-badge">FRIEND</span></div><div class="chat-messages" id="chatMessages">${renderMessageBubbles(cached)}</div><form class="chat-compose" id="chatForm"><label class="sr-only" for="chatInput">Write a message</label><input id="chatInput" maxlength="500" autocomplete="off" placeholder="Write a message…"><button class="send-btn" aria-label="Send message">➤</button></form>`;
  $("backToFriends").addEventListener("click", showFriendsPanel);
  $("chatForm").addEventListener("submit", sendMessage);
  chatUnsubscribe?.();
  const messagesQuery = query(ref(service.database, `friendships/${friendshipId}/messages`), orderByChild("createdAt"), limitToLast(100));
  chatUnsubscribe = onValue(messagesQuery, (snapshot) => {
    const messages = [];
    snapshot.forEach((item) => messages.push({ id: item.key, ...item.val() }));
    messageCache.set(friendshipId, messages);
    if (chatFriendId !== friendshipId) return;
    const container = $("chatMessages");
    if (!container) return;
    container.innerHTML = renderMessageBubbles(messages);
    container.scrollTop = container.scrollHeight;
  }, (error) => {
    console.error("Friend chat could not be opened.", error);
    showToast("This private chat is unavailable. Confirm the friend connection is accepted.");
  });
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function renderMessageBubbles(messages) {
  return messages.map((message) => `<div class="chat-bubble ${message.senderUid === uid ? "mine" : ""}">${escapeHtml(message.text)}</div>`).join("");
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || !chatFriendId || text.length > 500) return;
  const input = $("chatInput");
  input.value = "";
  try {
    const messageRef = push(ref(service.database, `friendships/${chatFriendId}/messages`));
    await set(messageRef, { senderUid: uid, text, createdAt: serverTimestamp() });
  } catch (error) {
    console.error("Message could not be sent.", error);
    showToast("Message not sent. Confirm you are still friends and online.");
    input.value = text;
  }
}

function watchFriendData() {
  friendsUnsubscribe = onValue(ref(service.database, `users/${uid}/friends`), (snapshot) => {
    friends.clear();
    snapshot.forEach((item) => friends.set(item.key, item.val()));
    renderFriends();
    if (chatFriendId && !friends.has(chatFriendId)) showFriendsPanel();
  });
  incomingUnsubscribe = onValue(ref(service.database, `users/${uid}/incomingRequests`), (snapshot) => {
    incomingRequests.clear();
    snapshot.forEach((item) => incomingRequests.set(item.key, item.val()));
    renderRequests();
  });
  outgoingUnsubscribe = onValue(ref(service.database, `users/${uid}/outgoingRequests`), (snapshot) => {
    outgoingRequests.clear();
    snapshot.forEach((item) => outgoingRequests.set(item.key, item.val()));
    renderRequests();
  });
}

async function likeCurrentPerson() {
  if (!currentMatch) return;
  $("likeButton").disabled = true;
  $("likeButton").classList.add("liked");
  $("likeButton").textContent = "Sending…";
  try {
    const result = await service.call("sendFriendRequest", { matchId: currentMatch.id });
    $("likeButton").textContent = result.status === "already-friends" ? "✓ Friends" : "Request sent";
    showToast(result.status === "already-friends" ? "You are already friends." : "Friend request sent. They can accept it to unlock private chat.");
    showRequestsPanel();
  } catch (error) {
    console.error("Friend request could not be sent.", error);
    $("likeButton").disabled = false;
    $("likeButton").classList.remove("liked");
    $("likeButton").textContent = "Like";
    showToast(error.message || "Friend request could not be sent.");
  }
}

async function respondToRequest(requestId, action) {
  try {
    await service.call("respondFriendRequest", { requestId, action });
    if (action === "accept") {
      showFriendsPanel();
      showToast("Friend request accepted. Private chat is now open.");
    } else {
      showToast(action === "decline" ? "Friend request declined." : "Friend request canceled.");
    }
  } catch (error) {
    console.error("Friend request response failed.", error);
    showToast(error.message || "Could not update that friend request.");
  }
}

function bindControls() {
  document.querySelectorAll(".gender-btn").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".gender-btn").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    updateCounts();
  }));

  $("languageSearch").addEventListener("input", renderLanguageResults);
  $("languageSearch").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = $("languageOptions").querySelector("[data-code]");
    if (first) { event.preventDefault(); first.click(); }
  });
  $("languageOptions").addEventListener("click", (event) => {
    const option = event.target.closest("[data-code]");
    if (!option) return;
    if (selectedLanguages.has(option.dataset.code)) selectedLanguages.delete(option.dataset.code);
    else if (selectedLanguages.size < 10) selectedLanguages.add(option.dataset.code);
    else showToast("Choose up to 10 languages.");
    renderSelectedLanguages();
    renderLanguageResults();
    updateCounts();
    syncOwnPresence();
  });
  $("selectedLanguages").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-language]");
    if (!removeButton) return;
    selectedLanguages.delete(removeButton.dataset.removeLanguage);
    renderSelectedLanguages();
    renderLanguageResults();
    updateCounts();
    syncOwnPresence();
  });
  $("countrySelect").addEventListener("change", updateCounts);
  $("profileCountry").addEventListener("change", () => { updateStartAvailability(); syncOwnPresence(); });
  $("profileGender").addEventListener("change", () => { updateStartAvailability(); syncOwnPresence(); });
  $("resetFilters").addEventListener("click", () => {
    document.querySelectorAll(".gender-btn").forEach((button) => {
      const selected = button.dataset.gender === "everyone";
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("countrySelect").value = "any";
    updateCounts();
    showToast("Match filters reset.");
  });
  $("startButton").addEventListener("click", startMatching);
  $("skipButton").addEventListener("click", () => leaveMatch(false, true));
  $("stopButton").addEventListener("click", () => leaveMatch(true));
  $("likeButton").addEventListener("click", likeCurrentPerson);
  $("friendsTab").addEventListener("click", showFriendsPanel);
  $("requestsTab").addEventListener("click", showRequestsPanel);
  $("requestList").addEventListener("click", (event) => {
    const accept = event.target.closest("[data-accept]");
    const decline = event.target.closest("[data-decline]");
    const cancel = event.target.closest("[data-cancel-request]");
    if (accept) respondToRequest(accept.dataset.accept, "accept");
    else if (decline) respondToRequest(decline.dataset.decline, "decline");
    else if (cancel) respondToRequest(cancel.dataset.cancelRequest, "cancel");
  });
  $("friendList").addEventListener("click", (event) => {
    const chatButton = event.target.closest("[data-chat]");
    if (chatButton) openChat(chatButton.dataset.chat);
  });
  $("friendsNav").addEventListener("click", () => $(".right-panel").scrollIntoView({ behavior: "smooth", block: "center" }));
  $("discoverNav").addEventListener("click", () => $("startButton").scrollIntoView({ behavior: "smooth", block: "center" }));
  $("safetyOpen").addEventListener("click", () => $("safetyModal").classList.add("open"));
  $("safetyClose").addEventListener("click", () => $("safetyModal").classList.remove("open"));
  $("safetyModal").addEventListener("click", (event) => { if (event.target === $("safetyModal")) $("safetyModal").classList.remove("open"); });
  window.addEventListener("pagehide", () => {
    clearInterval(queueInterval);
    presenceUnsubscribe?.();
    connectionUnsubscribe?.();
    friendsUnsubscribe?.();
    incomingUnsubscribe?.();
    outgoingUnsubscribe?.();
    sessionUnsubscribe?.();
    chatUnsubscribe?.();
  });
}

async function connect() {
  populateCountries();
  bindControls();
  renderLanguageResults();
  updateCounts();
  renderFriends();
  renderRequests();

  if (!isFirebaseConfigured) {
    setConnectionStatus("Setup required", false);
    $("matchStatus").textContent = "Live service setup required";
    $("stageTitle").textContent = "Connect a Firebase project to go live";
    $("stageDescription").textContent = "This site is not connected to its live service yet. Follow the Firebase setup steps in the repository README to enable online people, video matching, and friends.";
    $("cameraNote").textContent = "Setup required: connect Firebase before real people can meet here.";
    $("startButton").disabled = true;
    showToast("Live service is not configured yet. Follow the Firebase setup steps in the repository README to meet real people.");
    return;
  }

  try {
    service = await initializeMingle();
    uid = service.user.uid;
    setConnectionStatus("Guest · online", true);
    watchFriendData();
    startWatchingPresence();
    updateStartAvailability();
  } catch (error) {
    console.error("Live service could not connect.", error);
    setConnectionStatus("Service unavailable", false);
    $("matchStatus").textContent = "Service unavailable";
    $("stageTitle").textContent = "Live service setup is incomplete";
    showToast(error.message || "Could not connect to Firebase.");
  }
}

populateCountries();
bindControls();
renderLanguageResults();
renderFriends();
renderRequests();
updateCounts();
updateStartAvailability();
connect();
