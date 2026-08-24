const TWO_PI = Math.PI * 2;

export class CloverDetector {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  analyze(source, options) {
    const maxWidth = 360;
    const scale = Math.min(1, maxWidth / source.width);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(source.element, 0, 0, width, height);

    const frame = this.ctx.getImageData(0, 0, width, height);
    const mask = buildGreenMask(frame.data, width, height);
    const leaves = findLeafBlobs(mask, frame.data, width, height);
    const candidates = scoreFourLeafGroups(leaves, width, height)
      .filter((candidate) => candidate.score >= options.threshold)
      .slice(0, 12)
      .map((candidate) => ({
        ...candidate,
        x: candidate.x / scale,
        y: candidate.y / scale,
        radius: candidate.radius / scale,
        leaves: candidate.leaves.map((leaf) => ({
          ...leaf,
          x: leaf.x / scale,
          y: leaf.y / scale,
          radius: leaf.radius / scale
        }))
      }));

    return { candidates, leaves, analysisSize: { width, height }, mask };
  }
}

function buildGreenMask(data, width, height) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const pixel = index * 4;
      const r = data[pixel];
      const g = data[pixel + 1];
      const b = data[pixel + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const value = max / 255;
      const greenDominance = g - Math.max(r * 0.78, b * 0.9);
      if (g > 58 && greenDominance > 10 && saturation > 0.18 && value > 0.16) {
        mask[index] = 1;
      }
    }
  }
  return mask;
}

function findLeafBlobs(mask, data, width, height) {
  const visited = new Uint8Array(mask.length);
  const leaves = [];
  const minArea = Math.max(10, Math.round((width * height) / 26000));
  const maxArea = Math.max(600, Math.round((width * height) / 300));

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let green = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = (index / width) | 0;
      area += 1;
      sumX += x;
      sumY += y;
      green += data[index * 4 + 1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (area < minArea || area > maxArea) continue;
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const aspect = boxW / Math.max(1, boxH);
    const fill = area / Math.max(1, boxW * boxH);
    if (aspect < 0.28 || aspect > 3.2 || fill < 0.18) continue;

    leaves.push({
      x: sumX / area,
      y: sumY / area,
      area,
      radius: Math.sqrt(area / Math.PI),
      box: { x: minX, y: minY, width: boxW, height: boxH },
      green: green / area
    });
  }

  return leaves
    .sort((a, b) => b.area - a.area)
    .slice(0, 220);
}

function scoreFourLeafGroups(leaves, width, height) {
  const candidates = [];
  const seen = new Set();
  const minDistance = Math.max(7, Math.min(width, height) * 0.018);
  const maxDistance = Math.max(22, Math.min(width, height) * 0.11);

  for (const leaf of leaves) {
    const neighbors = leaves
      .filter((other) => other !== leaf)
      .map((other) => ({ leaf: other, distance: distance(leaf, other) }))
      .filter((item) => item.distance >= minDistance && item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    const combinations = chooseThree(neighbors.map((item) => item.leaf));
    for (const combo of combinations) {
      const group = [leaf, ...combo];
      const key = group.map((item) => leaves.indexOf(item)).sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);

      const center = group.reduce((acc, item) => {
        acc.x += item.x / 4;
        acc.y += item.y / 4;
        return acc;
      }, { x: 0, y: 0 });
      const radii = group.map((item) => distance(center, item));
      const avgRadius = average(radii);
      if (avgRadius < minDistance || avgRadius > maxDistance) continue;

      const angles = group.map((item) => Math.atan2(item.y - center.y, item.x - center.x)).sort((a, b) => a - b);
      const gaps = angles.map((angle, index) => {
        const next = angles[(index + 1) % angles.length] + (index === angles.length - 1 ? TWO_PI : 0);
        return next - angle;
      });
      const targetGap = TWO_PI / 4;
      const angleScore = 1 - Math.min(1, average(gaps.map((gap) => Math.abs(gap - targetGap))) / targetGap);
      const radiusScore = 1 - clamp(stddev(radii) / Math.max(1, avgRadius), 0, 1);
      const areaScore = 1 - clamp(stddev(group.map((item) => item.area)) / Math.max(1, average(group.map((item) => item.area))), 0, 1);
      const centerPenalty = edgePenalty(center, width, height);
      const score = Math.round(clamp((angleScore * 0.42 + radiusScore * 0.28 + areaScore * 0.2 + centerPenalty * 0.1) * 100, 0, 99));

      candidates.push({
        x: center.x,
        y: center.y,
        radius: avgRadius + average(group.map((item) => item.radius)) * 1.7,
        score,
        leaves: group
      });
    }
  }

  return nonMaximumSuppression(candidates.sort((a, b) => b.score - a.score));
}

function chooseThree(items) {
  const result = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      for (let c = b + 1; c < items.length; c += 1) {
        result.push([items[a], items[b], items[c]]);
      }
    }
  }
  return result;
}

function nonMaximumSuppression(candidates) {
  const picked = [];
  for (const candidate of candidates) {
    const tooClose = picked.some((existing) => distance(candidate, existing) < Math.max(candidate.radius, existing.radius) * 0.65);
    if (!tooClose) picked.push(candidate);
  }
  return picked;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function stddev(values) {
  const avg = average(values);
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function edgePenalty(point, width, height) {
  const margin = Math.min(point.x, point.y, width - point.x, height - point.y);
  return clamp(margin / Math.min(width, height) * 8, 0, 1);
}
