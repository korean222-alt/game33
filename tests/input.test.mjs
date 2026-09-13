import test from 'node:test';
import assert from 'node:assert/strict';

class Element extends EventTarget {
  style = {};
  classes = new Set();
  classList = { add: v => this.classes.add(v), remove: v => this.classes.delete(v), toggle: (v, yes) => yes ? this.classes.add(v) : this.classes.delete(v) };
  getBoundingClientRect() { return { left: 0, top: 0, width: 96, height: 96 }; }
}
globalThis.window = new EventTarget();
globalThis.matchMedia = () => ({ matches: false });
const elements = new Map(['stick', 'knob', 'bFire', 'bAds', 'bSpr', 'bCrch', 'bUse', 'bJump', 'bRel'].map(id => [id, new Element()]));
globalThis.document = new EventTarget();
document.getElementById = id => elements.get(id);
const { Input } = await import('../public/js/input.js');

test('touch toggles reset internally and visually between matches', () => {
  const input = new Input(new Element(), {}); input.enable();
  const ads = elements.get('bAds');
  ads.dispatchEvent(new Event('touchstart', { cancelable: true }));
  assert.equal(input.ads, true);
  input.disable();
  assert.equal(input.ads, false); assert.equal(ads.classes.has('on'), false);
  input.enable();
  ads.dispatchEvent(new Event('touchstart', { cancelable: true }));
  assert.equal(input.ads, true);
  input.fire = true; input.look.dx = 12; input._stickTouchId = 7;
  window.dispatchEvent(new Event('blur'));
  assert.equal(input.fire, false); assert.equal(input.look.dx, 0); assert.equal(input._stickTouchId, null);
  input.dispose(); input.enable(); ads.dispatchEvent(new Event('touchstart'));
  assert.equal(input.ads, false);
});
