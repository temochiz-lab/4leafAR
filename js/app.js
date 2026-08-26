import { CameraController } from "./camera.js";
import { CloverDetector } from "./detector.js";
import { OverlayRenderer } from "./overlay.js";
import { CandidateStore, downloadBlob } from "./storage.js";
import { CandidateTracker } from "./tracker.js";

const video = document.querySelector("#cameraVideo");
const previewCanvas = document.querySelector("#previewCanvas");
const overlayCanvas = document.querySelector("#overlayCanvas");
const statusText = document.querySelector("#statusText");
const candidateCount = document.querySelector("#candidateCount");
const opencvState = document.querySelector("#opencvState");
const candidatePanel = document.querySelector("#candidatePanel");
const selectedLabel = document.querySelector("#selectedLabel");
const selectedScore = document.querySelector("#selectedScore");
const thresholdInput = document.querySelector("#thresholdInput");
const thresholdValue = document.querySelector("#thresholdValue");
const fpsInput = document.querySelector("#fpsInput");
const fpsValue = document.querySelector("#fpsValue");
const debugInput = document.querySelector("#debugInput");
const savedCount = document.querySelector("#savedCount");
const arModeButton = document.querySelector("#arModeButton");
const stillModeButton = document.querySelector("#stillModeButton");

const camera = new CameraController(video);
const detector = new CloverDetector();
const tracker = new CandidateTracker();
const overlay = new OverlayRenderer(previewCanvas, overlayCanvas);
const store = new CandidateStore();

let source = null;
let running = false;
let paused = false;
let lastAnalysis = 0;
let visibleCandidates = [];
let selectedCandidate = null;
let lastDebugLeaves = [];
let focusPoint = null;
let mode = "ar";

window.addEventListener("opencv-ready", () => {
  opencvState.textContent = "OpenCV.js 利用可能";
});

opencvState.textContent = window.cv?.Mat ? "OpenCV.js 利用可能" : "JS解析 / OpenCV差し替え可";

document.querySelector("#startButton").addEventListener("click", startCamera);
document.querySelector("#pauseButton").addEventListener("click", togglePause);
document.querySelector("#imageInput").addEventListener("change", loadImage);
arModeButton.addEventListener("click", () => setMode("ar"));
stillModeButton.addEventListener("click", () => setMode("still"));
document.querySelector("#downloadJsonButton").addEventListener("click", downloadJson);
document.querySelector("#downloadImagesButton").addEventListener("click", downloadImages);
document.querySelector("#clearButton").addEventListener("click", clearSaved);
overlayCanvas.addEventListener("click", pickCandidate);
thresholdInput.addEventListener("input", syncSettings);
fpsInput.addEventListener("input", syncSettings);
window.addEventListener("resize", () => {
  if (source) overlay.drawSource(source);
  overlay.draw(visibleCandidates, debugInput.checked ? lastDebugLeaves : [], focusPoint);
});

document.querySelectorAll("[data-label]").forEach((button) => {
  button.addEventListener("click", () => saveSelected(button.dataset.label));
});

syncSettings();
refreshSavedCount();
statusText.textContent = "カメラ開始またはテスト画像を選択";

async function startCamera() {
  try {
    setMode("ar");
    statusText.textContent = "カメラ権限を確認中";
    const element = await camera.start();
    source = {
      type: "camera",
      element,
      get width() {
        return element.videoWidth;
      },
      get height() {
        return element.videoHeight;
      }
    };
    running = true;
    paused = false;
    tracker.reset();
    statusText.textContent = "解析中";
    requestAnimationFrame(loop);
  } catch (error) {
    statusText.textContent = error.message || "カメラを開始できません";
  }
}

function togglePause() {
  paused = !paused;
  document.querySelector("#pauseButton").textContent = paused ? "解析再開" : "解析停止";
  statusText.textContent = paused ? "停止中" : "解析中";
  if (!paused && source) requestAnimationFrame(loop);
}

async function loadImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setMode("still");
  await loadImageUrl(URL.createObjectURL(file), true);
}

async function loadImageUrl(url, revoke) {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (revoke) URL.revokeObjectURL(url);
  camera.stop();
  source = { type: "image", element: image, width: image.naturalWidth, height: image.naturalHeight };
  running = true;
  paused = false;
  focusPoint = null;
  tracker.reset();
  analyzeNow();
}

function loop(time) {
  if (!running || !source || paused) return;
  overlay.drawSource(source);
  const interval = 1000 / Number(fpsInput.value);
  if (time - lastAnalysis >= interval && source.width && source.height) {
    analyzeNow();
    lastAnalysis = time;
  } else {
    overlay.draw(visibleCandidates, debugInput.checked ? lastDebugLeaves : [], focusPoint);
  }
  if (source.type === "camera") requestAnimationFrame(loop);
}

