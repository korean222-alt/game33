// Keep delayed acknowledgements from restoring ammunition already fired locally.
export class ShotState {
  constructor() { this.reset(); }
  reset() { this.nextId = 0; this.ackId = 0; this.pending = []; this.serverAmmo = 0; }
  fire(prediction = null) {
    const id = ++this.nextId;
    this.pending.push({ id, prediction });
    return id;
  }
  acknowledge(id, ammo) {
    if (!Number.isFinite(ammo) || !Number.isSafeInteger(id) || id < this.ackId || id > this.nextId) return false;
    this.ackId = id;
    this.pending = this.pending.filter(shot => shot.id > id);
    this.serverAmmo = Math.max(0, ammo);
    return true;
  }
  expire(id) { this.pending = this.pending.filter(shot => shot.id !== id); }
  get ammo() { return Math.max(0, this.serverAmmo - this.pending.length); }
}
