/* カット編集画面 — 波形表示・複数範囲カット・プレビュー再生・MP3書き出し */

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const MAX_EDIT_SECONDS = 1800;
const MIN_REGION_SECONDS = 0.2;
const PEAK_BLOCK = 512;

const ui = {
  root: document.querySelector("#editor"),
  title: document.querySelector("#editor-track-title"),
  cancel: document.querySelector("#editor-cancel"),
  save: document.querySelector("#editor-save"),
  loading: document.querySelector("#editor-loading"),
  main: document.querySelector("#editor-main"),
  scroll: document.querySelector("#wave-scroll"),
  spacer: document.querySelector("#wave-spacer"),
  canvas: document.querySelector("#wave-canvas"),
  regionsLayer: document.querySelector("#wave-regions"),
  playhead: document.querySelector("#wave-playhead"),
  pos: document.querySelector("#editor-pos"),
  dur: document.querySelector("#editor-dur"),
  result: document.querySelector("#editor-result"),
  play: document.querySelector("#editor-play"),
  add: document.querySelector("#editor-add"),
  zoomIn: document.querySelector("#editor-zoom-in"),
  zoomOut: document.querySelector("#editor-zoom-out"),
  regionList: document.querySelector("#region-list"),
  progress: document.querySelector("#editor-progress"),
  progressBar: document.querySelector("#editor-progress-bar"),
  progressPercent: document.querySelector("#editor-progress-percent"),
};

let state = null;

/* ---------- 共通ヘルパー ---------- */

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function formatFine(seconds) {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return minutes + ":" + String(Math.floor(rest)).padStart(2, "0") + "." + Math.floor((rest % 1) * 10);
}

function formatShort(seconds) {
  const safe = Math.max(0, Math.round(seconds || 0));
  return Math.floor(safe / 60) + ":" + String(safe % 60).padStart(2, "0");
}

/* ---------- 起動と終了 ---------- */

export async function openEditor(track, hooks) {
  if (state) return;
  ui.title.textContent = track.title;
  ui.loading.hidden = false;
  ui.main.hidden = true;
  ui.progress.hidden = true;
  ui.root.classList.add("open");
  ui.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("editor-open");

  let ctx;
  let buffer;
  try {
    ctx = new AudioCtx();
    const bytes = await track.blob.arrayBuffer();
    buffer = await ctx.decodeAudioData(bytes);
  } catch (_) {
    if (ctx) ctx.close().catch(() => {});
    hideEditorRoot();
    hooks.showToast("この曲は読み込めませんでした");
    return;
  }
  if (buffer.duration > MAX_EDIT_SECONDS) {
    ctx.close().catch(() => {});
    hideEditorRoot();
    hooks.showToast("編集できるのは30分以内の曲のみです");
    return;
  }

  state = {
    track,
    hooks,
    ctx,
    buffer,
    duration: buffer.duration,
    peaks: computePeaks(buffer),
    regions: [],
    nextRegionId: 1,
    regionEls: new Map(),
    zoom: 1,
    position: 0,
    playing: false,
    schedule: [],
    playToken: 0,
    worker: null,
    needsRedraw: true,
    raf: 0,
  };

  ui.loading.hidden = true;
  ui.main.hidden = false;
  ui.dur.textContent = formatFine(state.duration);
  applyZoom(1);
  renderRegions();
  renderRegionList();
  updateResultUI();
  updatePlayButton();
  ui.scroll.scrollLeft = 0;
  state.raf = requestAnimationFrame(frame);
}

function hideEditorRoot() {
  ui.root.classList.remove("open", "playing");
  ui.root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("editor-open");
}

function closeEditor() {
  if (!state) return;
  cancelAnimationFrame(state.raf);
  stopSources();
  if (state.worker) state.worker.terminate();
  state.ctx.close().catch(() => {});
  state = null;
  hideEditorRoot();
}

/* ---------- 波形 ---------- */

