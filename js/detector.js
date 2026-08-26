const TWO_PI = Math.PI * 2;

export class CloverDetector {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  analyze(source, options) {
    const maxWidth = options.maxWidth || 360;
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
    const focusPoint = options.focusPoint
      ? {
          x: options.focusPoint.x * scale,
          y: options.focusPoint.y * scale,
          radius: options.focusPoint.radius * scale
        }
      : null;
    let rankedCandidates = boostFocusedCandidates(mergeCandidates([
      ...paleCandidates,
      ...scanCenterDotCandidates(frame.data, mask, width, height),
      ...scoreFourLeafGroups(leaves, width, height),
      ...scanDarkJunctionCenters(frame.data, mask, width, height)
    ]), focusPoint);

    if (options.precisionMode) {
      rankedCandidates = refineStillCandidates(frame.data, mask, width, height, rankedCandidates.slice(0, options.refineCandidates || 160));
    }

    const candidates = rankedCandidates
      .filter((candidate) => candidate.score >= options.threshold)
      .slice(0, options.maxCandidates || 24)
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

    return { candidates, leaves, analysisSize: { width, height }, mask, paleMarks, paleCandidates, rankedCandidates };
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
      const score = Math.round(clamp((countScore * 0.22 + angleScore * 0.32 + radiusScore * 0.24 + sizeScore * 0.1 + edgePenalty(center, width, height) * 0.08) * 100, 0, 90));
      candidates.push({
        x: center.x,
        y: center.y,
        radius: avgRadius * 1.35 + average(group.map((item) => item.radius)) * 1.1,
        score,
        source: "pale-pattern",
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
      const score = Math.round(clamp((angleScore * 0.44 + radiusScore * 0.3 + areaScore * 0.22 + centerPenalty * 0.04) * 100, 0, 99));

      candidates.push({
        x: center.x,
        y: center.y,
        radius: avgRadius + average(group.map((item) => item.radius)) * 1.7,
        score,
        source: "leaf-group",
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
  const margin = Math.max(4, Math.round(minRadius * 0.35));

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

function scanDarkJunctionCenters(data, mask, width, height) {
  const junctions = findDarkJunctionBlobs(data, mask, width, height);
  const candidates = [];
  const baseRadius = Math.max(12, Math.round(Math.min(width, height) * 0.035));
  const radii = [baseRadius, Math.round(baseRadius * 1.28), Math.round(baseRadius * 1.62)];

  for (const junction of junctions) {
    let best = null;
    for (const radius of radii) {
      const candidate = scoreRadialCenter(data, mask, width, height, junction.x, junction.y, radius);
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best || best.debug.voidPenalty > 0.4 || best.debug.localGreen < 0.38) continue;
    candidates.push({
      ...best,
      x: junction.x,
      y: junction.y,
      radius: Math.max(best.radius * 0.54, junction.radius * 4.2),
      score: Math.round(clamp(best.score + 16 + Math.min(6, junction.strength * 6), 0, 96)),
      source: "junction"
    });
  }

  return nonMaximumSuppression(candidates.sort((a, b) => b.score - a.score)).slice(0, 36);
}

function scanCenterDotCandidates(data, mask, width, height) {
  const dots = findCenterDotBlobs(data, mask, width, height);
  const candidates = [];
  const baseRadius = Math.max(11, Math.round(Math.min(width, height) * 0.032));
  const radii = [baseRadius, Math.round(baseRadius * 1.3), Math.round(baseRadius * 1.65)];

  for (const dot of dots) {
    let best = null;
    for (const radius of radii) {
      const candidate = scoreRadialCenter(data, mask, width, height, dot.x, dot.y, radius);
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best || best.debug.localGreen < 0.44 || best.debug.voidPenalty > 0.34) continue;
    candidates.push({
      ...best,
      x: dot.x,
      y: dot.y,
      radius: Math.max(best.radius * 0.5, dot.radius * 7),
      score: Math.round(clamp(best.score + 18 + dot.redness * 6, 0, 96)),
      source: "center-cross"
    });
  }

  return nonMaximumSuppression(candidates.sort((a, b) => b.score - a.score)).slice(0, 48);
}

function refineStillCandidates(data, mask, width, height, candidates) {
  const refined = [];
  const minDimension = Math.min(width, height);

  for (const candidate of candidates) {
    const baseRadius = clamp(candidate.radius / 1.45, minDimension * 0.018, minDimension * 0.105);
    const offsetStep = Math.max(2, baseRadius);
    const offsets = [-0.46, -0.24, 0, 0.24, 0.46].map((ratio) => Math.round(offsetStep * ratio));
    const radii = [baseRadius * 0.58, baseRadius * 0.74, baseRadius * 0.92, baseRadius * 1.1, baseRadius * 1.32, baseRadius * 1.54];
    let best = null;

    for (const dy of offsets) {
      for (const dx of offsets) {
        const x = clamp(candidate.x + dx, 0, width - 1);
        const y = clamp(candidate.y + dy, 0, height - 1);
        for (const radius of radii) {
          const scored = scoreRadialCenter(data, mask, width, height, x, y, radius);
          const stillScore = scoreStillCandidate(data, mask, width, height, scored, candidate);
          const refinedCandidate = {
            ...scored,
            radius: Math.max(radius * 1.05, candidate.radius * 0.42),
            score: stillScore,
            source: candidate.source === "pale-pattern" ? "still-pattern" : candidate.source,
            leaves: candidate.leaves || [],
            debug: {
              ...scored.debug,
              firstPassScore: candidate.score,
              firstPassSource: candidate.source
            }
          };
          if (!best || refinedCandidate.score > best.score) best = refinedCandidate;
        }
      }
    }

    if (best && best.score >= 42) refined.push(best);
  }

  return nonMaximumSuppression(refined.sort((a, b) => b.score - a.score), 1.22);
}

function scoreStillCandidate(data, mask, width, height, candidate, firstPass) {
  const debug = candidate.debug;
  const crossLead = clamp((debug.crossPattern - debug.yPattern * 0.84 + 0.18) / 0.36, 0, 1);
  const grooveLead = clamp((debug.grooveCross - debug.grooveY * 0.82 + 0.18) / 0.38, 0, 1);
  const peakScore = debug.peaks === 4 ? 1 : debug.peaks === 5 ? 0.68 : debug.peaks === 3 ? 0.14 : 0.28;
  const paleScore = debug.paleGroups === 4 ? 1 : debug.paleGroups === 5 ? 0.62 : debug.paleGroups === 3 ? 0.22 : 0.34;
  const darkScore = debug.darkGroups === 4 ? 1 : debug.darkGroups === 5 ? 0.58 : debug.darkGroups === 3 ? 0.18 : 0.28;
  const centerScore = centerDotScore(data, width, height, candidate.x, candidate.y, candidate.radius);
  const hubScore = cloverHubScore(data, mask, width, height, candidate.x, candidate.y, candidate.radius);
  const sourceScore = firstPass.source === "center-cross" ? 1 : firstPass.source === "junction" ? 0.78 : firstPass.source === "pale-pattern" ? 0.5 : 0.36;
  const raw = crossLead * 0.18 +
    grooveLead * 0.19 +
    peakScore * 0.14 +
    paleScore * 0.08 +
    darkScore * 0.06 +
    debug.localGreen * 0.08 +
    (1 - debug.voidPenalty) * 0.08 +
    hubScore * 0.14 +
    centerScore * 0.03 +
    sourceScore * 0.02 +
    clamp(firstPass.score / 100, 0, 1) * 0.02;
  return Math.round(clamp(raw * 100, 0, 96));
}

function cloverHubScore(data, mask, width, height, x, y, radius) {
  const center = sampleAt(data, mask, width, height, x, y);
  const localGreen = localGreenRing(mask, width, height, x, y, Math.max(3, Math.round(radius * 0.18)));
  const innerVoid = darkVoidPenalty(data, mask, width, height, x, y, radius * 0.72);
  const centerLum = averageDiskLuminance(data, width, x, y, Math.max(2, Math.round(radius * 0.1)));
  const ringLum = averageRingLuminance(data, width, x, y, Math.max(4, Math.round(radius * 0.48)), 20);
  const contrast = clamp((ringLum - centerLum + 18) / 68, 0, 1);
  const paleConvergence = paleRingScore(data, mask, width, height, x, y, radius);
  const softGreenHub = clamp(center.greenScore * 0.64 + localGreen * 0.36, 0, 1);
  return clamp(softGreenHub * 0.32 + contrast * 0.2 + paleConvergence * 0.3 + (1 - innerVoid) * 0.18, 0, 1);
}

function paleRingScore(data, mask, width, height, x, y, radius) {
  const samples = 32;
  const radii = [0.34, 0.5, 0.68, 0.86];
  const values = [];

  for (let i = 0; i < samples; i += 1) {
    const angle = (i / samples) * TWO_PI;
    let best = 0;
    for (const ratio of radii) {
      const sample = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius * ratio, y + Math.sin(angle) * radius * ratio);
      best = Math.max(best, sample.paleScore);
    }
    values.push(best);
  }

  const groups = countPeakGroups(values);
  const groupScore = groups === 4 ? 1 : groups === 5 ? 0.72 : groups === 3 ? 0.38 : 0.2;
  return clamp(average(values) * 0.44 + groupScore * 0.56, 0, 1);
}

function centerDotScore(data, width, height, x, y, radius) {
  const sampleRadius = Math.max(2, Math.round(radius * 0.12));
  let redBrown = 0;
  let dark = 0;
  let count = 0;

  for (let dy = -sampleRadius; dy <= sampleRadius; dy += 1) {
    for (let dx = -sampleRadius; dx <= sampleRadius; dx += 1) {
      if (dx * dx + dy * dy > sampleRadius * sampleRadius) continue;
      const sx = clamp(Math.round(x + dx), 0, width - 1);
      const sy = clamp(Math.round(y + dy), 0, height - 1);
      const pixel = (sy * width + sx) * 4;
      const r = data[pixel];
      const g = data[pixel + 1];
      const b = data[pixel + 2];
      const luminance = getLuminance(data, pixel);
      redBrown += clamp((r - Math.max(g * 0.72, b * 0.96) + 20) / 86, 0, 1) * clamp((145 - luminance) / 95, 0, 1);
      dark += clamp((92 - luminance) / 70, 0, 1);
      count += 1;
    }
  }

  return Math.max(redBrown / Math.max(1, count), dark / Math.max(1, count) * 0.8);
}

function findCenterDotBlobs(data, mask, width, height) {
  const dotMask = new Uint8Array(mask.length);
  const ringRadius = Math.max(5, Math.round(Math.min(width, height) * 0.024));

  for (let y = ringRadius; y < height - ringRadius; y += 1) {
    for (let x = ringRadius; x < width - ringRadius; x += 1) {
      const index = y * width + x;
      const pixel = index * 4;
      const r = data[pixel];
      const g = data[pixel + 1];
      const b = data[pixel + 2];
      const luminance = getLuminance(data, pixel);
      const redBrown = luminance > 38 && luminance < 138 && r > g * 0.7 && r > b * 0.98 && g < 150;
      const tinyDarkCenter = luminance < 78 && localGreenRing(mask, width, height, x, y, 3) >= 0.28;
      if ((!redBrown && !tinyDarkCenter) || localGreenRing(mask, width, height, x, y, ringRadius) < 0.46) continue;
      dotMask[index] = 1;
    }
  }

  const visited = new Uint8Array(dotMask.length);
  const dots = [];
  for (let start = 0; start < dotMask.length; start += 1) {
    if (!dotMask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let redness = 0;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = (index / width) | 0;
      const pixel = index * 4;
      const r = data[pixel];
      const g = data[pixel + 1];
      const b = data[pixel + 2];
      area += 1;
      sumX += x;
      sumY += y;
      redness += clamp((r - Math.max(g * 0.7, b * 0.95) + 18) / 80, 0, 1);

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= dotMask.length || visited[next] || !dotMask[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (area < 1 || area > 34) continue;
    dots.push({
      x: sumX / area,
      y: sumY / area,
      radius: Math.sqrt(area / Math.PI),
      redness: redness / area
    });
  }

  return dots
    .sort((a, b) => b.redness - a.redness)
    .slice(0, 140);
}

function findDarkJunctionBlobs(data, mask, width, height) {
  const junctionMask = new Uint8Array(mask.length);
  const radius = 5;
  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      const index = y * width + x;
      const pixel = index * 4;
      const r = data[pixel];
      const g = data[pixel + 1];
      const b = data[pixel + 2];
      const luminance = getLuminance(data, pixel);
      const reddishCenter = r > g * 0.85 && r > b * 0.9;
      if (luminance > 102 || (!reddishCenter && luminance > 86)) continue;

      let greenAround = 0;
      let innerGreen = 0;
      let samples = 0;
      for (let angleIndex = 0; angleIndex < 12; angleIndex += 1) {
        const angle = (angleIndex / 12) * TWO_PI;
        const sx = Math.round(x + Math.cos(angle) * radius);
        const sy = Math.round(y + Math.sin(angle) * radius);
        const ix = Math.round(x + Math.cos(angle) * 3);
        const iy = Math.round(y + Math.sin(angle) * 3);
        greenAround += mask[sy * width + sx] || 0;
        innerGreen += mask[iy * width + ix] || 0;
        samples += 1;
      }
      if (greenAround / samples >= 0.42 && innerGreen / samples >= 0.22) junctionMask[index] = 1;
    }
  }

  const visited = new Uint8Array(junctionMask.length);
  const junctions = [];
  for (let start = 0; start < junctionMask.length; start += 1) {
    if (!junctionMask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let darkness = 0;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = (index / width) | 0;
      area += 1;
      sumX += x;
      sumY += y;
      darkness += 1 - getLuminance(data, index * 4) / 255;

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= junctionMask.length || visited[next] || !junctionMask[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (area < 2 || area > 54) continue;
    junctions.push({
      x: sumX / area,
      y: sumY / area,
      radius: Math.sqrt(area / Math.PI),
      strength: darkness / area
    });
  }

  return junctions
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 120);
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

  for (let i = 0; i < sectors; i += 1) {
    const angle = (i / sectors) * TWO_PI;
    const outer = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    const mid = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius * 0.58, y + Math.sin(angle) * radius * 0.58);
    ringValues.push(outer.greenScore * 0.55 + mid.greenScore * 0.45);
    paleValues.push(Math.max(outer.paleScore, mid.paleScore));
    darkValues.push(clamp((105 - mid.luminance) / 85, 0, 1) * (outer.isGreen ? 1 : 0.55));
    if (outer.isGreen || mid.isGreen) greenCoverage += 1;
  }

  const peaks = countPeakGroups(ringValues);
  const paleGroups = countPeakGroups(paleValues);
  const darkGroups = countPeakGroups(darkValues);
  const centerDarkness = centerDarknessScore(data, width, x, y, radius);
  const voidPenalty = darkVoidPenalty(data, mask, width, height, x, y, radius);
  const localGreen = localGreenRing(mask, width, height, x, y, Math.max(3, Math.round(radius * 0.28)));
  const coverageScore = clamp(greenCoverage / sectors, 0, 1);
  const squarePattern = scoreSquarePattern(data, mask, width, height, x, y, radius);
  const crossPattern = scoreCrossPattern(data, mask, width, height, x, y, radius);
  const yPattern = scoreYPattern(data, mask, width, height, x, y, radius);
  const grooveCross = scoreGrooveCrossPattern(data, width, height, x, y, radius);
  const grooveY = scoreGrooveYPattern(data, width, height, x, y, radius);
  const trianglePenalty = peaks === 3 && paleGroups === 3 ? 0.18 : 0;
  const peakScore = peaks === 4 ? 1 : peaks === 5 ? 0.74 : peaks === 3 ? 0.44 : peaks === 2 || peaks === 6 ? 0.28 : 0.1;
  const darkGroupScore = darkGroups === 4 ? 1 : darkGroups === 5 ? 0.64 : darkGroups === 3 ? 0.42 : darkGroups === 2 || darkGroups === 6 ? 0.22 : 0.06;
  const paleScore = paleGroups === 4 ? 1 : paleGroups === 5 ? 0.72 : paleGroups === 3 ? 0.5 : paleGroups === 2 ? 0.36 : 0.14;
  const rawScore = grooveCross * 0.48 + crossPattern * 0.18 + squarePattern * 0.1 + darkGroupScore * 0.07 + peakScore * 0.04 + centerDarkness * 0.05 + coverageScore * 0.04 + localGreen * 0.04 + paleScore * 0.02 - grooveY * 0.1 - yPattern * 0.04 - trianglePenalty * 0.45 - voidPenalty * 0.26;
  const score = Math.round(clamp(rawScore * 100, 0, 96));

  return {
    x,
    y,
    radius: radius * 1.45,
    score,
    source: "pattern-break",
    debug: { peaks, paleGroups, darkGroups, squarePattern, crossPattern, yPattern, grooveCross, grooveY, centerDarkness, coverageScore, localGreen, voidPenalty },
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

function scoreSquarePattern(data, mask, width, height, x, y, radius) {
  let best = 0;
  const offsets = [0, Math.PI / 8, Math.PI / 4, Math.PI * 3 / 8];
  for (const offset of offsets) {
    const square = [0, 1, 2, 3].map((i) => {
      const angle = offset + i * (TWO_PI / 4);
      const outer = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius * 0.88, y + Math.sin(angle) * radius * 0.88);
      const mid = sampleAt(data, mask, width, height, x + Math.cos(angle) * radius * 0.52, y + Math.sin(angle) * radius * 0.52);
      return Math.max(outer.paleScore, mid.paleScore) * 0.6 + Math.max(outer.greenScore, mid.greenScore) * 0.4;
    });
    const diagonals = [0, 1, 2, 3].map((i) => {
      const angle = offset + Math.PI / 4 + i * (TWO_PI / 4);
      return sampleAt(data, mask, width, height, x + Math.cos(angle) * radius * 0.7, y + Math.sin(angle) * radius * 0.7).greenScore;
    });
    const squareScore = average(square) * (1 - clamp(stddev(square) / Math.max(0.1, average(square)), 0, 1));
    const separationScore = clamp((average(square) - average(diagonals) * 0.35 + 0.18), 0, 1);
    best = Math.max(best, squareScore * 0.65 + separationScore * 0.35);
  }
  return best;
}

function scoreCrossPattern(data, mask, width, height, x, y, radius) {
  let best = 0;
  for (let offsetIndex = 0; offsetIndex < 16; offsetIndex += 1) {
    const offset = (offsetIndex / 16) * (Math.PI / 2);
    const arms = [0, 1, 2, 3].map((i) => rayLeafStrength(data, mask, width, height, x, y, offset + i * (TWO_PI / 4), radius));
    const gaps = [0, 1, 2, 3].map((i) => rayLeafStrength(data, mask, width, height, x, y, offset + Math.PI / 4 + i * (TWO_PI / 4), radius));
    const armAverage = average(arms);
    const weakestArm = Math.min(...arms);
    const balance = 1 - clamp(stddev(arms) / Math.max(0.08, armAverage), 0, 1);
    const gapSeparation = clamp(armAverage - average(gaps) * 0.56 + 0.12, 0, 1);
    const score = weakestArm * 0.34 + armAverage * 0.22 + balance * 0.24 + gapSeparation * 0.2;
    best = Math.max(best, score);
  }
  return clamp(best, 0, 1);
}

function scoreYPattern(data, mask, width, height, x, y, radius) {
  let best = 0;
  for (let offsetIndex = 0; offsetIndex < 24; offsetIndex += 1) {
    const offset = (offsetIndex / 24) * (TWO_PI / 3);
    const arms = [0, 1, 2].map((i) => rayLeafStrength(data, mask, width, height, x, y, offset + i * (TWO_PI / 3), radius));
    const armAverage = average(arms);
    const balance = 1 - clamp(stddev(arms) / Math.max(0.08, armAverage), 0, 1);
    const score = Math.min(...arms) * 0.38 + armAverage * 0.28 + balance * 0.34;
    best = Math.max(best, score);
  }
  return clamp(best, 0, 1);
}

function scoreGrooveCrossPattern(data, width, height, x, y, radius) {
  let best = 0;
  for (let offsetIndex = 0; offsetIndex < 16; offsetIndex += 1) {
    const offset = (offsetIndex / 16) * (Math.PI / 2);
    const grooves = [0, 1, 2, 3].map((i) => rayGrooveStrength(data, width, height, x, y, offset + i * (TWO_PI / 4), radius));
    const diagonals = [0, 1, 2, 3].map((i) => rayGrooveStrength(data, width, height, x, y, offset + Math.PI / 4 + i * (TWO_PI / 4), radius));
    const grooveAverage = average(grooves);
    const weakestGroove = Math.min(...grooves);
    const balance = 1 - clamp(stddev(grooves) / Math.max(0.08, grooveAverage), 0, 1);
    const separation = clamp(grooveAverage - average(diagonals) * 0.55 + 0.18, 0, 1);
    best = Math.max(best, weakestGroove * 0.38 + grooveAverage * 0.2 + balance * 0.22 + separation * 0.2);
  }
  return clamp(best, 0, 1);
}

function scoreGrooveYPattern(data, width, height, x, y, radius) {
  let best = 0;
  for (let offsetIndex = 0; offsetIndex < 24; offsetIndex += 1) {
    const offset = (offsetIndex / 24) * (TWO_PI / 3);
    const grooves = [0, 1, 2].map((i) => rayGrooveStrength(data, width, height, x, y, offset + i * (TWO_PI / 3), radius));
    const grooveAverage = average(grooves);
    const balance = 1 - clamp(stddev(grooves) / Math.max(0.08, grooveAverage), 0, 1);
    best = Math.max(best, Math.min(...grooves) * 0.42 + grooveAverage * 0.24 + balance * 0.34);
  }
  return clamp(best, 0, 1);
}

function rayGrooveStrength(data, width, height, x, y, angle, radius) {
  const distances = [0.12, 0.18, 0.26, 0.36, 0.48, 0.62];
  let dark = 0;
  let count = 0;
  for (const distanceRatio of distances) {
    const distanceValue = radius * distanceRatio;
    const center = darkSample(data, width, height, x + Math.cos(angle) * distanceValue, y + Math.sin(angle) * distanceValue);
    const left = darkSample(data, width, height, x + Math.cos(angle + 0.1) * distanceValue, y + Math.sin(angle + 0.1) * distanceValue);
    const right = darkSample(data, width, height, x + Math.cos(angle - 0.1) * distanceValue, y + Math.sin(angle - 0.1) * distanceValue);
    dark += Math.max(center, left, right);
    count += 1;
  }
  return clamp(dark / count, 0, 1);
}

function darkSample(data, width, height, fx, fy) {
  const x = clamp(Math.round(fx), 0, width - 1);
  const y = clamp(Math.round(fy), 0, height - 1);
  const pixel = (y * width + x) * 4;
  const r = data[pixel];
  const g = data[pixel + 1];
  const b = data[pixel + 2];
  const luminance = getLuminance(data, pixel);
  const reddish = r > g * 0.82 && r > b * 0.9 ? 0.16 : 0;
  return clamp((118 - luminance) / 82 + reddish, 0, 1);
}

function rayLeafStrength(data, mask, width, height, x, y, angle, radius) {
  const distances = [0.34, 0.5, 0.68, 0.88, 1.08, 1.28];
  let green = 0;
  let pale = 0;
  let count = 0;
  for (const distanceRatio of distances) {
    const distanceValue = radius * distanceRatio;
    const center = sampleAt(data, mask, width, height, x + Math.cos(angle) * distanceValue, y + Math.sin(angle) * distanceValue);
    const left = sampleAt(data, mask, width, height, x + Math.cos(angle + 0.13) * distanceValue, y + Math.sin(angle + 0.13) * distanceValue);
    const right = sampleAt(data, mask, width, height, x + Math.cos(angle - 0.13) * distanceValue, y + Math.sin(angle - 0.13) * distanceValue);
    const samples = [center, left, right];
    green += average(samples.map((sample) => sample.greenScore));
    pale += Math.max(...samples.map((sample) => sample.paleScore));
    count += 1;
  }
  return clamp((green / count) * 0.76 + (pale / count) * 0.24, 0, 1);
}

function centerDarknessScore(data, width, x, y, radius) {
  const center = averageDiskLuminance(data, width, x, y, Math.max(2, Math.round(radius * 0.12)));
  const ring = averageRingLuminance(data, width, x, y, Math.round(radius * 0.42), 16);
  return clamp((ring - center + 22) / 92, 0, 1);
}

function darkVoidPenalty(data, mask, width, height, x, y, radius) {
  const innerRadius = Math.max(3, Math.round(radius * 0.26));
  let dark = 0;
  let notGreen = 0;
  let count = 0;

  for (let dy = -innerRadius; dy <= innerRadius; dy += 1) {
    for (let dx = -innerRadius; dx <= innerRadius; dx += 1) {
      if (dx * dx + dy * dy > innerRadius * innerRadius) continue;
      const sx = clamp(Math.round(x + dx), 0, width - 1);
      const sy = clamp(Math.round(y + dy), 0, height - 1);
      const index = sy * width + sx;
      const luminance = getLuminance(data, index * 4);
      if (luminance < 58) dark += 1;
      if (!mask[index]) notGreen += 1;
      count += 1;
    }
  }

  return clamp((dark / Math.max(1, count)) * 0.55 + (notGreen / Math.max(1, count)) * 0.45, 0, 1);
}

function localGreenRing(mask, width, height, x, y, radius) {
  let green = 0;
  const samples = 16;
  for (let i = 0; i < samples; i += 1) {
    const angle = (i / samples) * TWO_PI;
    const sx = clamp(Math.round(x + Math.cos(angle) * radius), 0, width - 1);
    const sy = clamp(Math.round(y + Math.sin(angle) * radius), 0, height - 1);
    green += mask[sy * width + sx] || 0;
  }
  return green / samples;
}

function averageDiskLuminance(data, width, x, y, radius) {
  let sum = 0;
  let count = 0;
  const height = data.length / 4 / width;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const sx = clamp(Math.round(x + dx), 0, width - 1);
      const sy = clamp(Math.round(y + dy), 0, height - 1);
      const pixel = (sy * width + sx) * 4;
      sum += getLuminance(data, pixel);
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

function averageRingLuminance(data, width, x, y, radius, samples) {
  let sum = 0;
  const height = data.length / 4 / width;
  for (let i = 0; i < samples; i += 1) {
    const angle = (i / samples) * TWO_PI;
    const sx = clamp(Math.round(x + Math.cos(angle) * radius), 0, width - 1);
    const sy = clamp(Math.round(y + Math.sin(angle) * radius), 0, height - 1);
    const pixel = (sy * width + sx) * 4;
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
  return nonMaximumSuppression(candidates.sort((a, b) => rankScore(b) - rankScore(a)));
}

function rankScore(candidate) {
  const sourceBoosts = {
    "center-cross": 42,
    junction: 38,
    "pale-pattern": 4,
    "pattern-break": -20,
    "leaf-group": -8
  };
  return candidate.score + (sourceBoosts[candidate.source] || 0);
}

function boostFocusedCandidates(candidates, focusPoint) {
  if (!focusPoint) return candidates;
  return candidates
    .map((candidate) => {
      const d = distance(candidate, focusPoint);
      const near = clamp(1 - d / Math.max(1, focusPoint.radius), 0, 1);
      return {
        ...candidate,
        score: Math.round(clamp(candidate.score + near * 14, 0, 99)),
        focusBoost: Math.round(near * 14)
      };
    })
    .sort((a, b) => b.score - a.score);
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

function nonMaximumSuppression(candidates, radiusScale = 0.95) {
  const picked = [];
  for (const candidate of candidates) {
    const tooClose = picked.some((existing) => distance(candidate, existing) < Math.max(candidate.radius, existing.radius) * radiusScale);
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
  return clamp(margin / Math.min(width, height) * 3, 0.42, 1);
}
