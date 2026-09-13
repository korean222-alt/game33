/* =============================================================================
 *  hud.js  -  화면(메뉴/로비/결과) 전환과 HUD 갱신
 *
 *  게임 로직에서 DOM 을 직접 만지지 않도록 여기로 모아둔다.
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), touch: $('touch'),
      timer: $('timer'), siteList: $('siteList'),
      hpFill: $('hpFill'), hpName: $('hpName'),
      ammoBox: $('ammoBox'), ammoNow: $('ammoNow'), ammoRes: $('ammoRes'), wpName: $('wpName'),
      banner: $('banner'), dmg: $('dmg'), dead: $('dead'),
      defuse: $('defuse'), defuseTxt: $('defuseTxt'), defuseFill: $('defuseFill'),
      crosshair: $('crosshair'), killfeed: $('killfeed'), fps: $('fps'),
      bUse: $('bUse'),
    };
    this.sites = new Map();
    this._bannerTimer = null;
    this._hitTimer = null;
  }

  /* ---- 화면 전환 -------------------------------------------------------- */
  show(name) {
    for (const id of ['menu', 'lobby', 'loading', 'result']) {
      $(id).classList.toggle('hidden', id !== name);
    }
    const inGame = name === null;
    this.el.hud.classList.toggle('hidden', !inGame);
  }

  showTouch(on) { this.el.touch.classList.toggle('hidden', !on); this.el.touch.classList.toggle('on', on); }

  /* ---- 매치 시작 시 목표 목록 만들기 ------------------------------------ */
  buildSites(sites) {
    this.el.siteList.innerHTML = '';
    this.sites.clear();
    for (const s of sites) {
      const box = document.createElement('div');
      box.className = 'site';
      box.innerHTML =
        `<div class="t"><span>${escapeHtml(s.label)}</span><span class="pct">0%</span></div>` +
        `<div class="pb"><div class="pf"></div></div>`;
      this.el.siteList.appendChild(box);
      this.sites.set(s.id, { box, fill: box.querySelector('.pf'), pct: box.querySelector('.pct') });
    }
  }

  setSiteProgress(id, p) {
    const s = this.sites.get(id);
    if (!s || s.box.classList.contains('done')) return;
    s.fill.style.width = `${Math.round(p * 100)}%`;
    s.pct.textContent = `${Math.round(p * 100)}%`;
  }

  setSiteDefused(id) {
    const s = this.sites.get(id);
    if (!s) return;
    s.box.classList.add('done');
    s.fill.style.width = '100%';
    s.pct.textContent = '해체';
  }

  /* ---- 상태 표시 -------------------------------------------------------- */
  setTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    this.el.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.el.timer.classList.toggle('low', total <= 30);
  }

  setHp(hp) {
    const k = Math.max(0, Math.min(100, hp));
    this.el.hpFill.style.width = `${k}%`;
    this.el.hpFill.className = 'fill' + (k <= 25 ? ' low' : k <= 55 ? ' mid' : '');
    this.el.hpName.textContent = `체력 ${Math.round(k)}`;
  }

  setAmmo(now, reserve, reloading, weaponName) {
    this.el.ammoNow.textContent = now;
    this.el.ammoRes.textContent = ` / ${reserve}`;
    this.el.ammoBox.classList.toggle('reloading', !!reloading);
    if (weaponName) this.el.wpName.textContent = reloading ? '재장전…' : weaponName;
  }

  setDead(on) { this.el.dead.classList.toggle('hidden', !on); }

  /** 피격 시 화면 붉게 */
  flashDamage() {
    this.el.dmg.style.opacity = '1';
    setTimeout(() => { this.el.dmg.style.opacity = '0'; }, 90);
  }

  /** 명중 시 조준점 붉게 (히트마커) */
  flashHit() {
    this.el.crosshair.classList.add('hit');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => this.el.crosshair.classList.remove('hit'), 110);
  }

  banner(text, ms = 1600) {
    this.el.banner.textContent = text;
    this.el.banner.style.opacity = '1';
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => { this.el.banner.style.opacity = '0'; }, ms);
  }

  killfeed(text) {
    const d = document.createElement('div');
    d.textContent = text;
    this.el.killfeed.appendChild(d);
    setTimeout(() => d.remove(), 4200);
  }

  /** 해체 진행 바 (근처에 있을 때만) */
  setDefuse(visible, label = '', progress = 0) {
    this.el.defuse.classList.toggle('hidden', !visible);
    this.el.bUse?.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.el.defuseTxt.textContent = label;
    this.el.defuseFill.style.width = `${Math.round(progress * 100)}%`;
  }

  setFps(v, show) {
    this.el.fps.classList.toggle('hidden', !show);
    if (show) this.el.fps.textContent = `${v} fps`;
  }

  /* ---- 결과 화면 -------------------------------------------------------- */
  showResult(data, myId) {
    const won = data.result === 'won';
    $('resTitle').textContent = won ? '작전 성공' : '작전 실패';
    $('resTitle').className = 'big ' + (won ? 'won' : 'lost');
    $('resWhy').textContent = data.reason || '';

    const ul = $('resStats');
    ul.innerHTML = '';
    for (const s of data.stats) {
      const li = document.createElement('li');
      const me = s.id === myId ? ' (나)' : '';
      li.innerHTML =
        `<span>${escapeHtml(s.name)}${me}${s.alive ? '' : ' · 전사'}</span>` +
        `<span class="k">${s.kills} 킬</span>`;
      ul.appendChild(li);
    }
    this.show('result');
  }

  /** 매치 종료/재시작 시 HUD 초기화 */
  resetForNewMatch() {
    this.setDead(false);
    this.setDefuse(false);
    this.el.killfeed.innerHTML = '';
    this.el.banner.style.opacity = '0';
    this.el.dmg.style.opacity = '0';
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