function computePeaks(buffer) {
  const length = buffer.length;
  const blocks = Math.ceil(length / PEAK_BLOCK);
  const peaks = new Float32Array(blocks * 2);
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
  for (let b = 0; b < blocks; b++) {
    let min = 1;
    let max = -1;
    const end = Math.min(length, (b + 1) * PEAK_BLOCK);
    for (let i = b * PEAK_BLOCK; i < end; i++) {
      let v = channels[0][i];
      if (channels.length > 1) v = (v + channels[1][i]) / 2;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

function resizeCanvas() {
  const width = ui.scroll.clientWidth;
  const height = 160;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ui.canvas.style.width = width + "px";
  ui.canvas.style.height = height + "px";
  ui.canvas.width = Math.round(width * dpr);
  ui.canvas.height = Math.round(height * dpr);
}

function drawWave() {
  const canvas = ui.canvas;
  const context = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!state) return;

  const totalWidth = ui.spacer.clientWidth;
  const scrollLeft = ui.scroll.scrollLeft;
  const samplesTotal = state.buffer.length;
  const blocks = state.peaks.length / 2;
  const mid = height / 2;
  const styles = getComputedStyle(document.body);
  context.fillStyle = styles.getPropertyValue("--wave") || "#a9a9b0";

  for (let x = 0; x < width; x++) {
    const startRatio = clamp((scrollLeft + x) / totalWidth, 0, 1);
    const endRatio = clamp((scrollLeft + x + 1) / totalWidth, 0, 1);
    const b0 = Math.floor(startRatio * samplesTotal / PEAK_BLOCK);
    const b1 = Math.max(b0 + 1, Math.ceil(endRatio * samplesTotal / PEAK_BLOCK));
    let min = 1;
    let max = -1;
    for (let b = b0; b < Math.min(b1, blocks); b++) {
      if (state.peaks[b * 2] < min) min = state.peaks[b * 2];
      if (state.peaks[b * 2 + 1] > max) max = state.peaks[b * 2 + 1];
    }
    if (max < min) { min = 0; max = 0; }
    const y0 = mid + min * (mid - 6);
    const y1 = mid + max * (mid - 6);
    context.fillRect(x, Math.min(y0, y1), 1, Math.max(1.2, Math.abs(y1 - y0)));
  }
}

function applyZoom(zoom) {
  if (!state) return;
  const anchor = state.position;
  state.zoom = clamp(zoom, 1, 64);
  ui.spacer.style.width = state.zoom * 100 + "%";
  resizeCanvas();
  const x = anchor / state.duration * ui.spacer.clientWidth;
  ui.scroll.scrollLeft = Math.max(0, x - ui.scroll.clientWidth / 2);
  state.needsRedraw = true;
}

/* ---------- カット範囲 ---------- */

function keptSegments() {
  const sorted = [...state.regions].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push({ start: region.start, end: region.end });
  }
  const kept = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.start > cursor + 0.01) kept.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < state.duration - 0.01) kept.push({ start: cursor, end: state.duration });
  return kept;
}

function keptDuration() {
  return keptSegments().reduce((sum, seg) => sum + (seg.end - seg.start), 0);
}

function positionRegionEl(el, region) {
  el.style.left = region.start / state.duration * 100 + "%";
  el.style.width = (region.end - region.start) / state.duration * 100 + "%";
}

function buildRegionEl(region) {
  const el = document.createElement("div");
  el.className = "wave-region";
  positionRegionEl(el, region);
  [["l", "開始位置"], ["r", "終了位置"]].forEach(([edge, label]) => {
    const handle = document.createElement("div");
    handle.className = "wave-handle " + edge;
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", label);
    handle.addEventListener("pointerdown", (event) => startDrag(event, region, edge, el));
    el.append(handle);
  });
  return el;
}

function startDrag(event, region, edge, el) {
  if (!state) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  try { handle.setPointerCapture(event.pointerId); } catch (_) { /* Synthetic pointer. */ }
  state.dragging = true;

  const move = (ev) => {
    const t = timeAtClientX(ev.clientX);
    if (edge === "l") region.start = clamp(Math.min(t, region.end - MIN_REGION_SECONDS), 0, state.duration);
    else region.end = clamp(Math.max(t, region.start + MIN_REGION_SECONDS), 0, state.duration);
    positionRegionEl(el, region);
    ui.pos.textContent = formatFine(edge === "l" ? region.start : region.end);
  };
  const finish = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
    state.dragging = false;
    renderRegionList();
    updateResultUI();
    restartIfPlaying();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function timeAtClientX(clientX) {
  const rect = ui.scroll.getBoundingClientRect();
  const x = clientX - rect.left + ui.scroll.scrollLeft;
  return clamp(x / ui.spacer.clientWidth, 0, 1) * state.duration;
}

function renderRegions() {
  state.regionEls.clear();
  ui.regionsLayer.replaceChildren(...state.regions.map((region) => {
    const el = buildRegionEl(region);
    state.regionEls.set(region.id, el);
    return el;
  }));
}

function renderRegionList() {
  const sorted = [...state.regions].sort((a, b) => a.start - b.start);
  ui.regionList.replaceChildren(...sorted.map((region, index) => {
    const item = document.createElement("li");
    item.className = "region-row";

    const badge = document.createElement("span");
    badge.className = "region-badge";
    badge.textContent = String(index + 1);

    const times = document.createElement("span");
    times.className = "region-times";
    times.textContent = formatFine(region.start) + " 〜 " + formatFine(region.end);

    const length = document.createElement("span");
    length.className = "region-length";
    length.textContent = (region.end - region.start).toFixed(1) + "秒";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "region-remove";
    remove.setAttribute("aria-label", "この範囲を削除");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.regions = state.regions.filter((candidate) => candidate.id !== region.id);
      renderRegions();
      renderRegionList();
      updateResultUI();
      restartIfPlaying();
    });

    item.append(badge, times, length, remove);
    return item;
  }));
}

