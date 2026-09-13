/* =============================================================================
 *  tools/dev/inspect.mjs  -  구운 GLB 의 "진짜" 치수를 잰다
 *
 *  three.js 의 Box3.setFromObject 은 노드에 회전이 박혀 있으면 경계 상자를
 *  실제보다 크게 잡는다(회전된 상자의 AABB 라서). 그래서 방향/크기를 확정할 때는
 *  정점을 전부 월드로 옮겨서 직접 재야 한다. 이 스크립트가 그걸 한다.
 *
 *  X 축을 8구간으로 나눠 단면 두께를 같이 찍어주므로
 *  "총구가 -X 인지 +X 인지" 같은 것도 숫자로 판별할 수 있다.
 *
 *  실행:  node tools/dev/inspect.mjs weapon-rifle character crate
 * ========================================================================== */

import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

function mulVec(m, v) { // column-major mat4 * vec4
  return [
    m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12]*v[3],
    m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13]*v[3],
    m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]*v[3],
  ];
}

for (const name of process.argv.slice(2)) {
  const doc = await io.read(`public/assets/models/${name}.glb`);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const pts = [];
  const walk = (node) => {
    const w = node.getWorldMatrix();
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      for (let i = 0; i < pos.getCount(); i++) {
        const p = pos.getElement(i, [0,0,0]);
        pts.push(mulVec(w, [p[0],p[1],p[2],1]));
      }
    }
    for (const c of node.listChildren()) walk(c);
  };
  for (const c of scene.listChildren()) walk(c);

  const ax = (i) => pts.map(p => p[i]);
  const mn = [0,1,2].map(i => Math.min(...ax(i)));
  const mx = [0,1,2].map(i => Math.max(...ax(i)));
  console.log(`=== ${name}  verts=${pts.length}`);
  console.log('   bbox min', mn.map(v=>v.toFixed(3)).join(' '), ' max', mx.map(v=>v.toFixed(3)).join(' '));
  const N = 8, lo = mn[0], hi = mx[0], step = (hi-lo)/N;
  for (let b = 0; b < N; b++) {
    const sub = pts.filter(p => p[0] >= lo+b*step && p[0] < lo+(b+1)*step);
    if (sub.length < 3) { console.log(`   x[${(lo+b*step).toFixed(2)}] n=${sub.length} (거의 없음)`); continue; }
    const ys = sub.map(p=>p[1]), zs = sub.map(p=>p[2]);
    const yspan = Math.max(...ys)-Math.min(...ys), zspan = Math.max(...zs)-Math.min(...zs);
    console.log(`   x[${(lo+b*step).toFixed(2)}..${(lo+(b+1)*step).toFixed(2)}] n=${String(sub.length).padStart(5)}  Yspan=${yspan.toFixed(3)} Zspan=${zspan.toFixed(3)}  Ymin=${Math.min(...ys).toFixed(3)} Ymax=${Math.max(...ys).toFixed(3)}`);
  }
}
