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

  draw(candidates, debugLeaves = []) {
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

    for (const candidate of candidates) {
      const center = this.toCanvas(candidate.x, candidate.y);
      const radius = candidate.radius * this.fit.scale;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = candidate.score >= 75 ? "#d9ff58" : "#ffcc4a";
      ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = "rgba(16, 20, 15, 0.84)";
      const label = `#${candidate.id} 四葉候補 ${candidate.score}%`;
      ctx.font = `${Math.max(13, Math.round(14 * (window.devicePixelRatio || 1)))}px sans-serif`;
      const metrics = ctx.measureText(label);
      const labelWidth = metrics.width + 18;
      const labelHeight = 28 * (window.devicePixelRatio || 1);
      const labelX = Math.min(Math.max(8, center.x - labelWidth / 2), this.overlayCanvas.width - labelWidth - 8);
      const labelY = Math.max(8, center.y - radius - labelHeight - 6);
      roundRect(ctx, labelX, labelY, labelWidth, labelHeight, 7 * (window.devicePixelRatio || 1));
      ctx.fill();
      ctx.fillStyle = "#f3f7ec";
      ctx.fillText(label, labelX + 9, labelY + labelHeight * 0.68);
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

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}
