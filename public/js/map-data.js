// Shared rendering/collision contract. y = bottom; h = thickness; ry = Three.js yaw.
import { MODELS } from './config.js';
export const MAP = { name:'라벤우드 대저택',width:48,depth:36,height:7,floorColor:0xb6afa3,wallColor:0xebe2d0,ceilColor:0xd9d1bf };
const HALF_W=24,HALF_D=18;
export const WALLS=[
  {x:0,z:-18,w:48,d:.4,h:7},{x:0,z:18,w:48,d:.4,h:7},
  {x:-24,z:0,w:.4,d:36,h:7},{x:24,z:0,w:.4,d:36,h:7},
];
for(const x of [-9,9]) for(const [z,d] of [[-16,4],[-6,8],[6,8],[16,4]]) WALLS.push({x,z,w:.3,d,h:7});
for(const x of [-16.5,16.5])for(const z of [-6,6])for(const dx of [-5,5]) WALLS.push({x:x+dx,z,w:5,d:.3,h:7});
export const ROOMS=[
  {name:'GRAND HALL',label:'중앙 대홀',x:0,z:4,w:17,d:25},
  {name:'LIBRARY',label:'서재 · 목표 A',x:-16.5,z:-12,w:14,d:11},
  {name:'DRAWING ROOM',label:'응접실',x:-16.5,z:0,w:14,d:11},
  {name:'DINING ROOM',label:'연회실',x:-16.5,z:12,w:14,d:11},
  {name:'CONSERVATORY',label:'온실 · 목표 B',x:16.5,z:-12,w:14,d:11},
  {name:'GALLERY',label:'미술관',x:16.5,z:0,w:14,d:11},
  {name:'GUEST SUITE',label:'게스트 스위트',x:16.5,z:12,w:14,d:11},
];
export const FURNITURE=[];
const part=(x,z,w,d,h,y=0,material='wood',ry=0)=>FURNITURE.push({x,z,w,d,h,y,material,ry});
function table(x,z,w=4,d=1.8){
  part(x,z,w,d,.16,.94);
  for(const dx of [-w/2+.16,w/2-.16])for(const dz of [-d/2+.16,d/2-.16])part(x+dx,z+dz,.18,.18,.94);
}
function sofa(x,z,ry=0){
  const add=(dx,dz,w,d,h,y)=>{
    const c=Math.cos(ry),s=Math.sin(ry);part(x+c*dx+s*dz,z-s*dx+c*dz,w,d,h,y,'velvet',ry);
  };
  add(0,0,3.4,1.05,.52,0);add(0,.48,3.4,.16,.65,.52);
  for(const dx of [-1.58,1.58])add(dx,0,.24,1.05,.3,.52);
}
table(-16.5,12,6,2.2);table(-16.5,-12,3.6,1.6);table(16.5,12,3.2,1.8);
sofa(-16.5,2);sofa(-16.5,-2,Math.PI);table(-16.5,0,2.2,1.2);
sofa(-5,5,Math.PI/2);sofa(5,5,-Math.PI/2);table(0,5,2.4,1.2);
sofa(16.5,14);sofa(19,-12,Math.PI/2);
for(const x of [-22.9,-20,-17.1,-14.2]){
  part(x,-17.2,2.5,.65,.7);part(x,-17.45,2.5,.15,2.9,.7);
  for(const y of [.7,1.4,2.1,2.8,3.5])part(x,-17.15,2.5,.65,.09,y);
}
for(const x of [-20,-13])for(const z of [9.8,14.2]){
  part(x,z,.8,.8,.55,0,'velvet');part(x,z+.35,.8,.1,.6,.55);
}
// Ceremonial stairs: 20 cm risers and 42 cm treads, raised northern landing.
for(let i=0;i<12;i++)part(0,-6-i*.42,5,.42,(i+1)*.2,0,'stone');
part(0,-13.4,8,5.2,2.4,0,'stone');
for(const x of [-4.2,4.2])part(x,-13.4,.25,5.2,1.1,2.4,'brass');
for(const x of [-6.5,6.5])for(const z of [-4,10])part(x,z,.65,.65,6.9,0,'stone');
for(const z of [-3,3])part(18,z,1,1,1.15,0,'stone');
export const PROPS=[
  {model:'vase',x:-7,z:14,ry:0,s:.7},{model:'vase',x:7,z:14,ry:0,s:.7},
  {model:'vase',x:18,z:-3,yOff:1.15,ry:0,s:.65},{model:'vase',x:18,z:3,yOff:1.15,ry:0,s:.65},
  {model:'crate',x:20,z:8,ry:.4,s:1},{model:'crate',x:21.5,z:8,ry:-.2,s:1.25},
  {model:'barrel',x:22,z:-15,ry:0,s:1},
];
for(const p of PROPS){const [w,h,d]=MODELS[p.model].fit.size;p.col={w:w*p.s,h:h*p.s,d:d*p.s};}
export const LIGHTS=[
  {x:0,y:5.5,z:4,color:0xffdfad,intensity:80,distance:27},
  {x:0,y:5.5,z:-11,color:0xffdfa8,intensity:60,distance:22},
  ...ROOMS.slice(1).map(r=>({x:r.x,y:5.2,z:r.z,color:r.name==='CONSERVATORY'?0xc9e7ff:0xffd8a4,intensity:55,distance:21})),
];
export const SPAWNS=[{x:-2,z:15,yaw:0},{x:2,z:15,yaw:0},{x:-2,z:13,yaw:0},{x:2,z:13,yaw:0}];
export const BOMB_SITES=[{id:'A',x:-20,z:-10,label:'서재 A'},{id:'B',x:16,z:-14,label:'온실 B'}];
export const BOT_SPAWNS=[{x:-13,z:-12},{x:13,z:-12},{x:-20,z:0},{x:20,z:0},{x:-13,z:12},{x:13,z:12}];
export const COLLIDERS=[
  ...WALLS.map(w=>({...w,kind:'wall'})),...FURNITURE.map(f=>({...f,kind:'prop'})),
  ...PROPS.map(p=>({x:p.x,z:p.z,y:p.yOff||0,...p.col,ry:p.ry||0,kind:'prop',shape:p.model==='crate'?'box':'cylinder'})),
];
const top=c=>(c.y||0)+c.h;
export const PATROL_NODES=[...[-12,0,12].flatMap(z=>[-16,-7,0,7,16].map(x=>({x,z}))),{x:-6,z:-16},{x:6,z:-16},{x:0,z:15}]
  .filter(p=>!COLLIDERS.some(c=>(c.y||0)<1.8&&overlaps(p.x,p.z,.38,c)));
