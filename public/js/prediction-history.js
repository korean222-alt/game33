// Match authoritative positions to the input that produced them, not to today's prediction.
export class PredictionHistory {
  constructor(limit = 256) { this.limit = limit; this.reset(); }

  reset() { this.nextSeq = 0; this.lastAck = 0; this.pending = []; }

  record(position) {
    const state = { seq: ++this.nextSeq };
    for (const axis of ['x', 'y', 'z']) state[axis] = +position[axis].toFixed(3);
    this.pending.push({ ...state });
    if (this.pending.length > this.limit) this.pending.shift();
    return state;
  }

  acknowledge(seq, position) {
    if (!Number.isSafeInteger(seq) || seq <= this.lastAck || seq > this.nextSeq ||
        !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))) return null;
    const sent = this.pending.find(state => state.seq === seq);
    this.lastAck = seq;
    this.pending = this.pending.filter(state => state.seq > seq);
    // An expired/missing input gives us no reliable baseline. Never snap to its old position.
    if (!sent) return null;
    const delta = {};
    for (const axis of ['x', 'y', 'z']) {
      const error = position[axis] - sent[axis];
      delta[axis] = Math.abs(error) > .002 ? error : 0;
      // Later predictions already inherit this correction; do not apply it twice.
      for (const state of this.pending) state[axis] += delta[axis];
    }
    return delta;
  }
}
