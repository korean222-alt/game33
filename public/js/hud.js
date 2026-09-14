/* =============================================================================
 *  hud.js  -  화면(메뉴/로비/브리핑/결과) 전환과 HUD 갱신
 *
 *  게임 로직에서 DOM 을 직접 만지지 않도록 여기로 모아둔다.
 * ========================================================================== */

import { MISSION } from './mission-story.js';

const $ = (id) => document.getElementById(id);

const DOOR_LABEL = {
  open: '열림', closed: '닫힘', locked: '잠김', barricaded: '바리케이드', destroyed: '파괴됨',
};
const PEEK_LABEL = { none: '인원 없음', one: '인원 1명 이상', several: '인원 여러 명' };
const DOOR_ACTION_LABEL = { open: '열기', close: '닫기', unlock: '해정' };

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), touch: $('touch'),
      timer: $('timer'), siteList: $('siteList'),
      hpFill: $('hpFill'), hpName: $('hpName'),
      ammoBox: $('ammoBox'), ammoNow: $('ammoNow'), ammoRes: $('ammoRes'), wpName: $('wpName'),
      banner: $('banner'), dmg: $('dmg'), dead: $('dead'), deadText: $('deadText'),
      defuse: $('defuse'), defuseTxt: $('defuseTxt'), defuseFill: $('defuseFill'),
      crosshair: $('crosshair'), killfeed: $('killfeed'), fps: $('fps'),
      bUse: $('bUse'), bDoor: $('bDoor'), bKick: $('bKick'), bPeek: $('bPeek'),
      phaseName: $('phaseName'), phaseTitle: $('phaseTitle'), objectives: $('objectives'),
      door: $('door'), doorTxt: $('doorTxt'), doorActions: $('doorActions'),
      nade: $('nade'), nadeName: $('nadeName'), nadeCount: $('nadeCount'),
      flash: $('flash'), gas: $('gas'), threat: $('threat'),
    };
    this.sites = new Map();
    this._bannerTimer = null;
    this._hitTimer = null;
    this._radioTimer = null;
    this._threatMarks = [];
  }

  /**
   * 위협 방향 표시.
   * 밤 작전이라 사수를 못 보고 맞는 일이 잦다. 어느 쪽인지 모르면 대응할
   * 방법이 없으므로, 맞았을 때와 발각됐을 때 화면 가장자리에 쐐기를 띄운다.
   *
   * @param angle  라디안. 0 = 정면, +는 오른쪽
   * @param kind   'hit' 이면 붉게, 'spot' 이면 노랗게
   */
  threat(angle, kind = 'hit', ms = 1500) {
    const host = this.el.threat;
    if (!host || !Number.isFinite(angle)) return;
    const mark = document.createElement('div');
    mark.className = kind === 'spot' ? 'mark spot' : 'mark';
    mark.style.transform = `rotate(${(angle * 180 / Math.PI).toFixed(1)}deg)`;
    host.appendChild(mark);
    // 붙이자마자 클래스를 바꾸면 transition 이 생략된다. 다음 프레임에 켠다.
    requestAnimationFrame(() => mark.classList.add('on'));
    const entry = { mark, timer: null };
    this._threatMarks.push(entry);
    entry.timer = setTimeout(() => {
      mark.classList.remove('on');
      entry.timer = setTimeout(() => {
        mark.remove();
        this._threatMarks = this._threatMarks.filter((e) => e !== entry);
      }, 320);
    }, ms);
  }

  clearThreats() {
    for (const entry of this._threatMarks) { clearTimeout(entry.timer); entry.mark.remove(); }
    this._threatMarks = [];
  }

  /* ---- 화면 전환 -------------------------------------------------------- */
  show(name) {
    for (const id of ['menu', 'lobby', 'loading', 'briefing', 'result']) {
      $(id).classList.toggle('hidden', id !== name);
    }
    const inGame = name === null;
    if (!inGame) this.setAim(0, '', false);
    this.el.hud.classList.toggle('hidden', !inGame);
  }

  showTouch(on) {
    this.el.touch.classList.toggle('hidden', !on);
    this.el.touch.classList.toggle('on', on);
  }

  /* ---- 매치 시작 시 목표 목록 만들기 ------------------------------------ */
  buildSites(sites) {
    this.el.siteList.innerHTML = '';
    this.sites.clear();
    for (const s of sites) {
      const box = document.createElement('div');
      box.className = 'site';
      box.innerHTML =
        `<div class="t"><span>${escapeHtml(s.label)}</span><span class="pct">0%</span></div>` +
        '<div class="pb"><div class="pf"></div></div>';
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

  /* ---- 단계와 목표 ------------------------------------------------------ */
  setObjectives(report) {
    if (!report) return;
    this.el.phaseName.textContent = report.name;
    this.el.phaseTitle.textContent = report.title;
    const list = this.el.objectives;
    list.innerHTML = '';
    for (const o of report.list) {
      const li = document.createElement('li');
      li.className = 'obj' + (o.done ? ' done' : '') + (o.failed ? ' failed' : '')
        + (o.kind === 'bonus' ? ' bonus' : '');
      const count = o.need > 1 ? ` ${o.have}/${o.need}` : '';
      li.innerHTML = `<i></i><span>${escapeHtml(o.label)}${count}</span>`;
      list.appendChild(li);
    }
  }

  /* ---- 상태 표시 -------------------------------------------------------- */
  setTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    this.el.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.el.timer.classList.toggle('low', total <= 60);
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

  setGrenade(type, counts, spec) {
    if (!spec) return;
    this.el.nadeName.textContent = spec.short || spec.label;
    this.el.nadeCount.textContent = `x${counts?.[type] ?? 0}`;
    this.el.nade.classList.toggle('empty', (counts?.[type] ?? 0) <= 0);
  }

  setDead(on, text = '전사 — 팀원을 기다리는 중') {
    this.el.dead.classList.toggle('hidden', !on);
    if (on && this.el.deadText) this.el.deadText.textContent = text;
  }

  /** 섬광탄에 노출된 정도 (0~1) */
  setFlash(amount) {
    this.el.flash.style.opacity = String(Math.max(0, Math.min(1, amount)));
  }

  /** 가스 노출 정도 (0~1) */
  setGas(amount) {
    this.el.gas.style.opacity = String(Math.max(0, Math.min(0.85, amount * 0.85)));
  }

  /** 피격 시 화면 붉게 */
  flashDamage() {
    this.el.dmg.style.opacity = '1';
    setTimeout(() => { this.el.dmg.style.opacity = '0'; }, 90);
  }

  /** 명중 시 조준점 붉게 (히트마커) */
  flashHit() {
    $('hitMarker').classList.add('active');
    this.el.crosshair.classList.add('hit');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      this.el.crosshair.classList.remove('hit');
      $('hitMarker').classList.remove('active');
    }, 110);
  }

  banner(text, ms = 1600) {
    this.el.banner.textContent = text;
    this.el.banner.style.opacity = '1';
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => { this.el.banner.style.opacity = '0'; }, ms);
  }

  radio(text) {
    if (!text) return;
    $('radioText').textContent = text;
    $('radio').classList.remove('hidden');
    clearTimeout(this._radioTimer);
    this._radioTimer = setTimeout(() => $('radio').classList.add('hidden'), 8000);
  }

  setAim(amount, weapon, alive = true) {
    this.el.crosshair.style.opacity = alive ? String(1 - amount) : '0';
    $('scope').classList.toggle('hidden', !alive || weapon !== 'sniper' || amount < .95);
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

  /** 문 앞 안내. door=null 이면 숨긴다. */
  /**
   * 문 안내.
   *
   * 터치 버튼은 "지금 할 수 있는 동작"만 띄운다. 예전에는 문 근처이기만 하면
   * 세 버튼이 전부 나타나서, 바리케이드 문 앞에서 "문" 을 눌러도 아무 일도
   * 일어나지 않았다. 눌리는 버튼은 반드시 동작해야 한다.
   *
   * @param actions.primary  'open' | 'close' | 'unlock' | null
   * @param actions.peek     문틈 확인 가능
   * @param actions.kick     강제 개방 가능
   */
  setDoor(door, extra = '', actions = {}) {
    const show = !!door;
    this.el.door.classList.toggle('hidden', !show);
    const { primary = null, peek = false, kick = false } = actions;
    this.el.bDoor?.classList.toggle('hidden', !show || !primary);
    this.el.bKick?.classList.toggle('hidden', !show || !kick);
    this.el.bPeek?.classList.toggle('hidden', !show || !peek);
    if (!show) return;
    if (primary && this.el.bDoor) this.el.bDoor.textContent = DOOR_ACTION_LABEL[primary] || '문';
    this.el.doorTxt.textContent = `문 · ${DOOR_LABEL[door.state] || door.state}`;
    this.el.doorActions.textContent = extra;
  }

  /** 문틈 확인 결과 */
  showPeek(result) {
    if (!result?.ok) return;
    const contacts = PEEK_LABEL[result.contacts] || '판단 불가';
    const armed = result.contacts === 'none' ? '' : result.armed ? ' · 무장 확인' : ' · 무장 미확인';
    this.banner(`문틈 확인: ${contacts}${armed}`, 2600);
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
    $('resGrade').textContent = data.grade || '-';
    $('resGrade').className = 'grade g' + (data.grade || 'F');
    $('resGradeLabel').textContent = data.gradeLabel || '';
    $('resScore').textContent = `${data.score ?? 0} 점`;
    $('resAdvice').textContent = data.advice || '';
    $('resStory').textContent = won ? MISSION.won : MISSION.lost;

    const breakdown = $('resLines');
    breakdown.innerHTML = '';
    for (const line of data.lines || []) {
      const li = document.createElement('li');
      li.className = line.points < 0 ? 'minus' : '';
      li.innerHTML = `<span>${escapeHtml(line.label)} ×${line.count}</span>`
        + `<span class="p">${line.points > 0 ? '+' : ''}${line.points}</span>`;
      breakdown.appendChild(li);
    }

    const ul = $('resStats');
    ul.innerHTML = '';
    for (const s of data.stats || []) {
      const li = document.createElement('li');
      const me = s.id === myId ? ' (나)' : '';
      li.innerHTML =
        `<span>${escapeHtml(s.name)}${me}${s.alive ? '' : ' · 전사'}</span>`
        + `<span class="k">제압 ${s.kills} · 체포 ${s.arrests} · 구조 ${s.rescues}</span>`;
      ul.appendChild(li);
    }
    this.show('result');
  }

  /** 매치 종료/재시작 시 HUD 초기화 */
  resetForNewMatch() {
    this.setDead(false);
    this.setAim(0, '');
    clearTimeout(this._radioTimer);
    $('radio').classList.add('hidden');
    this.setDefuse(false);
    this.setDoor(null);
    this.setFlash(0);
    this.setGas(0);
    this.el.killfeed.innerHTML = '';
    this.el.banner.style.opacity = '0';
    this.el.dmg.style.opacity = '0';
    this.clearThreats();
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