function addRegion() {
  if (!state) return;
  const defaultLength = clamp(state.duration * 0.05, 2, 10);
  const start = clamp(state.position, 0, Math.max(0, state.duration - MIN_REGION_SECONDS));
  const end = Math.min(state.duration, start + defaultLength);
  state.regions.push({ id: state.nextRegionId++, start, end });
  renderRegions();
  renderRegionList();
  updateResultUI();
  restartIfPlaying();
}

function updateResultUI() {
  ui.result.textContent = "カット後 " + formatShort(keptDuration());
}

/* ---------- プレビュー再生（カット範囲をスキップ） ---------- */

function stopSources() {
  for (const item of state.schedule) {
    item.src.onended = null;
    try { item.src.stop(); } catch (_) { /* Already stopped. */ }
  }
  state.schedule = [];
}

function playFrom(position) {
  const token = ++state.playToken;
  stopSources();
  const segments = keptSegments().filter((seg) => seg.end > position + 0.02);
  if (!segments.length) {
    setPlaying(false);
    return;
  }
  if (state.ctx.resume) state.ctx.resume().catch(() => {});
  let when = state.ctx.currentTime + 0.08;
  for (const seg of segments) {
    const offset = Math.max(seg.start, position);
    const length = seg.end - offset;
    if (length <= 0.01) continue;
    const src = state.ctx.createBufferSource();
    src.buffer = state.buffer;
    src.connect(state.ctx.destination);
    src.start(when, offset, length);
    state.schedule.push({ src, ctxStart: when, ctxEnd: when + length, bufStart: offset });
    when += length;
  }
  const last = state.schedule[state.schedule.length - 1];
  last.src.onended = () => {
    if (state && state.playToken === token && state.playing) {
      state.position = 0;
      setPlaying(false);
    }
  };
  setPlaying(true);
}

function currentPlayPosition() {
  if (!state.playing || !state.schedule.length) return state.position;
  const t = state.ctx.currentTime;
  for (const item of state.schedule) {
    if (t < item.ctxStart) return item.bufStart;
    if (t < item.ctxEnd) return item.bufStart + (t - item.ctxStart);
  }
  const last = state.schedule[state.schedule.length - 1];
  return last.bufStart + (last.ctxEnd - last.ctxStart);
}

function pausePlayback() {
  state.position = currentPlayPosition();
  state.playToken++;
  stopSources();
  setPlaying(false);
}

function togglePlay() {
  if (!state) return;
  if (state.playing) {
    pausePlayback();
    return;
  }
  const kept = keptSegments();
  const lastEnd = kept.length ? kept[kept.length - 1].end : 0;
  const from = state.position >= lastEnd - 0.05 ? 0 : state.position;
  state.position = from;
  playFrom(from);
}

function seekTo(position) {
  if (!state) return;
  state.position = clamp(position, 0, state.duration);
  if (state.playing) playFrom(state.position);
}

function restartIfPlaying() {
  if (state && state.playing) {
    state.position = currentPlayPosition();
    playFrom(state.position);
  }
}

function setPlaying(playing) {
  state.playing = playing;
  updatePlayButton();
}

function updatePlayButton() {
  ui.root.classList.toggle("playing", Boolean(state && state.playing));
}

/* ---------- 画面更新ループ ---------- */

function frame() {
  if (!state) return;
  if (state.playing) {
    state.position = currentPlayPosition();
    followPlayhead();
  }
  if (!state.dragging) ui.pos.textContent = formatFine(state.position);
  ui.playhead.style.left = state.position / state.duration * 100 + "%";
  if (state.needsRedraw) {
    drawWave();
    state.needsRedraw = false;
  }
  state.raf = requestAnimationFrame(frame);
}

