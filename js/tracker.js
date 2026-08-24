export class CandidateTracker {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
  }

  update(candidates) {
    const now = performance.now();
    const unmatched = new Set(this.tracks);
    const output = [];

    for (const candidate of candidates) {
      const match = this.findMatch(candidate, unmatched);
      if (match) {
        unmatched.delete(match);
        match.x = match.x * 0.58 + candidate.x * 0.42;
        match.y = match.y * 0.58 + candidate.y * 0.42;
        match.radius = match.radius * 0.65 + candidate.radius * 0.35;
        match.score = Math.round(match.score * 0.55 + candidate.score * 0.45);
        match.leaves = candidate.leaves;
        match.hits += 1;
        match.misses = 0;
        match.updatedAt = now;
        output.push(match);
      } else {
        const track = {
          ...candidate,
          id: this.nextId,
          hits: 1,
          misses: 0,
          updatedAt: now
        };
        this.nextId += 1;
        this.tracks.push(track);
        output.push(track);
      }
    }

    for (const track of unmatched) {
      track.misses += 1;
    }

    this.tracks = this.tracks.filter((track) => track.misses <= 6);
    return output.filter((track) => track.hits >= 2 && track.misses === 0);
  }

  findMatch(candidate, tracks) {
    let best = null;
    let bestDistance = Infinity;
    for (const track of tracks) {
      const distance = Math.hypot(candidate.x - track.x, candidate.y - track.y);
      const gate = Math.max(36, Math.max(candidate.radius, track.radius) * 1.4);
      if (distance < gate && distance < bestDistance) {
        best = track;
        bestDistance = distance;
      }
    }
    return best;
  }

  reset() {
    this.tracks = [];
  }
}