function analyzeNow() {
  if (!source.width || !source.height) return;
  overlay.drawSource(source);
  const result = detector.analyze(source, getAnalysisOptions());
  visibleCandidates = mode === "ar" ? tracker.update(result.candidates) : stabilizeStillCandidates(result.candidates);
  lastDebugLeaves = result.leaves.map((leaf) => ({
    x: leaf.x / (result.analysisSize.width / source.width),
    y: leaf.y / (result.analysisSize.height / source.height),
    radius: leaf.radius / (result.analysisSize.width / source.width)
  }));
  candidateCount.textContent = String(visibleCandidates.length);
  statusText.textContent = getStatusMessage(visibleCandidates.length);
  overlay.draw(visibleCandidates, debugInput.checked ? lastDebugLeaves : [], focusPoint);
  window.__cloverDebug = {
    source: { width: source.width, height: source.height, type: source.type },
    mode,
    candidates: visibleCandidates,
    leaves: lastDebugLeaves.length,
    paleMarks: result.paleMarks?.length || 0,
    paleCandidates: result.paleCandidates?.slice(0, 12) || [],
    rankedCandidates: result.rankedCandidates?.slice(0, 80) || []
  };
}

function setMode(nextMode) {
  mode = nextMode;
  arModeButton.classList.toggle("active", mode === "ar");
  stillModeButton.classList.toggle("active", mode === "still");
  arModeButton.setAttribute("aria-selected", String(mode === "ar"));
  stillModeButton.setAttribute("aria-selected", String(mode === "still"));
  fpsInput.disabled = mode === "still";
  document.querySelector("#startButton").disabled = mode === "still";
  document.querySelector("#pauseButton").disabled = mode === "still";
  opencvState.textContent = mode === "still" ? "静止画高解像度解析" : (window.cv?.Mat ? "OpenCV.js 利用可能" : "JS解析 / OpenCV差し替え可");

  if (mode === "still") {
    camera.stop();
    paused = false;
    running = Boolean(source);
  }

  if (source) {
    tracker.reset();
    analyzeNow();
  }
}

function getAnalysisOptions() {
  const threshold = Number(thresholdInput.value);
  if (mode === "still") {
    return {
      threshold: Math.max(35, threshold - 8),
      focusPoint,
      maxWidth: 900,
      maxCandidates: 72
    };
  }
  return {
    threshold,
    focusPoint,
    maxWidth: 360,
    maxCandidates: 24
  };
}

function stabilizeStillCandidates(candidates) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    id: index + 1,
    hits: 1,
    streak: 1,
    stability: 1,
    displayScore: candidate.score
  }));
}

function getStatusMessage(count) {
  if (mode === "still") {
    return count ? "静止画の四葉候補を表示中" : "候補なし / 別の写真で試してください";
  }
  return count ? "四葉候補を表示中" : "候補なし / カメラを近づけてください";
}

function pickCandidate(event) {
  const candidate = overlay.pick(visibleCandidates, event.clientX, event.clientY);
  if (!candidate) {
    candidatePanel.hidden = true;
    selectedCandidate = null;
    return;
  }
  selectedCandidate = candidate;
  selectedLabel.textContent = `候補 #${candidate.id}`;
  selectedScore.textContent = `${candidate.displayScore ?? candidate.score}%`;
  candidatePanel.hidden = false;
}

async function saveSelected(label) {
  if (!source || !selectedCandidate) return;
  await store.save(source, selectedCandidate, label);
  if (label === "四葉") {
    const radius = Math.max(selectedCandidate.radius * 4.5, Math.min(source.width, source.height) * 0.18);
    focusPoint = { x: selectedCandidate.x, y: selectedCandidate.y, radius };
  }
  candidatePanel.hidden = true;
  selectedCandidate = null;
  statusText.textContent = `${label}として保存しました`;
  await refreshSavedCount();
  analyzeNow();
}

async function downloadJson() {
  const records = await store.all();
  const jsonRecords = records.map(({ blob, ...record }) => record);
  downloadBlob(new Blob([JSON.stringify(jsonRecords, null, 2)], { type: "application/json" }), "clover-candidates.json");
}

async function downloadImages() {
  const records = await store.all();
  for (const record of records) {
    downloadBlob(record.blob, `clover-${record.label}-${record.id}.jpg`);
  }
}

async function clearSaved() {
  await store.clear();
  focusPoint = null;
  await refreshSavedCount();
  statusText.textContent = "記録をクリアしました";
  if (source) analyzeNow();
}

async function refreshSavedCount() {
  savedCount.textContent = String(await store.count());
}

function syncSettings() {
  thresholdValue.textContent = `${thresholdInput.value}%`;
  fpsValue.textContent = `${fpsInput.value} fps`;
}
