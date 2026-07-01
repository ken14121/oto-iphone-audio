const DB_NAME = "oto-offline-library";
const STORE_NAME = "tracks";
const DB_VERSION = 1;

const elements = {
  fileInput: document.querySelector("#file-input"),
  pickFiles: document.querySelector("#pick-files"),
  emptyPick: document.querySelector("#empty-pick"),
  emptyLibrary: document.querySelector("#empty-library"),
  trackList: document.querySelector("#track-list"),
  librarySummary: document.querySelector("#library-summary"),
  networkBadge: document.querySelector("#network-badge"),
  installApp: document.querySelector("#install-app"),
  form: document.querySelector("#convert-form"),
  accessPanel: document.querySelector("#access-panel"),
  accessCode: document.querySelector("#access-code"),
  submit: document.querySelector("#submit"),
  statusBox: document.querySelector("#status"),
  statusMessage: document.querySelector("#status-message"),
  statusPercent: document.querySelector("#status-percent"),
  progress: document.querySelector("#progress"),
  toast: document.querySelector("#toast"),
  player: document.querySelector("#player"),
  playerTitle: document.querySelector("#player-title"),
  playerState: document.querySelector("#player-state"),
  audio: document.querySelector("#audio"),
  playPause: document.querySelector("#play-pause"),
  previous: document.querySelector("#previous"),
  next: document.querySelector("#next"),
  seek: document.querySelector("#seek"),
  currentTime: document.querySelector("#current-time"),
  duration: document.querySelector("#duration"),
};

let dbPromise;
let tracks = [];
let currentTrackId = null;
let currentObjectUrl = null;
let installPrompt = null;
let toastTimer = null;
let requiresAccessCode = false;

function currentAccessCode() {
  return elements.accessCode.value.trim();
}

function apiOptions(options = {}) {
  const headers = new Headers(options.headers || {});
  if (requiresAccessCode && currentAccessCode()) headers.set("X-Access-Code", currentAccessCode());
  return { ...options, headers };
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function getAllTracks() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

async function saveTrack(track) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(track);
    request.onsuccess = () => resolve(track);
    request.onerror = () => reject(request.error);
  });
}

async function removeTrack(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

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

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

function createTrackRow(track, index) {
  const item = document.createElement("li");
  item.className = "track-row" + (track.id === currentTrackId ? " is-current" : "");
  item.dataset.id = track.id;

  const number = document.createElement("span");
  number.className = "track-index";
  number.textContent = String(index + 1).padStart(2, "0");

  const info = document.createElement("div");
  info.className = "track-info";
  const title = document.createElement("strong");
  title.textContent = track.title;
  const detail = document.createElement("span");
  detail.textContent = formatSize(track.size) + "・オフライン保存済み";
  info.append(title, detail);

  const play = document.createElement("button");
  play.className = "track-play";
  play.type = "button";
  play.dataset.action = "play";
  play.setAttribute("aria-label", track.title + "を再生");
  play.textContent = track.id === currentTrackId && !elements.audio.paused ? "Ⅱ" : "▶";

  const remove = document.createElement("button");
  remove.className = "track-delete";
  remove.type = "button";
  remove.dataset.action = "delete";
  remove.setAttribute("aria-label", track.title + "を削除");
  remove.textContent = "×";

  item.append(number, info, play, remove);
  return item;
}

function renderLibrary() {
  const totalSize = tracks.reduce((sum, track) => sum + (track.size || 0), 0);
  elements.librarySummary.textContent = tracks.length + "曲・" + formatSize(totalSize);
  elements.emptyLibrary.hidden = tracks.length > 0;
  elements.trackList.hidden = tracks.length === 0;
  elements.trackList.replaceChildren(...tracks.map(createTrackRow));
}

async function refreshLibrary() {
  tracks = await getAllTracks();
  renderLibrary();
}

async function persistStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) { /* Browser decides. */ }
  }
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
  await refreshLibrary();
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

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: "OTO オフラインライブラリ",
    album: "この端末に保存済み",
    artwork: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  });
}

async function playTrack(id, autoplay = true) {
  const track = tracks.find((candidate) => candidate.id === id);
  if (!track) return;
  if (currentTrackId !== id) {
    elements.audio.pause();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(track.blob);
    currentTrackId = id;
    elements.audio.src = currentObjectUrl;
    elements.playerTitle.textContent = track.title;
    elements.playerState.textContent = "オフライン保存済み";
    elements.player.hidden = false;
    updateMediaSession(track);
    renderLibrary();
  }
  if (autoplay) {
    try { await elements.audio.play(); } catch (_) { showToast("再生ボタンをもう一度押してください"); }
  }
}

function adjacentTrack(direction) {
  if (!tracks.length) return;
  const index = tracks.findIndex((track) => track.id === currentTrackId);
  const nextIndex = index < 0 ? 0 : (index + direction + tracks.length) % tracks.length;
  playTrack(tracks[nextIndex].id);
}

async function deleteTrack(id) {
  const track = tracks.find((candidate) => candidate.id === id);
  if (!track) return;
  if (!confirm("「" + track.title + "」をこの端末から削除しますか？")) return;
  if (currentTrackId === id) {
    elements.audio.pause();
    elements.audio.removeAttribute("src");
    elements.audio.load();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
    currentTrackId = null;
    elements.player.hidden = true;
  }
  await removeTrack(id);
  await refreshLibrary();
  showToast("端末から削除しました");
}

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

elements.pickFiles.addEventListener("click", () => elements.fileInput.click());
elements.emptyPick.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => importFiles(elements.fileInput.files));

elements.trackList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const row = event.target.closest(".track-row");
  if (!button || !row) return;
  if (button.dataset.action === "delete") deleteTrack(row.dataset.id);
  if (button.dataset.action === "play") {
    if (row.dataset.id === currentTrackId && !elements.audio.paused) elements.audio.pause();
    else playTrack(row.dataset.id);
  }
});

elements.playPause.addEventListener("click", () => {
  if (!currentTrackId && tracks.length) playTrack(tracks[0].id);
  else if (elements.audio.paused) elements.audio.play();
  else elements.audio.pause();
});
elements.previous.addEventListener("click", () => adjacentTrack(-1));
elements.next.addEventListener("click", () => adjacentTrack(1));
elements.audio.addEventListener("play", () => {
  elements.playPause.textContent = "Ⅱ";
  elements.playPause.setAttribute("aria-label", "一時停止");
  elements.playerState.textContent = "再生中";
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  renderLibrary();
});
elements.audio.addEventListener("pause", () => {
  elements.playPause.textContent = "▶";
  elements.playPause.setAttribute("aria-label", "再生");
  elements.playerState.textContent = "一時停止";
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  renderLibrary();
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
  await refreshLibrary();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("/service-worker.js"); } catch (_) { showToast("オフライン機能を準備できませんでした"); }
  }
}

start().catch(() => showToast("ライブラリを読み込めませんでした"));
