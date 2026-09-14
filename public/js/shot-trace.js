// Identical hitscan volumes for immediate feedback and authoritative damage.
export function traceShot(origin, direction, range, targets, obstacleDistance) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < .00001) return { hit: false, dist: 0 };
  const d = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
  let best = { hit: false, dist: Math.min(range, obstacleDistance(origin, d, range)) };
  for (const target of targets) {
    if (!target.alive) continue;
    for (const [height, radius, part] of [[1.05, .42, 'body'], [1.63, .20, 'head']]) {
      const x = origin.x - target.x, y = origin.y - (target.y || 0) - height, z = origin.z - target.z;
      const b = x * d.x + y * d.y + z * d.z;
      const disc = b * b - x * x - y * y - z * z + radius * radius;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > .2 && t < best.dist) best = { hit: true, dist: t, part, targetId: target.id };
    }
  }
  return best;
}

// Server-owned pose history; client timestamps can only rewind within this bounded window.
export class TargetHistory {
  constructor(maxAge = 1500) { this.maxAge = maxAge; this.frames = []; }
  record(time, targets) {
    this.frames.push({ time, targets: targets.map(t => ({ id: t.id, x: t.x, y: t.y || 0, z: t.z, alive: t.alive })) });
    while (this.frames.length > 2 && this.frames[1].time < time - this.maxAge) this.frames.shift();
  }
  sample(time, now, current) {
    if (!Number.isFinite(time) || !this.frames.length) return current;
    const t = Math.max(now - this.maxAge, Math.min(now, time));
    const frames = this.frames;
    let a = frames[0], b = frames.at(-1);
    if (t <= a.time) b = a;
    else if (t >= b.time) a = b;
    else for (let i = 1; i < frames.length; i++) if (frames[i].time >= t) {
      a = frames[i - 1]; b = frames[i]; break;
    }
    const k = a === b ? 0 : (t - a.time) / (b.time - a.time);
    return current.map(target => {
      const from = a.targets.find(p => p.id === target.id), to = b.targets.find(p => p.id === target.id);
      if (!from || !to) return target;
      return { ...target, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k,
        z: from.z + (to.z - from.z) * k, alive: target.alive && from.alive && to.alive };
    });
  }
}
