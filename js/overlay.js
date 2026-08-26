export class OverlayRenderer {
  constructor(previewCanvas, overlayCanvas) {
    this.previewCanvas = previewCanvas;
    this.overlayCanvas = overlayCanvas;
    this.previewCtx = previewCanvas.getContext("2d");
    this.overlayCtx = overlayCanvas.getContext("2d");
    this.fit = { x: 0, y: 0, width: 1, height: 1, scale: 1 };
  }

  resize() {
    for (const canvas of [this.previewCanvas, this.overlayCanvas]) {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    }
  }

  drawSource(source) {
    this.resize();
    const canvas = this.previewCanvas;
    const ctx = this.previewCtx;
    const fit = containFit(source.width, source.height, canvas.width, canvas.height);
    this.fit = fit;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source.element, fit.x, fit.y, fit.width, fit.height);
  }

  draw(candidates, debugLeaves = [], focusPoint = null) {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    for (const leaf of debugLeaves) {
      const point = this.toCanvas(leaf.x, leaf.y);
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(2, leaf.radius * this.fit.scale), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(217, 255, 88, 0.34)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (focusPoint) {
      const point = this.toCanvas(focusPoint.x, focusPoint.y);
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, focusPoint.radius * this.fit.scale, 0, Math.PI * 2);
      ctx.setLineDash([12 * (window.devicePixelRatio || 1), 8 * (window.devicePixelRatio || 1)]);
      ctx.lineWidth = Math.max(2, 3 * (window.devicePixelRatio || 1));
      ctx.strokeStyle = "rgba(243, 247, 236, 0.58)";
      ctx.stroke();
      ctx.restore();
    }

    for (const candidate of candidates) {
      const center = this.toCanvas(candidate.x, candidate.y);
      const sourceScale = candidate.source === "pale-pattern" ? 0.32 : candidate.source === "center-cross" ? 0.4 : candidate.source === "junction" ? 0.44 : 0.5;
      const radius = Math.max(9 * (window.devicePixelRatio || 1), candidate.radius * this.fit.scale * sourceScale);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(3, 5 * (window.devicePixelRatio || 1));
      ctx.strokeStyle = scoreColor(candidate.displayScore ?? candidate.score);
      ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const dotRadius = Math.max(3 * (window.devicePixelRatio || 1), Math.min(7 * (window.devicePixelRatio || 1), radius * 0.28));
      ctx.beginPath();
      ctx.arc(center.x, center.y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#1e88ff";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = Math.max(1.5, 2 * (window.devicePixelRatio || 1));
      ctx.fill();
      ctx.stroke();
    }
  }

  pick(candidates, clientX, clientY) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;
    return candidates.find((candidate) => {
      const center = this.toCanvas(candidate.x, candidate.y);
      return Math.hypot(center.x - x, center.y - y) <= Math.max(36 * dpr, candidate.radius * this.fit.scale * 1.2);
    });
  }

  toCanvas(x, y) {
    return {
      x: this.fit.x + x * this.fit.scale,
      y: this.fit.y + y * this.fit.scale
    };
  }
}

function containFit(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return {
    x: (dstW - width) / 2,
    y: (dstH - height) / 2,
    width,
    height,
    scale
  };
}

function scoreColor(score) {
  const t = Math.max(0, Math.min(1, (score - 45) / 50));
  const hue = 46 - t * 46;
  const lightness = 58 - t * 8;
  return `hsl(${hue} 92% ${lightness}%)`;
}