function local(x,z,c){const co=Math.cos(c.ry||0),si=Math.sin(c.ry||0),dx=x-c.x,dz=z-c.z;return{x:co*dx-si*dz,z:si*dx+co*dz,co,si};}
export function overlaps(x,z,r,c){
  if(c.shape==='cylinder')return Math.hypot(x-c.x,z-c.z)<r+c.w/2;
  const p=local(x,z,c);
  return Math.hypot(p.x-Math.max(-c.w/2,Math.min(c.w/2,p.x)),p.z-Math.max(-c.d/2,Math.min(c.d/2,p.z)))<r;
}
export function outOfBounds(x,z){return Math.abs(x)>HALF_W-.2||Math.abs(z)>HALF_D-.2;}
// Circle vs oriented rectangle. Corners are round, not an enlarged invisible box.
export function resolveCircle(x,z,r,colliders=COLLIDERS,feet=0,height=1.8){
  for(let pass=0;pass<4;pass++)for(const c of colliders){
    if(feet>=top(c)-.001||feet+height<=(c.y||0)+.001)continue;
    if(c.shape==='cylinder'){
      const dx=x-c.x,dz=z-c.z,d=Math.hypot(dx,dz),limit=c.w/2+r;
      if(d<limit){x+=d>1e-8?dx*(limit-d)/d:limit;z+=d>1e-8?dz*(limit-d)/d:0;}
      continue;
    }
    const p=local(x,z,c),hw=c.w/2,hd=c.d/2;
    let dx=p.x-Math.max(-hw,Math.min(hw,p.x)),dz=p.z-Math.max(-hd,Math.min(hd,p.z));
    const len=Math.hypot(dx,dz);if(len>=r)continue;
    if(len>1e-8){dx*=(r-len)/len;dz*=(r-len)/len;}
    else if(hw-Math.abs(p.x)<hd-Math.abs(p.z)){dx=(p.x>=0?1:-1)*(hw-Math.abs(p.x)+r);dz=0;}
    else{dz=(p.z>=0?1:-1)*(hd-Math.abs(p.z)+r);dx=0;}
    x+=p.co*dx+p.si*dz;z+=-p.si*dx+p.co*dz;
  }
  return{x:Math.max(-HALF_W+.2+r,Math.min(HALF_W-.2-r,x)),z:Math.max(-HALF_D+.2+r,Math.min(HALF_D-.2-r,z))};
}
export function moveBody(pos,velocity,dt,{radius=.32,height=1.8,stepHeight=.22,grounded=false,gravity=-18}={},colliders=COLLIDERS){
  const p={...pos},v={...velocity};let onGround=grounded;
  const steps=Math.max(1,Math.ceil(dt/(1/120))),h=dt/steps;
  for(let i=0;i<steps;i++){
    const oldY=p.y;v.y+=gravity*h;let ny=p.y+v.y*h,nx=p.x+v.x*h,nz=p.z+v.z*h;
    if(onGround&&v.y<=0){
      let stair=p.y;
      for(const c of colliders)if(top(c)>p.y+.001&&top(c)<=p.y+stepHeight&&overlaps(nx,nz,radius,c))stair=Math.max(stair,top(c));
      if(stair>p.y){const fit=resolveCircle(nx,nz,radius,colliders,stair,height);if(Math.hypot(fit.x-nx,fit.z-nz)<.001){p.y=ny=stair;v.y=0;}}
    }
    // Clamp a rising head before side resolution, otherwise the underside
    // incorrectly ejects the player sideways out from under the shelf.
    if(v.y>0) {
      let headLimit=MAP.height;
      for(const c of colliders)if((c.y||0)>=oldY+height-.002&&overlaps(nx,nz,radius,c))headLimit=Math.min(headLimit,c.y);
      if(ny+height>headLimit){ny=headLimit-height;v.y=0;}
    }
    const fixed=resolveCircle(nx,nz,radius,colliders,Math.max(p.y,ny),height);
    if(Math.abs(fixed.x-nx)>.001)v.x=0;if(Math.abs(fixed.z-nz)>.001)v.z=0;
    p.x=fixed.x;p.z=fixed.z;onGround=false;
    if(v.y<=0){
      let support=0;
      for(const c of colliders)if(top(c)<=Math.max(oldY,p.y)+.002&&top(c)>=ny-.002&&overlaps(p.x,p.z,radius,c))support=Math.max(support,top(c));
      if(ny<=support+.002){ny=support;v.y=0;onGround=true;}
    }else{
      let headLimit=MAP.height;
      for(const c of colliders)if((c.y||0)>=oldY+height-.002&&overlaps(p.x,p.z,radius,c))headLimit=Math.min(headLimit,c.y);
      if(ny+height>headLimit){ny=headLimit-height;v.y=0;}
    }
    p.y=Math.max(0,ny);
  }
  return{pos:p,vel:v,onGround};
}
function boxRay(ox,oy,oz,dx,dy,dz,maxDist,c){
  if(c.shape==='cylinder'){
    const px=ox-c.x,pz=oz-c.z,a=dx*dx+dz*dz,b=2*(px*dx+pz*dz),k=px*px+pz*pz-c.w*c.w/4;
    let near=0,far=maxDist;
    if(a<1e-12){if(k>0)return Infinity;}
    else{const disc=b*b-4*a*k;if(disc<0)return Infinity;const root=Math.sqrt(disc);near=Math.max(near,(-b-root)/(2*a));far=Math.min(far,(-b+root)/(2*a));}
    if(Math.abs(dy)<1e-8){if(oy<(c.y||0)||oy>top(c))return Infinity;}
    else{const t0=((c.y||0)-oy)/dy,t1=(top(c)-oy)/dy;near=Math.max(near,Math.min(t0,t1));far=Math.min(far,Math.max(t0,t1));}
    return near<=far?near:Infinity;
  }
  const p=local(ox,oz,c),lx=p.co*dx-p.si*dz,lz=p.si*dx+p.co*dz;let near=0,far=maxDist;
  for(const[o,d,lo,hi]of[[p.x,lx,-c.w/2,c.w/2],[oy,dy,c.y||0,top(c)],[p.z,lz,-c.d/2,c.d/2]]){
    if(Math.abs(d)<1e-8){if(o<lo||o>hi)return Infinity;continue;}
    const a=(lo-o)/d,b=(hi-o)/d;near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));if(near>far)return Infinity;
  }return near;
}
export function segmentHitsBox(ax,az,dx,dz,c){return boxRay(ax,(c.y||0)+c.h/2,az,dx,0,dz,1,c)<=1;}
export function hasLineOfSight(ax,az,bx,bz,eyeH=1.4,colliders=COLLIDERS){return !colliders.some(c=>boxRay(ax,eyeH,az,bx-ax,0,bz-az,1,c)<=1);}
export function rayWallDistance(ox,oz,dx,dz,maxDist,eyeH=1.4,colliders=COLLIDERS){return Math.min(Infinity,...colliders.map(c=>boxRay(ox,eyeH,oz,dx,0,dz,maxDist,c)));}
export function rayObstacleDistance(o,d,maxDist,colliders=COLLIDERS){
  let best=maxDist;for(const c of colliders)best=Math.min(best,boxRay(o.x,o.y,o.z,d.x,d.y,d.z,best,c));
  if(Math.abs(d.y)>1e-8)for(const y of [0,MAP.height]){const t=(y-o.y)/d.y;if(t>=0)best=Math.min(best,t);}return best;
}
// Cached navigation grid: route guards through the actual door openings.
const NAV_W=48,NAV_D=36;let nav;
export function findRoute(start,goal,radius=.38){
  if(!nav)nav=Array.from({length:NAV_W*NAV_D},(_,i)=>{
    const x=i%NAV_W-23.5,z=Math.floor(i/NAV_W)-17.5;
    return !COLLIDERS.some(c=>(c.y||0)<1.8&&overlaps(x,z,radius,c));
  });
  const id=p=>Math.max(0,Math.min(35,Math.floor(p.z+18)))*NAV_W+Math.max(0,Math.min(47,Math.floor(p.x+24)));
  const point=i=>({x:i%NAV_W-23.5,z:Math.floor(i/NAV_W)-17.5});
  const nearest=p=>{let best=-1,dist=Infinity;nav.forEach((ok,i)=>{if(ok){const a=point(i),d=Math.hypot(a.x-p.x,a.z-p.z);if(d<dist){best=i;dist=d;}}});return best;};
  let a=id(start),b=id(goal);if(!nav[a])a=nearest(start);if(!nav[b])b=nearest(goal);if(a<0||b<0)return[];
  const prev=new Int32Array(nav.length).fill(-1),queue=[a];prev[a]=a;
  for(let q=0;q<queue.length&&prev[b]<0;q++){
    const i=queue[q];for(const j of [i-1,i+1,i-NAV_W,i+NAV_W]){
      if(j<0||j>=nav.length||!nav[j]||prev[j]>=0)continue;
      if(Math.abs(j-i)===1&&Math.floor(j/NAV_W)!==Math.floor(i/NAV_W))continue;
      const p=point(i),n=point(j);
      if(COLLIDERS.some(c=>(c.y||0)<1.8&&segmentHitsBox(p.x,p.z,n.x-p.x,n.z-p.z,{...c,w:c.w+radius*2,d:c.d+radius*2})))continue;
      prev[j]=i;queue.push(j);
    }
  }
  if(prev[b]<0)return[];const path=[];for(let i=b;i!==a;i=prev[i])path.push(point(i));return path.reverse();
}
