import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {MAP,WALLS,ROOMS,FURNITURE,PROPS,SPAWNS,BOT_SPAWNS,BOMB_SITES,COLLIDERS,moveBody,resolveCircle,findRoute,overlaps,rayObstacleDistance} from '../public/js/map-data.js';
import {PLAYER,MODELS} from '../public/js/config.js';

test('mansion has ten times the original floor area and every room/objective is reachable',()=>{
  assert.ok(MAP.width*MAP.depth>=165*10);
  for(const goal of [...ROOMS.slice(1),...BOT_SPAWNS,...BOMB_SITES]){
    assert.ok(findRoute(SPAWNS[0],goal).length>0,JSON.stringify(goal));
  }
  for(const p of [...SPAWNS,...BOT_SPAWNS])assert.deepEqual(resolveCircle(p.x,p.z,PLAYER.radius),{x:p.x,z:p.z});
});
test('circle corners are not oversized invisible squares; rotated boxes use their rotation',()=>{
  const box={x:0,z:0,w:2,d:2,h:2};
  assert.deepEqual(resolveCircle(1.25,1.25,.32,[box]),{x:1.25,z:1.25});
  const rotated={...box,w:4,d:.4,ry:Math.PI/2};
  assert.deepEqual(resolveCircle(1,0,.32,[rotated]),{x:1,z:0});
  assert.notDeepEqual(resolveCircle(0,1,.32,[rotated]),{x:0,z:1});
  assert.equal(rayObstacleDistance({x:2,y:1,z:1},{x:-1,y:0,z:0},5,[rotated]),1.8);
});
test('props have scaled collider dimensions identical to model normalization',()=>{
  for(const p of PROPS){
    const fit=MODELS[p.model].fit;
    const [w,h,d]=fit.size??[1.6,fit.height,1.6];
    assert.deepEqual(p.col,{w:w*p.s,h:h*p.s,d:d*p.s});
    const c=COLLIDERS.find(c=>c.x===p.x&&c.z===p.z&&c.h===p.col.h);
    assert.equal(c.y,p.yOff||0);assert.equal(c.ry,p.ry||0);
  }
});
test('barrel corners are traversable and shots use its circular profile',()=>{
  const c={x:0,z:0,w:1,d:1,h:1,shape:'cylinder'};
  assert.deepEqual(resolveCircle(.6,.6,.32,[c]),{x:.6,z:.6});
  assert.equal(rayObstacleDistance({x:.49,y:.5,z:2},{x:0,y:0,z:-1},5,[c])>1.8,true);
});
test('jump apex exceeds tables and a descending player lands and remains on a tabletop',()=>{
  let p={x:0,y:0,z:0},v={x:0,y:PLAYER.jumpSpeed,z:0},apex=0;
  for(let i=0;i<120;i++){const b=moveBody(p,v,1/120,{},[]);p=b.pos;v=b.vel;apex=Math.max(apex,p.y);}
  assert.ok(apex>1.6&&apex<1.7,String(apex));
  const table=[{x:0,z:0,w:3,d:2,h:.16,y:.94}];
  p={x:0,y:2,z:0};v={x:0,y:-3,z:0};
  let ground=false;
  for(let i=0;i<60;i++){const b=moveBody(p,v,1/60,{grounded:ground},table);p=b.pos;v=b.vel;ground=b.onGround;}
  assert.ok(Math.abs(p.y-1.1)<.001);assert.equal(ground,true);
  const leave=moveBody({x:2,y:1.1,z:0},{x:0,y:0,z:0},.1,{grounded:true},table);
  assert.ok(leave.pos.y<1.1);assert.equal(leave.onGround,false);
});
test('horizontal movement can clear a crate in air, but cannot go through it at ground height',()=>{
  const c=[{x:0,z:0,w:1,d:1,h:.75}];
  assert.deepEqual(resolveCircle(0,0,.32,c,1.2),{x:0,z:0});
  assert.notDeepEqual(resolveCircle(0,0,.32,c,0),{x:0,z:0});
});
test('ceremonial staircase is walkable all the way to the raised landing',()=>{
  let p={x:0,y:0,z:-5},v={x:0,y:0,z:-2},grounded=true;
  for(let i=0;i<300;i++){
    const b=moveBody(p,{...v,z:-2},1/60,{grounded});p=b.pos;v=b.vel;grounded=b.onGround;
  }
  assert.ok(p.z<-11,JSON.stringify(p));assert.ok(Math.abs(p.y-2.4)<.001,JSON.stringify(p));
});
test('overhead shelves stop upward movement and low openings stay traversable',()=>{
  const shelf=[{x:0,z:0,w:3,d:3,y:2.2,h:.2}];
  const b=moveBody({x:0,y:0,z:0},{x:0,y:8,z:0},.1,{},shelf);
  assert.ok(b.pos.y<=.4+.001);
  assert.deepEqual(resolveCircle(0,0,.32,shelf,0,1.8),{x:0,z:0});
});
test('every furniture solid has a matching collider and material texture files exist',async()=>{
  for(const f of FURNITURE)assert.ok(COLLIDERS.some(c=>c.x===f.x&&c.z===f.z&&c.y===f.y&&c.w===f.w&&c.d===f.d&&c.h===f.h));
  for(const name of ['concrete-color.jpg','concrete-normal.jpg','concrete-rough.jpg','brick-color.jpg','brick-normal.jpg']){
    const bytes=await fs.readFile(new URL('../public/assets/textures/'+name,import.meta.url));
    assert.equal(bytes.readUInt16BE(0),0xffd8);assert.ok(bytes.length>10000,name);
  }
});

test('가구는 벽에 딱 붙지 않는다 (붙으면 면이 겹쳐 지지직거린다)', () => {
  // 책장 뒷면과 벽면이 정확히 같은 평면에 있으면 깊이 값이 같아서 카메라가
  // 움직일 때마다 앞뒤가 뒤집힌다(z-fighting). 서재 책장에서 실제로 보였다.
  const box = (c) => ({
    x0: c.x - c.w / 2, x1: c.x + c.w / 2, z0: c.z - c.d / 2, z1: c.z + c.d / 2,
    y0: c.y || 0, y1: (c.y || 0) + c.h,
  });
  const touching = [];
  for (const f of FURNITURE) {
    if (f.ry) continue;                       // 돌아간 가구는 면이 평행하지 않다
    const a = box(f);
    for (const w of WALLS) {
      const b = box(w);
      if (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) <= 0.05) continue;
      const overlapZ = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 0.05;
      const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.05;
      for (const [p, q] of [[a.x0, b.x1], [a.x1, b.x0]]) {
        if (overlapZ && Math.abs(p - q) < 0.002) touching.push(`(${f.x}, ${f.z}) x면`);
      }
      for (const [p, q] of [[a.z0, b.z1], [a.z1, b.z0]]) {
        if (overlapX && Math.abs(p - q) < 0.002) touching.push(`(${f.x}, ${f.z}) z면`);
      }
    }
  }
  assert.deepEqual(touching, [], '벽과 같은 평면에 놓인 가구: ' + touching.join(', '));
});