function followPlayhead() {
  const x = state.position / state.duration * ui.spacer.clientWidth;
  const width = ui.scroll.clientWidth;
  const left = ui.scroll.scrollLeft;
  if (x < left + 16 || x > left + width - 16) {
    ui.scroll.scrollLeft = Math.max(0, x - width / 2);
  }
}

/* ---------- 保存（MP3書き出し） ---------- */

function estimateKbps(track, duration) {
  const measured = (track.size * 8) / 1000 / Math.max(1, duration);
  const rates = [96, 128, 160, 192, 224, 256, 320];
  let best = 192;
  let bestDiff = Infinity;
  for (const rate of rates) {
    const diff = Math.abs(rate - measured);
    if (diff < bestDiff) { bestDiff = diff; best = rate; }
  }
  return best;
}

function requestSave() {
  if (!state) return;
  if (!state.regions.length) {
    state.hooks.showToast("カット範囲がありません。「カット範囲を追加」から始めてください");
    return;
  }
  if (keptDuration() < 1) {
    state.hooks.showToast("残る音声が短すぎます");
    return;
  }
  state.hooks.showActionSheet("カットした曲の保存方法", [
    { label: "新しい曲として保存", handler: () => renderAndSave("copy") },
    { label: "元の曲を置き換える", danger: true, handler: () => renderAndSave("replace") },
  ]);
}

function renderAndSave(mode) {
  if (!state || state.worker) return;
  pausePlayback();

  const buffer = state.buffer;
  const sampleRate = buffer.sampleRate;
  const channelCount = Math.min(2, buffer.numberOfChannels);
  const segments = keptSegments().map((seg) => ({
    start: Math.round(seg.start * sampleRate),
    end: Math.min(buffer.length, Math.round(seg.end * sampleRate)),
  })).filter((seg) => seg.end > seg.start);
  const totalSamples = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);

  const channels = [];
  for (let c = 0; c < channelCount; c++) {
    const source = buffer.getChannelData(c);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const seg of segments) {
      merged.set(source.subarray(seg.start, seg.end), offset);
      offset += seg.end - seg.start;
    }
    channels.push(merged);
  }

  ui.main.hidden = true;
  ui.progress.hidden = false;
  ui.save.disabled = true;
  ui.progressBar.style.width = "0%";
  ui.progressPercent.textContent = "0%";

  const worker = new Worker("/editor-worker.js");
  state.worker = worker;
  worker.onmessage = async (event) => {
    const message = event.data;
    if (message.type === "progress") {
      const percent = Math.round(message.value * 100);
      ui.progressBar.style.width = percent + "%";
      ui.progressPercent.textContent = percent + "%";
      return;
    }
    if (message.type === "error") {
      failSave("変換に失敗しました：" + message.message);
      return;
    }
    if (message.type === "done") {
      const hooks = state.hooks;
      const blob = new Blob(message.chunks, { type: "audio/mpeg" });
      worker.terminate();
      state.worker = null;
      try {
        await hooks.onSave(blob, mode);
        closeEditor();
      } catch (_) {
        failSave("保存できませんでした");
      }
    }
  };
  worker.onerror = () => failSave("変換に失敗しました");
  worker.postMessage(
    { channels, sampleRate, kbps: estimateKbps(state.track, state.duration) },
    channels.map((channel) => channel.buffer)
  );
}

function failSave(message) {
  if (!state) return;
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  state.hooks.showToast(message);
  ui.progress.hidden = true;
  ui.main.hidden = false;
  ui.save.disabled = false;
}

/* ---------- 恒久イベント ---------- */

ui.cancel.addEventListener("click", () => {
  if (!state) return;
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
    ui.progress.hidden = true;
    ui.main.hidden = false;
    ui.save.disabled = false;
    return;
  }
  if (state.regions.length && !confirm("編集内容を破棄しますか？")) return;
  closeEditor();
});

ui.save.addEventListener("click", requestSave);
ui.play.addEventListener("click", togglePlay);
ui.add.addEventListener("click", addRegion);
ui.zoomIn.addEventListener("click", () => applyZoom(state ? state.zoom * 2 : 1));
ui.zoomOut.addEventListener("click", () => applyZoom(state ? state.zoom / 2 : 1));

ui.scroll.addEventListener("scroll", () => {
  if (state) state.needsRedraw = true;
});
ui.scroll.addEventListener("click", (event) => {
  if (!state || event.target.closest(".wave-handle")) return;
  seekTo(timeAtClientX(event.clientX));
});
window.addEventListener("resize", () => {
  if (!state) return;
  resizeCanvas();
  state.needsRedraw = true;
});
