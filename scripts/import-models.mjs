// npm run import:models -- /path/to/extracted-packs
// Input folders: swat/, guns/, market/, each containing scene.gltf and its resources.
// Keeps the authored transforms, selects complete objects, and embeds every dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Matrix4, Vector3, Quaternion } from 'three';

const source = process.argv[2];
if (!source) throw new Error('Pass the folder containing swat/, guns/ and market/.');
const output = new URL('../public/assets/models/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const definitions = [
  ['swat', null, 'character'],
  ['guns', 'M416_8', 'weapon-rifle'],
  ['guns', 'UMP9_7', 'weapon-smg'],
  ['guns', 'AWM.001_6', 'weapon-sniper'],
  ['market', 'Stall', 'stall-tarp'],
  ['market', 'Create', 'crate'],
  ['market', 'Barrel', 'barrel'],
  ['market', 'Vase', 'vase'],
  ['market', 'Well', 'well'],
];
const matrix = n => n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(
  new Vector3().fromArray(n.translation || [0, 0, 0]),
  new Quaternion().fromArray(n.rotation || [0, 0, 0, 1]),
  new Vector3().fromArray(n.scale || [1, 1, 1]),
);

for (const [pack, name, filename] of definitions) {
  const dir = path.resolve(source, pack);
  const doc = JSON.parse(await fs.readFile(path.join(dir, 'scene.gltf'), 'utf8'));
  const buffers = await Promise.all(doc.buffers.map(b => fs.readFile(path.join(dir, b.uri))));
  let roots = doc.scenes[doc.scene || 0].nodes;
  let parentMatrix = new Matrix4();
  if (name) {
    const selected = doc.nodes.findIndex(n => n.name === name);
    if (selected < 0) throw new Error(`Missing object ${name} in ${pack}`);
    const parents = new Map();
    doc.nodes.forEach((n, i) => n.children?.forEach(c => parents.set(c, i)));
    const ancestors = [];
    for (let i = parents.get(selected); i !== undefined; i = parents.get(i)) ancestors.unshift(i);
    ancestors.forEach(i => parentMatrix.multiply(matrix(doc.nodes[i])));
    roots = [selected];
  }
  const keep = new Set();
  const visit = i => { if (keep.has(i)) return; keep.add(i); doc.nodes[i].children?.forEach(visit); };
  roots.forEach(visit);
  // A skinned character must retain its whole skeleton, including inverse bind matrices.
  [...keep].forEach(i => {
    const skin = doc.skins?.[doc.nodes[i].skin];
    skin?.joints.forEach(visit);
    if (skin?.skeleton !== undefined) visit(skin.skeleton);
  });
  const nodeIds = [...keep], nodeMap = new Map(nodeIds.map((v, i) => [v, i]));
  const result = { asset: doc.asset, scene: 0, scenes: [{ nodes: [] }], nodes: [],
    meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [], textures: [], images: [] };
  for (const k of ['extensionsUsed', 'extensionsRequired', 'samplers']) if (doc[k]) result[k] = doc[k];
  const parts = []; let length = 0;
  const append = data => {
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4); data.copy(padded);
    const index = result.bufferViews.length;
    result.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length });
    parts.push(padded); length += padded.length;
    return index;
  };
  const memo = (table, fn) => {
    const map = new Map();
    return i => { if (!map.has(i)) { const id = table.length; map.set(i, id); table.push(null); table[id] = fn(i); } return map.get(i); };
  };
  const viewMap = new Map();
  const view = i => {
    if (!viewMap.has(i)) {
      const v = doc.bufferViews[i], offset = v.byteOffset || 0;
      const n = append(buffers[v.buffer].subarray(offset, offset + v.byteLength));
      for (const key of ['byteStride', 'target']) if (v[key] !== undefined) result.bufferViews[n][key] = v[key];
      viewMap.set(i, n);
    }
    return viewMap.get(i);
  };
  const accessor = memo(result.accessors, i => {
    const a = structuredClone(doc.accessors[i]);
    if (a.bufferView !== undefined) a.bufferView = view(a.bufferView);
    if (a.sparse) {
      a.sparse.indices.bufferView = view(a.sparse.indices.bufferView);
      a.sparse.values.bufferView = view(a.sparse.values.bufferView);
    }
    return a;
  });
  // Load images first; only images referenced by the selected materials are emitted below.
  const imageBytes = await Promise.all((doc.images || []).map(i => fs.readFile(path.join(dir, i.uri))));
  const image = memo(result.images, i => ({ bufferView: append(imageBytes[i]),
    mimeType: /\.png$/i.test(doc.images[i].uri) ? 'image/png' : 'image/jpeg' }));
  const texture = memo(result.textures, i => ({ ...doc.textures[i], source: image(doc.textures[i].source) }));
  const material = memo(result.materials, i => {
    const m = structuredClone(doc.materials[i]);
    const walk = obj => { for (const [key, val] of Object.entries(obj)) {
      if (key.endsWith('Texture') && val?.index !== undefined) val.index = texture(val.index);
      else if (val && typeof val === 'object') walk(val);
    } };
    walk(m); return m;
  });
  const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const read = (a, i) => {
    if (a.sparse) throw new Error('Sparse vertex accessors require expansion before importing.');
    const v = doc.bufferViews[a.bufferView];
    const bytes = componentBytes[a.componentType] * components[a.type];
    const start = (v.byteOffset || 0) + (a.byteOffset || 0) + i * (v.byteStride || bytes);
    return buffers[v.buffer].subarray(start, start + bytes);
  };
  const compact = p => {
    const originalIndex = p.indices !== undefined ? doc.accessors[p.indices] : null;
    const count = originalIndex?.count ?? doc.accessors[p.attributes.POSITION].count;
    const ids = Array.from({ length: count }, (_, i) => originalIndex
      ? read(originalIndex, i).readUIntLE(0, componentBytes[originalIndex.componentType]) : i);
    const unique = [...new Set(ids)], remap = new Map(unique.map((id, i) => [id, i]));
    const index = Buffer.alloc(ids.length * 4); ids.forEach((id, i) => index.writeUInt32LE(remap.get(id), i * 4));
    const newIndex = result.accessors.length;
    result.accessors.push({ bufferView: append(index), componentType: 5125, count: ids.length, type: 'SCALAR' });
    result.bufferViews[result.accessors[newIndex].bufferView].target = 34963;
    const attributes = {};
    for (const [key, id] of Object.entries(p.attributes)) {
      const a = doc.accessors[id]; const data = Buffer.concat(unique.map(i => read(a, i)));
      const next = { ...a, bufferView: append(data), byteOffset: 0, count: unique.length };
      result.bufferViews[next.bufferView].target = 34962;
      delete next.min; delete next.max;
      if (key === 'POSITION') {
        next.min = [Infinity, Infinity, Infinity]; next.max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < unique.length; i++) for (let axis = 0; axis < 3; axis++) {
          const value = data.readFloatLE(i * 12 + axis * 4);
          next.min[axis] = Math.min(next.min[axis], value); next.max[axis] = Math.max(next.max[axis], value);
        }
      }
      attributes[key] = result.accessors.length; result.accessors.push(next);
    }
    p.attributes = attributes; p.indices = newIndex;
  };
  const mesh = memo(result.meshes, i => {
    const m = structuredClone(doc.meshes[i]);
    m.primitives.forEach(p => {
      // Packs can share one POSITION accessor containing every gun. Keep only
      // the vertices referenced by this object's indices, otherwise its bounds
      // include other objects and it is scaled/centered incorrectly in game.
      if (p.targets) throw new Error('Morph targets require synchronized vertex compaction.');
      compact(p);
      if (p.material !== undefined) p.material = material(p.material);
    }); return m;
  });
  result.nodes = nodeIds.map(i => {
    const n = structuredClone(doc.nodes[i]);
    if (n.children) n.children = n.children.map(j => nodeMap.get(j));
    if (n.mesh !== undefined) n.mesh = mesh(n.mesh);
    return n;
  });
  if (doc.skins?.length && !name) result.skins = doc.skins.map(s => ({ ...s,
    joints: s.joints.map(j => nodeMap.get(j)),
    ...(s.skeleton !== undefined ? { skeleton: nodeMap.get(s.skeleton) } : {}),
    ...(s.inverseBindMatrices !== undefined ? { inverseBindMatrices: accessor(s.inverseBindMatrices) } : {}),
  }));
  if (doc.animations?.length) throw new Error('Animation import needs explicit channel remapping.');
  result.scenes[0].nodes = [result.nodes.length];
  result.nodes.push({ name: 'SourceTransform', matrix: parentMatrix.toArray(), children: roots.map(i => nodeMap.get(i)) });
  result.buffers = [{ byteLength: length }];
  for (const key of Object.keys(result)) if (Array.isArray(result[key]) && !result[key].length) delete result[key];
  const json = Buffer.from(JSON.stringify(result));
  const jsonChunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(jsonChunk);
  const binary = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + jsonChunk.length + binary.length, 8);
  header.writeUInt32LE(jsonChunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  await fs.writeFile(new URL(`${filename}.glb`, output), Buffer.concat([header, jsonChunk, binHeader, binary]));
  console.log(`${filename}.glb: ${result.meshes.length} meshes, ${result.images?.length || 0} textures, ${Math.round(binary.length / 1024)} KiB`);
}
