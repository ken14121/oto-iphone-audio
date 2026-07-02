import { openEditor } from "/editor.js";

const DB_NAME = "oto-offline-library";
const DB_VERSION = 2;
const TRACK_STORE = "tracks";
const PLAYLIST_STORE = "playlists";

const elements = {
  fileInput: document.querySelector("#file-input"),
  networkBadge: document.querySelector("#network-badge"),
  installApp: document.querySelector("#install-app"),
  songsCount: document.querySelector("#songs-count"),
  playlistsCount: document.querySelector("#playlists-count"),
  recentSection: document.querySelector("#recent-section"),
  recentGrid: document.querySelector("#recent-grid"),
  songList: document.querySelector("#song-list"),
  songsEmpty: document.querySelector("#songs-empty"),
  songsActions: document.querySelector("#songs-actions"),
  playAll: document.querySelector("#play-all"),
  shuffleAll: document.querySelector("#shuffle-all"),
  importSongs: document.querySelector("#import-songs"),
  emptyImport: document.querySelector("#empty-import"),
  cutList: document.querySelector("#cut-list"),
  cutEmpty: document.querySelector("#cut-empty"),
  playlistList: document.querySelector("#playlist-list"),
  playlistsEmpty: document.querySelector("#playlists-empty"),
  newPlaylist: document.querySelector("#new-playlist"),
  playlistTitle: document.querySelector("#playlist-title"),
  playlistMeta: document.querySelector("#playlist-meta"),
  playlistActions: document.querySelector("#playlist-actions"),
  playlistPlay: document.querySelector("#playlist-play"),
  playlistShuffle: document.querySelector("#playlist-shuffle"),
  playlistEmpty: document.querySelector("#playlist-empty"),
  playlistTrackList: document.querySelector("#playlist-track-list"),
  playlistOptions: document.querySelector("#playlist-options"),
  pickFiles: document.querySelector("#pick-files"),
  form: document.querySelector("#convert-form"),
  accessPanel: document.querySelector("#access-panel"),
  accessCode: document.querySelector("#access-code"),
  submit: document.querySelector("#submit"),
  statusBox: document.querySelector("#status"),
  statusMessage: document.querySelector("#status-message"),
  statusPercent: document.querySelector("#status-percent"),
  progress: document.querySelector("#progress"),
  miniPlayer: document.querySelector("#mini-player"),
  miniOpen: document.querySelector("#mini-open"),
  miniArt: document.querySelector("#mini-art"),
  miniTitle: document.querySelector("#mini-title"),
  miniPlay: document.querySelector("#mini-play"),
  miniNext: document.querySelector("#mini-next"),
  nowPlaying: document.querySelector("#now-playing"),
  npClose: document.querySelector("#np-close"),
  npArt: document.querySelector("#np-art"),
  npTitle: document.querySelector("#np-title"),
  npState: document.querySelector("#np-state"),
  audio: document.querySelector("#audio"),
  playPause: document.querySelector("#play-pause"),
  previous: document.querySelector("#previous"),
  next: document.querySelector("#next"),
  seek: document.querySelector("#seek"),
  currentTime: document.querySelector("#current-time"),
  duration: document.querySelector("#duration"),
  sheetBackdrop: document.querySelector("#sheet-backdrop"),
  actionSheet: document.querySelector("#action-sheet"),
  dialogBackdrop: document.querySelector("#dialog-backdrop"),
  dialogForm: document.querySelector("#dialog-form"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogInput: document.querySelector("#dialog-input"),
  dialogCancel: document.querySelector("#dialog-cancel"),
  dialogOk: document.querySelector("#dialog-ok"),
  toast: document.querySelector("#toast"),
};

let dbPromise;
let tracks = [];
let playlists = [];
let dataLoaded = false;
let queue = [];
let queueIndex = -1;
let currentTrackId = null;
let currentObjectUrl = null;
let installPrompt = null;
let toastTimer = null;
let requiresAccessCode = false;
let currentRoute = null;
let dialogSubmit = null;

/* ---------- IndexedDB ---------- */

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        db.createObjectStore(TRACK_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PLAYLIST_STORE)) {
        db.createObjectStore(PLAYLIST_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function storeRequest(storeName, mode, operate) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const request = operate(db.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

async function getAllTracks() {
  const rows = await storeRequest(TRACK_STORE, "readonly", (store) => store.getAll());
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

async function getAllPlaylists() {
  const rows = await storeRequest(PLAYLIST_STORE, "readonly", (store) => store.getAll());
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

const saveTrack = (track) => storeRequest(TRACK_STORE, "readwrite", (store) => store.put(track));
const removeTrackRecord = (id) => storeRequest(TRACK_STORE, "readwrite", (store) => store.delete(id));
const savePlaylist = (playlist) => storeRequest(PLAYLIST_STORE, "readwrite", (store) => store.put(playlist));
const removePlaylistRecord = (id) => storeRequest(PLAYLIST_STORE, "readwrite", (store) => store.delete(id));

/* ---------- ユーティリティ ---------- */

function newId() {
  return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random();
}

function titleFromFilename(filename) {
  return filename.replace(/\.mp3$/i, "").trim() || "名称未設定";
}

function formatSize(bytes) {
  if (!bytes) return "0 MB";
  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return minutes + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}

function artGradient(seed) {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${hash} 72% 60%), hsl(${(hash + 55) % 360} 70% 42%))`;
}

function iconSvg(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

function currentAccessCode() {
  return elements.accessCode.value.trim();
}

function apiOptions(options = {}) {
  const headers = new Headers(options.headers || {});
  if (requiresAccessCode && currentAccessCode()) headers.set("X-Access-Code", currentAccessCode());
  return { ...options, headers };
}

/* ---------- ルーティング ---------- */

const PAGE_DEPTH = { library: 0, songs: 1, playlists: 1, download: 1, cut: 1, playlist: 2 };

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const name = parts[0] || "library";
  if (name === "songs") return { page: "songs" };
  if (name === "playlists") return { page: "playlists" };
  if (name === "playlist" && parts[1]) return { page: "playlist", id: decodeURIComponent(parts[1]) };
  if (name === "download") return { page: "download" };
  if (name === "cut") return { page: "cut" };
  return { page: "library" };
}

function renderRoute(animate = true) {
  const route = parseRoute();
  if (route.page === "playlist" && dataLoaded && !playlists.some((pl) => pl.id === route.id)) {
    location.replace("#/playlists");
    return;
  }
  const previousDepth = currentRoute ? PAGE_DEPTH[currentRoute.page] : PAGE_DEPTH[route.page];
  const changed = !currentRoute || currentRoute.page !== route.page || currentRoute.id !== route.id;
  document.querySelectorAll(".page").forEach((page) => {
    const active = page.dataset.route === route.page;
    page.classList.toggle("is-active", active);
    page.classList.remove("anim-fwd", "anim-back");
    if (active && animate && changed) {
      page.classList.add(PAGE_DEPTH[route.page] >= previousDepth ? "anim-fwd" : "anim-back");
    }
  });
  currentRoute = route;
  closeActionSheet();
  closeDialog();
  renderPage();
  if (changed) window.scrollTo(0, 0);
}

function renderPage() {
  if (!dataLoaded || !currentRoute) return;
  if (currentRoute.page === "library") renderLibraryPage();
  else if (currentRoute.page === "songs") renderSongsPage();
  else if (currentRoute.page === "cut") renderCutPage();
  else if (currentRoute.page === "playlists") renderPlaylistsPage();
  else if (currentRoute.page === "playlist") renderPlaylistPage();
  updatePlayingIndicators();
}

/* ---------- 各ページの描画 ---------- */

function renderLibraryPage() {
  elements.songsCount.textContent = tracks.length ? String(tracks.length) : "";
  elements.playlistsCount.textContent = playlists.length ? String(playlists.length) : "";
  const recent = tracks.slice(0, 6);
  elements.recentSection.hidden = recent.length === 0;
  elements.recentGrid.replaceChildren(...recent.map(createRecentTile));
}

function createRecentTile(track) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "recent-tile";
  const art = document.createElement("span");
  art.className = "recent-art";
  art.style.background = artGradient(track.title);
  art.textContent = "♪";
  const name = document.createElement("span");
  name.className = "recent-name";
  name.textContent = track.title;
  tile.append(art, name);
  tile.addEventListener("click", () => startQueue(tracks.map((t) => t.id), track.id));
  return tile;
}

function renderSongsPage() {
  const hasTracks = tracks.length > 0;
  elements.songsEmpty.hidden = hasTracks;
  elements.songsActions.hidden = !hasTracks;
  elements.songList.replaceChildren(...tracks.map((track) => createTrackRow(track, {
    onPlay: () => startQueue(tracks.map((t) => t.id), track.id),
    onOptions: () => showTrackOptions(track),
  })));
}

function createTrackRow(track, { onPlay, onOptions, subtitle }) {
  const item = document.createElement("li");
  item.className = "track-row";
  item.dataset.id = track.id;

  const main = document.createElement("button");
  main.type = "button";
  main.className = "track-main";

  const art = document.createElement("span");
  art.className = "track-art";
  art.style.background = artGradient(track.title);
  art.textContent = "♪";

  const text = document.createElement("span");
  text.className = "track-text";
  const title = document.createElement("strong");
  title.className = "track-title";
  title.textContent = track.title;
  const sub = document.createElement("span");
  sub.className = "track-sub";
  sub.textContent = subtitle || (formatSize(track.size) + "・オフライン保存済み");
  text.append(title, sub);

  const bars = document.createElement("span");
  bars.className = "bars";
  bars.hidden = true;
  bars.append(...[0, 1, 2].map(() => document.createElement("i")));

  main.append(art, text, bars);
  main.addEventListener("click", onPlay);

  const options = document.createElement("button");
  options.type = "button";
  options.className = "track-options";
  options.setAttribute("aria-label", track.title + "の操作");
  options.append(iconSvg("more"));
  options.addEventListener("click", onOptions);

  item.append(main, options);
  return item;
}

function renderCutPage() {
  elements.cutEmpty.hidden = tracks.length > 0;
  elements.cutList.replaceChildren(...tracks.map((track) => createTrackRow(track, {
    onPlay: () => beginEdit(track),
    onOptions: () => showTrackOptions(track),
    subtitle: "タップしてカット編集",
  })));
}

function renderPlaylistsPage() {
  elements.playlistsEmpty.hidden = playlists.length > 0;
  elements.playlistList.replaceChildren(...playlists.map(createPlaylistRow));
}

function createPlaylistRow(playlist) {
  const item = document.createElement("li");
  const row = document.createElement("a");
  row.className = "playlist-row";
  row.href = "#/playlist/" + encodeURIComponent(playlist.id);

  const art = document.createElement("span");
  art.className = "playlist-art";
  art.style.background = artGradient(playlist.name + playlist.id);
  art.append(iconSvg("playlist"));

  const text = document.createElement("span");
  text.className = "playlist-text";
  const name = document.createElement("strong");
  name.className = "playlist-name";
  name.textContent = playlist.name;
  const sub = document.createElement("span");
  sub.className = "playlist-sub";
  sub.textContent = playlistTracks(playlist).length + "曲";
  text.append(name, sub);

  const chevron = iconSvg("chevron");
  chevron.classList.add("chevron");

  row.append(art, text, chevron);
  item.append(row);
  return item;
}

function playlistTracks(playlist) {
  return playlist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
}

function renderPlaylistPage() {
  const playlist = playlists.find((pl) => pl.id === currentRoute.id);
  if (!playlist) return;
  const listTracks = playlistTracks(playlist);
  elements.playlistTitle.textContent = playlist.name;
  elements.playlistMeta.textContent = listTracks.length + "曲";
  elements.playlistActions.hidden = listTracks.length === 0;
  elements.playlistEmpty.hidden = listTracks.length > 0;
  elements.playlistTrackList.replaceChildren(...listTracks.map((track) => createTrackRow(track, {
    onPlay: () => startQueue(listTracks.map((t) => t.id), track.id),
    onOptions: () => showPlaylistTrackOptions(playlist, track),
  })));
}

/* ---------- 再生 ---------- */

function shuffleArray(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function startQueue(ids, startId = null, shuffle = false) {
  if (!ids.length) return;
  const list = shuffle ? shuffleArray([...ids]) : [...ids];
  queue = list;
  queueIndex = startId ? Math.max(0, list.indexOf(startId)) : 0;
  playTrack(queue[queueIndex]);
}

async function playTrack(id, autoplay = true) {
  const track = tracks.find((candidate) => candidate.id === id);
  if (!track) return;
  const inQueue = queue.indexOf(id);
  if (inQueue >= 0) {
    queueIndex = inQueue;
  } else {
    queue = tracks.map((t) => t.id);
    queueIndex = queue.indexOf(id);
  }
  if (currentTrackId !== id) {
    elements.audio.pause();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(track.blob);
    currentTrackId = id;
    elements.audio.src = currentObjectUrl;
    updateNowPlayingInfo(track);
    updateMediaSession(track);
    updatePlayingIndicators();
  }
  if (autoplay) {
    try { await elements.audio.play(); } catch (_) { showToast("再生ボタンをもう一度押してください"); }
  }
}

function updateNowPlayingInfo(track) {
  const gradient = artGradient(track.title);
  elements.miniTitle.textContent = track.title;
  elements.miniArt.style.background = gradient;
  elements.npTitle.textContent = track.title;
  elements.npArt.style.background = gradient;
  elements.npState.textContent = "オフライン保存済み";
  elements.miniPlayer.hidden = false;
}

function adjacentTrack(direction) {
  if (!queue.length) queue = tracks.map((track) => track.id);
  if (!queue.length) return;
  queueIndex = queueIndex < 0 ? 0 : (queueIndex + direction + queue.length) % queue.length;
  playTrack(queue[queueIndex]);
}

function togglePlayback() {
  if (!currentTrackId) {
    if (tracks.length) startQueue(tracks.map((track) => track.id));
    return;
  }
  if (elements.audio.paused) elements.audio.play();
  else elements.audio.pause();
}

function stopPlayback() {
  elements.audio.pause();
  elements.audio.removeAttribute("src");
  elements.audio.load();
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = null;
  currentTrackId = null;
  elements.miniPlayer.hidden = true;
  closeNowPlaying();
  updatePlayingIndicators();
}

function updatePlayingIndicators() {
  document.querySelectorAll(".track-row").forEach((row) => {
    const isCurrent = row.dataset.id === currentTrackId;
    row.classList.toggle("is-current", isCurrent);
    const bars = row.querySelector(".bars");
    if (bars) bars.hidden = !isCurrent;
  });
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: "OTO オフラインライブラリ",
    album: "この端末に保存済み",
    artwork: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  });
}

function openNowPlaying() {
  elements.nowPlaying.classList.add("open");
  elements.nowPlaying.setAttribute("aria-hidden", "false");
  document.body.classList.add("np-open");
}

function closeNowPlaying() {
  elements.nowPlaying.classList.remove("open");
  elements.nowPlaying.setAttribute("aria-hidden", "true");
  document.body.classList.remove("np-open");
}

/* ---------- ライブラリ操作 ---------- */

async function persistStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) { /* Browser decides. */ }
  }
}

async function refreshData() {
  tracks = await getAllTracks();
  playlists = await getAllPlaylists();
  dataLoaded = true;
  renderPage();
}

async function importBlob(blob, filename) {
  const looksLikeMp3 = /audio\/(mpeg|mp3)/i.test(blob.type) || /\.mp3$/i.test(filename);
  if (!looksLikeMp3) throw new Error("MP3ファイルを選んでください");
  if (!blob.size) throw new Error("空のファイルは保存できません");

  const duplicate = tracks.find((track) => track.filename === filename && track.size === blob.size);
  if (duplicate) {
    showToast("同じMP3はすでに保存されています");
    return duplicate;
  }

  const track = {
    id: newId(),
    title: titleFromFilename(filename),
    filename,
    mime: blob.type || "audio/mpeg",
    size: blob.size,
    createdAt: Date.now(),
    blob,
  };
  await saveTrack(track);
  await persistStorage();
  await refreshData();
  showToast("「" + track.title + "」をオフライン保存しました");
  return track;
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let saved = 0;
  for (const file of files) {
    try {
      await importBlob(file, file.name);
      saved += 1;
    } catch (error) {
      showToast(error.message || "保存できませんでした");
    }
  }
  if (saved > 1) showToast(saved + "曲をオフライン保存しました");
  elements.fileInput.value = "";
}

async function importRemote(url, filename) {
  const response = await fetch(url, apiOptions());
  if (!response.ok) throw new Error("変換したMP3を読み込めませんでした");
  return importBlob(await response.blob(), filename);
}

async function deleteTrack(id) {
  const track = tracks.find((candidate) => candidate.id === id);
  if (!track) return;
  if (!confirm("「" + track.title + "」をこの端末から削除しますか？")) return;
  if (currentTrackId === id) stopPlayback();
  await removeTrackRecord(id);
  for (const playlist of playlists) {
    if (playlist.trackIds.includes(id)) {
      playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== id);
      await savePlaylist(playlist);
    }
  }
  queue = queue.filter((queuedId) => queuedId !== id);
  queueIndex = queue.indexOf(currentTrackId);
  await refreshData();
  showToast("端末から削除しました");
}

/* ---------- プレイリスト操作 ---------- */

async function createPlaylist(name, initialTrackId = null) {
  const playlist = {
    id: newId(),
    name,
    trackIds: initialTrackId ? [initialTrackId] : [],
    createdAt: Date.now(),
  };
  await savePlaylist(playlist);
  await refreshData();
  showToast("「" + name + "」を作成しました");
  return playlist;
}

async function addTrackToPlaylist(playlistId, trackId) {
  const playlist = playlists.find((pl) => pl.id === playlistId);
  if (!playlist) return;
  if (playlist.trackIds.includes(trackId)) {
    showToast("「" + playlist.name + "」にはすでに追加されています");
    return;
  }
  playlist.trackIds.push(trackId);
  await savePlaylist(playlist);
  await refreshData();
  showToast("「" + playlist.name + "」に追加しました");
}

async function removeTrackFromPlaylist(playlist, trackId) {
  playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
  await savePlaylist(playlist);
  await refreshData();
  showToast("プレイリストから削除しました");
}

/* ---------- アクションシート・ダイアログ ---------- */

function showActionSheet(title, actions) {
  const group = document.createElement("div");
  group.className = "sheet-group";
  if (title) {
    const heading = document.createElement("div");
    heading.className = "sheet-title";
    heading.textContent = title;
    group.append(heading);
  }
  actions.forEach(({ label, danger, handler }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sheet-btn" + (danger ? " danger" : "");
    button.textContent = label;
    button.addEventListener("click", () => {
      closeActionSheet();
      handler();
    });
    group.append(button);
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "sheet-cancel";
  cancel.textContent = "キャンセル";
  cancel.addEventListener("click", closeActionSheet);
  elements.actionSheet.replaceChildren(group, cancel);
  elements.sheetBackdrop.hidden = false;
}

function closeActionSheet() {
  elements.sheetBackdrop.hidden = true;
}

function showInputDialog({ title, placeholder = "", value = "", confirmLabel = "OK" }, onSubmit) {
  elements.dialogTitle.textContent = title;
  elements.dialogInput.placeholder = placeholder;
  elements.dialogInput.value = value;
  elements.dialogOk.textContent = confirmLabel;
  dialogSubmit = onSubmit;
  elements.dialogBackdrop.hidden = false;
  setTimeout(() => elements.dialogInput.focus(), 60);
}

function closeDialog() {
  elements.dialogBackdrop.hidden = true;
  dialogSubmit = null;
}

function showTrackOptions(track) {
  showActionSheet(track.title, [
    { label: "プレイリストに追加", handler: () => showPlaylistPicker(track) },
    { label: "カット編集", handler: () => beginEdit(track) },
    { label: "ライブラリから削除", danger: true, handler: () => deleteTrack(track.id) },
  ]);
}

function showPlaylistTrackOptions(playlist, track) {
  showActionSheet(track.title, [
    { label: "カット編集", handler: () => beginEdit(track) },
    { label: "プレイリストから削除", danger: true, handler: () => removeTrackFromPlaylist(playlist, track.id) },
  ]);
}

function beginEdit(track) {
  elements.audio.pause();
  openEditor(track, {
    showToast,
    showActionSheet,
    onSave: async (blob, mode) => {
      if (mode === "replace") {
        if (currentTrackId === track.id) stopPlayback();
        await saveTrack({ ...track, blob, mime: "audio/mpeg", size: blob.size });
        await refreshData();
        showToast("「" + track.title + "」を上書き保存しました");
      } else {
        const copy = {
          id: newId(),
          title: track.title + "（カット済み）",
          filename: track.filename.replace(/\.mp3$/i, "") + " (cut).mp3",
          mime: "audio/mpeg",
          size: blob.size,
          createdAt: Date.now(),
          blob,
        };
        await saveTrack(copy);
        await persistStorage();
        await refreshData();
        showToast("「" + copy.title + "」を保存しました");
      }
    },
  });
}

function showPlaylistPicker(track) {
  const actions = playlists.map((playlist) => ({
    label: playlist.name,
    handler: () => addTrackToPlaylist(playlist.id, track.id),
  }));
  actions.push({
    label: "新規プレイリスト…",
    handler: () => promptNewPlaylist(track.id),
  });
  showActionSheet("プレイリストに追加", actions);
}

function promptNewPlaylist(initialTrackId = null) {
  showInputDialog(
    { title: "新規プレイリスト", placeholder: "プレイリスト名", confirmLabel: "作成" },
    (name) => createPlaylist(name, initialTrackId)
  );
}

function showPlaylistOptions(playlist) {
  showActionSheet(playlist.name, [
    {
      label: "名前を変更",
      handler: () => showInputDialog(
        { title: "名前を変更", value: playlist.name, confirmLabel: "保存" },
        async (name) => {
          playlist.name = name;
          await savePlaylist(playlist);
          await refreshData();
        }
      ),
    },
    {
      label: "プレイリストを削除",
      danger: true,
      handler: async () => {
        if (!confirm("「" + playlist.name + "」を削除しますか？曲はライブラリに残ります。")) return;
        await removePlaylistRecord(playlist.id);
        await refreshData();
        location.replace("#/playlists");
        showToast("プレイリストを削除しました");
      },
    },
  ]);
}

/* ---------- 変換（MP3ダウンロード） ---------- */

function renderJob(job) {
  const percent = Math.max(0, Math.min(100, job.progress || 0));
  elements.statusBox.hidden = false;
  elements.statusBox.classList.toggle("error", job.state === "error");
  elements.statusMessage.textContent = job.message || "処理しています…";
  elements.statusPercent.textContent = percent + "%";
  elements.progress.style.width = percent + "%";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollJob(jobId) {
  while (true) {
    const response = await fetch("/api/jobs/" + encodeURIComponent(jobId), apiOptions({ cache: "no-store" }));
    const job = await response.json();
    renderJob(job);
    if (job.state !== "working") return job;
    await sleep(700);
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (requiresAccessCode) localStorage.setItem("oto-access-code", currentAccessCode());
  elements.submit.disabled = true;
  elements.statusBox.classList.remove("error");
  renderJob({ progress: 1, message: "準備しています…", state: "working" });
  try {
    const response = await fetch("/api/jobs", apiOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: document.querySelector("#url").value,
        quality: document.querySelector('input[name="quality"]:checked').value,
        rightsConfirmed: document.querySelector("#rights").checked,
      }),
    }));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "変換を開始できませんでした");
    const job = await pollJob(data.id);
    if (job.state === "error") throw new Error(job.message);
    if (job.filename) {
      renderJob({ progress: 98, message: "この端末へ保存しています…", state: "working" });
      await importRemote("/files/" + encodeURIComponent(job.filename), job.filename);
      renderJob({ progress: 100, message: "オフライン保存が完了しました", state: "complete" });
      const accessCode = currentAccessCode();
      elements.form.reset();
      elements.accessCode.value = accessCode;
      document.querySelector('input[name="quality"][value="high"]').checked = true;
    }
  } catch (error) {
    renderJob({ progress: 0, message: error.message || "保存できませんでした", state: "error" });
  } finally {
    elements.submit.disabled = false;
  }
});

/* ---------- イベント ---------- */

window.addEventListener("hashchange", () => renderRoute());

elements.pickFiles.addEventListener("click", () => elements.fileInput.click());
elements.importSongs.addEventListener("click", () => elements.fileInput.click());
elements.emptyImport.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => importFiles(elements.fileInput.files));

elements.playAll.addEventListener("click", () => startQueue(tracks.map((track) => track.id)));
elements.shuffleAll.addEventListener("click", () => startQueue(tracks.map((track) => track.id), null, true));
elements.playlistPlay.addEventListener("click", () => {
  const playlist = playlists.find((pl) => pl.id === currentRoute.id);
  if (playlist) startQueue(playlistTracks(playlist).map((track) => track.id));
});
elements.playlistShuffle.addEventListener("click", () => {
  const playlist = playlists.find((pl) => pl.id === currentRoute.id);
  if (playlist) startQueue(playlistTracks(playlist).map((track) => track.id), null, true);
});

elements.newPlaylist.addEventListener("click", () => promptNewPlaylist());
elements.playlistOptions.addEventListener("click", () => {
  const playlist = playlists.find((pl) => pl.id === currentRoute.id);
  if (playlist) showPlaylistOptions(playlist);
});

elements.sheetBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.sheetBackdrop) closeActionSheet();
});
elements.dialogBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.dialogBackdrop) closeDialog();
});
elements.dialogCancel.addEventListener("click", closeDialog);
elements.dialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.dialogInput.value.trim();
  if (!name) return;
  const submit = dialogSubmit;
  closeDialog();
  if (submit) submit(name);
});

elements.miniOpen.addEventListener("click", openNowPlaying);
elements.npClose.addEventListener("click", closeNowPlaying);
elements.miniPlay.addEventListener("click", togglePlayback);
elements.miniNext.addEventListener("click", () => adjacentTrack(1));
elements.playPause.addEventListener("click", togglePlayback);
elements.previous.addEventListener("click", () => adjacentTrack(-1));
elements.next.addEventListener("click", () => adjacentTrack(1));

elements.audio.addEventListener("play", () => {
  document.body.classList.add("is-playing");
  elements.npState.textContent = "再生中";
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
elements.audio.addEventListener("pause", () => {
  document.body.classList.remove("is-playing");
  elements.npState.textContent = "一時停止";
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
elements.audio.addEventListener("timeupdate", () => {
  elements.currentTime.textContent = formatTime(elements.audio.currentTime);
  elements.seek.value = elements.audio.duration ? String(elements.audio.currentTime / elements.audio.duration * 100) : "0";
});
elements.audio.addEventListener("loadedmetadata", () => {
  elements.duration.textContent = formatTime(elements.audio.duration);
});
elements.audio.addEventListener("ended", () => adjacentTrack(1));
elements.seek.addEventListener("input", () => {
  if (elements.audio.duration) elements.audio.currentTime = Number(elements.seek.value) / 100 * elements.audio.duration;
});

if ("mediaSession" in navigator) {
  const handlers = {
    play: () => elements.audio.play(),
    pause: () => elements.audio.pause(),
    previoustrack: () => adjacentTrack(-1),
    nexttrack: () => adjacentTrack(1),
    seekbackward: (details) => { elements.audio.currentTime = Math.max(0, elements.audio.currentTime - (details.seekOffset || 10)); },
    seekforward: (details) => { elements.audio.currentTime = Math.min(elements.audio.duration || Infinity, elements.audio.currentTime + (details.seekOffset || 10)); },
    seekto: (details) => { if (Number.isFinite(details.seekTime)) elements.audio.currentTime = details.seekTime; },
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* Optional action. */ }
  });
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  elements.networkBadge.classList.toggle("offline", !online);
  elements.networkBadge.querySelector("span").textContent = online ? "オンライン" : "オフライン再生OK";
}
window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  elements.installApp.hidden = false;
});
elements.installApp.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  elements.installApp.hidden = true;
});
window.addEventListener("appinstalled", () => showToast("ホーム画面に追加しました"));

/* ---------- 起動 ---------- */

async function start() {
  updateNetworkStatus();
  const cachedCode = localStorage.getItem("oto-access-code") || "";
  try {
    const configResponse = await fetch("/api/config", { cache: "no-store" });
    const config = await configResponse.json();
    requiresAccessCode = Boolean(config.requiresAccessCode);
  } catch (_) {
    requiresAccessCode = Boolean(cachedCode);
  }
  if (requiresAccessCode) {
    const codeFromUrl = new URLSearchParams(location.search).get("code") || cachedCode;
    elements.accessCode.value = codeFromUrl;
    elements.accessPanel.hidden = false;
    elements.accessCode.required = true;
  }
  await refreshData();
  renderRoute(false);
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("/service-worker.js"); } catch (_) { showToast("オフライン機能を準備できませんでした"); }
  }
}

start().catch(() => showToast("ライブラリを読み込めませんでした"));
