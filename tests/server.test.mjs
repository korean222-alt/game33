import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io } from 'socket.io-client';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('two clients: readiness gate, zero-axis shot, jumping origin, loadout lock and room cleanup', { timeout: 20000 }, async t => {
  const port = 3187;
  const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sockets = [];
  t.after(() => { sockets.forEach(s => s.disconnect()); server.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.stdout.on('data', data => { if (String(data).includes('서버 준비됨')) { clearTimeout(timer); resolve(); } });
    server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });
  const connect = async () => {
    const socket = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket); await once(socket, 'connect'); return socket;
  };
  const host = await connect(), guest = await connect();
  const request = (s, event, payload) => new Promise((resolve, reject) => s.timeout(3000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
  const created = await request(host, 'createRoom', { name: '검증1', weapon: 'rifle' });
  const joined = await request(guest, 'joinRoom', { code: created.lobby.code, name: '검증2', weapon: 'smg' });
  assert.equal(joined.ok, true);
  let starts = 0; host.on('matchStart', () => starts++);
  host.emit('startMatch'); await delay(150); assert.equal(starts, 0);
  const lobbyReady = once(host, 'lobby'); host.emit('setLoadout', { ready: true }); await lobbyReady;
  const guestReady = once(guest, 'lobby'); guest.emit('setLoadout', { ready: true }); await guestReady;
  const started = once(host, 'matchStart'); host.emit('startMatch'); const [match] = await started;
  assert.equal(match.players.length, 2);
  host.emit('input', { x: -3.4, y: .5, z: 4.6, yaw: 0, pitch: 0 });
  const shotEvent = once(guest, 'playerShot');
  const shot = await request(host, 'shoot', { dx: 1, dy: 0, dz: 0 });
  assert.equal(shot.ok, true);
  const [effect] = await shotEvent;
  assert.equal(effect.dz, 0); assert.equal(effect.dx, 1); assert.equal(effect.y, 2.12);
  host.emit('setLoadout', { weapon: 'sniper', ready: false });
  const [snapshot] = await once(host, 'snapshot');
  const me = snapshot.players.find(p => p.id === host.id);
  assert.equal(me.ammo, 29); // Mid-match loadout changes must not refill ammunition.
  assert.equal((await request(host, 'shoot', { dx: null, dy: 0, dz: -1 })).ok, false);
  const standing=once(host,'snapshot');
  host.emit('input',{x:0,y:2.4,z:-13,yaw:0,pitch:0});
  const [elevated]=await standing;
  const onLanding=elevated.players.find(p=>p.id===host.id);
  assert.equal(onLanding.x,0);assert.equal(onLanding.z,-13);assert.equal(onLanding.y,2.4);
  const second = await request(host, 'createRoom', { name: '검증1', weapon: 'rifle' });
  guest.emit('leaveRoom'); await delay(100);
  const health = await (await fetch(`http://localhost:${port}/health`)).json();
  assert.equal(health.rooms, 1); assert.notEqual(second.lobby.code, created.lobby.code);
});
