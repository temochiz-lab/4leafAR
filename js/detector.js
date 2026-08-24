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
    const paleMarks = findPaleMarkBlobs(frame.data, mask, width, height);
    const paleCandidates = scorePaleMarkGroups(paleMarks, width, height);
    const candidates = mergeCandidates([
      ...paleCandidates,
      ...scoreFourLeafGroups(leaves, width, height),
      ...scanRadialCloverCenters(frame.data, mask, width, height)
    ])
      .filter((candidate) => candidate.score >= options.threshold)
      .slice(0, 8)
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

    return { candidates, leaves, analysisSize: { width, height }, mask, paleMarks, paleCandidates };
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

function findPaleMarkBlobs(data, mask, width, height) {
  const paleMask = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const pixel = index * 4;
    const r = data[pixel];
    const g = data[pixel + 1];
    const b = data[pixel + 2];
    const luminance = getLuminance(data, pixel);
    const warmEnough = r > g * 0.52 && b > g * 0.36;
    if (g > 100 && luminance > 104 && warmEnough) {
      paleMask[index] = 1;
    }
  }

  const visited = new Uint8Array(paleMask.length);
  const marks = [];
  const minArea = Math.max(4, Math.round((width * height) / 90000));
  const maxArea = Math.max(600, Math.round((width * height) / 140));

  for (let start = 0; start < paleMask.length; start += 1) {
    if (!paleMask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
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
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= paleMask.length || visited[next] || !paleMask[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (area < minArea || area > maxArea) continue;
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    if (boxW > width * 0.14 || boxH > height * 0.14) continue;
    marks.push({
      x: sumX / area,
      y: sumY / area,
      area,
      radius: Math.sqrt(area / Math.PI)
    });
  }

  return marks
    .sort((a, b) => b.area - a.area)
    .slice(0, 260);
}

function scorePaleMarkGroups(marks, width, height) {
  const candidates = [];
  const seen = new Set();
  const minDistance = Math.max(10, Math.min(width, height) * 0.025);
  const maxDistance = Math.max(28, Math.min(width, height) * 0.12);

  for (const mark of marks) {
    const neighbors = marks
      .filter((other) => other !== mark)
      .map((other) => ({ mark: other, distance: distance(mark, other) }))
      .filter((item) => item.distance >= minDistance && item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 7)
      .map((item) => item.mark);

    for (const combo of chooseUpToThree(neighbors)) {
      const group = [mark, ...combo];
      if (group.length < 3) continue;
      const key = group.map((item) => marks.indexOf(item)).sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      const center = group.reduce((acc, item) => {
        acc.x += item.x / group.length;
        acc.y += item.y / group.length;
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
      const targetGap = TWO_PI / group.length;
      const angleScore = 1 - clamp(average(gaps.map((gap) => Math.abs(gap - targetGap))) / targetGap, 0, 1);
      const radiusScore = 1 - clamp(stddev(radii) / Math.max(1, avgRadius), 0, 1);
      const sizeScore = clamp(Math.log1p(average(group.map((item) => item.area))) / 4.2, 0, 1);
      const countScore = group.length === 4 ? 1 : 0.76;
      const score = Math.round(clamp((countScore * 0.28 + angleScore * 0.28 + radiusScore * 0.22 + sizeScore * 0.14 + edgePenalty(center, width, height) * 0.08) * 100, 0, 98));
      candidates.push({
        x: center.x,
        y: center.y,
        radius: avgRadius * 2.2 + average(group.map((item) => item.radius)) * 1.8,
        score,
        leaves: []
      });
    }
  }

  return nonMaximumSuppression(candidates.sort((a, b) => b.score - a.score));
}

function chooseUpToThree(items) {
  const result = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      result.push([items[a], items[b]]);
      for (let c = b + 1; c < items.length; c += 1) {
        result.push([items[a], items[b], items[c]]);
      }
    }
  }
  return result;
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

function scanRadialCloverCenters(data, mask, width, height) {
  const candidates = [];
  const step = Math.max(4, Math.round(Math.min(width, height) / 120));
  const minRadius = Math.max(16, Math.round(Math.min(width, height) * 0.04));
  const radii = [minRadius, Math.round(minRadius * 1.25), Math.round(minRadius * 1.55)];
  const margin = Math.max(...radii) + 4;

  for (let y = margin; y < height - margin; y += step) {
    for (let x = margin; x < width - margin; x += step) {
      if (!isPotentialCenter(data, mask, width, x, y)) continue;
      let best = null;
      for (const radius of radii) {
        const candidate = scoreRadialCenter(data, mask, width, height, x, y, radius);
        if (!best || candidate.score > best.score) best = candidate;
      }
      if (best && best.score >= 42) candidates.push(best);
    }
  }

  return nonMaximumSuppression(candidates.sort((a, b) => b.score - a.score)).slice(0, 24);
}

function isPotentialCenter(data, mask, width, x, y) {
  const index = y * width + x;
  const pixel = index * 4;
  const luminance = getLuminance(data, pixel);
  let nearbyGreen = 0;
  let samples = 0;
  for (let dy = -5; dy <= 5; dy += 5) {
    for (let dx = -5; dx <= 5; dx += 5) {
      nearbyGreen += mask[(y + dy) * width + x + dx] || 0;
      samples += 1;
    }
  }
  return nearbyGreen / samples > 0.35 || luminance < 95;
}

function scoreRadialCenter(data, mask, width, height, x, y, radius) {
  const sectors = 32;
  const ringValues = [];
  const paleValues = [];
  const darkValues = [];
  let greenCoverage = 0;
  let darkSpokes = 0;

  for (let i = 0; i < sectors; i += 1) {
    const angle = (i / sectors) * TWO_PI;
    const outer = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    const mid = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius * 0.58, y + Math.sin(angle) * radius * 0.58);
    ringValues.push(outer.greenScore * 0.55 + mid.greenScore * 0.45);
    paleValues.push(Math.max(outer.paleScore, mid.paleScore));
    darkValues.push(clamp((105 - mid.luminance) / 85, 0, 1) * (outer.isGreen ? 1 : 0.55));
    if (outer.isGreen || mid.isGreen) greenCoverage += 1;
    if (mid.luminance < 82 && outer.isGreen) darkSpokes += 1;
  }

  const peaks = countPeakGroups(ringValues);
  const paleGroups = countPeakGroups(paleValues);
  const darkGroups = countPeakGroups(darkValues);
  const centerDarkness = centerDarknessScore(data, width, x, y, radius);
  const coverageScore = clamp(greenCoverage / sectors, 0, 1);
  const peakScore = peaks === 4 ? 1 : peaks === 3 || peaks === 5 ? 0.66 : peaks === 2 || peaks === 6 ? 0.32 : 0.1;
  const darkGroupScore = darkGroups === 4 ? 1 : darkGroups === 3 || darkGroups === 5 ? 0.58 : darkGroups === 2 || darkGroups === 6 ? 0.24 : 0.06;
  const paleScore = paleGroups >= 3 && paleGroups <= 5 ? 0.78 : paleGroups === 2 ? 0.4 : 0.14;
  const spokeScore = clamp(darkSpokes / 10, 0, 1);
  const rawScore = peakScore * 0.22 + darkGroupScore * 0.32 + centerDarkness * 0.2 + coverageScore * 0.14 + paleScore * 0.08 + spokeScore * 0.04;
  const score = Math.round(clamp(rawScore * 100, 0, 96));

  return {
    x,
    y,
    radius: radius * 1.45,
    score,
    leaves: []
  };
}

function sampleAt(data, mask, width, height, fx, fy) {
  const x = clamp(Math.round(fx), 0, width - 1);
  const y = clamp(Math.round(fy), 0, height - 1);
  const index = y * width + x;
  const pixel = index * 4;
  const r = data[pixel];
  const g = data[pixel + 1];
  const b = data[pixel + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const luminance = getLuminance(data, pixel);
  const greenScore = clamp((g - Math.max(r * 0.72, b * 0.84) + saturation * 80) / 130, 0, 1);
  const paleScore = clamp((luminance - 95) / 95, 0, 1) * greenScore;
  return {
    greenScore,
    paleScore,
    luminance,
    isGreen: Boolean(mask[index]) || greenScore > 0.34
  };
}

function centerDarknessScore(data, width, x, y, radius) {
  const center = averageDiskLuminance(data, width, x, y, Math.max(2, Math.round(radius * 0.12)));
  const ring = averageRingLuminance(data, width, x, y, Math.round(radius * 0.42), 16);
  return clamp((ring - center + 22) / 92, 0, 1);
}

function averageDiskLuminance(data, width, x, y, radius) {
  let sum = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const pixel = ((y + dy) * width + x + dx) * 4;
      sum += getLuminance(data, pixel);
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

function averageRingLuminance(data, width, x, y, radius, samples) {
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const angle = (i / samples) * TWO_PI;
    const pixel = (Math.round(y + Math.sin(angle) * radius) * width + Math.round(x + Math.cos(angle) * radius)) * 4;
    sum += getLuminance(data, pixel);
  }
  return sum / samples;
}

function countPeakGroups(values) {
  const avg = average(values);
  const sd = stddev(values);
  const threshold = Math.max(0.32, avg + sd * 0.12);
  const flags = values.map((value) => value >= threshold);
  if (flags.every(Boolean) || flags.every((value) => !value)) return 0;
  let groups = 0;
  for (let i = 0; i < flags.length; i += 1) {
    const prev = flags[(i - 1 + flags.length) % flags.length];
    if (flags[i] && !prev) groups += 1;
  }
  return groups;
}

function mergeCandidates(candidates) {
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
    const tooClose = picked.some((existing) => distance(candidate, existing) < Math.max(candidate.radius, existing.radius) * 0.95);
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

function getLuminance(data, pixel) {
  return data[pixel] * 0.2126 + data[pixel + 1] * 0.7152 + data[pixel + 2] * 0.0722;
}

function edgePenalty(point, width, height) {
  const margin = Math.min(point.x, point.y, width - point.x, height - point.y);
  return clamp(margin / Math.min(width, height) * 8, 0, 1);
}
