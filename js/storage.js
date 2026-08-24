const DB_NAME = "four-leaf-clover-ar";
const STORE = "candidates";

export class CandidateStore {
  constructor() {
    this.dbPromise = openDb();
  }

  async save(source, candidate, label) {
    const crop = cropCandidate(source, candidate);
    const blob = await new Promise((resolve) => crop.canvas.toBlob(resolve, "image/jpeg", 0.9));
    const record = {
      id: `${Date.now()}-${candidate.id}`,
      label,
      score: candidate.score,
      trackingId: candidate.id,
      method: window.cv?.Mat ? "opencv-ready-rule-baseline" : "js-rule-baseline",
      capturedAt: new Date().toISOString(),
      imageSize: { width: source.width, height: source.height },
      crop: crop.bounds,
      blob
    };
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    await txDone(tx);
    return record;
  }

  async all() {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async clear() {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  }

  async count() {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function cropCandidate(source, candidate) {
  const size = Math.round(Math.max(candidate.radius * 3.2, 128));
  const x = Math.max(0, Math.round(candidate.x - size / 2));
  const y = Math.max(0, Math.round(candidate.y - size / 2));
  const width = Math.min(size, source.width - x);
  const height = Math.min(size, source.height - y);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source.element, x, y, width, height, 0, 0, width, height);
  return { canvas, bounds: { x, y, width, height } };
}
