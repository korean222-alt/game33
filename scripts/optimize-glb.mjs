// Lossless geometry; only oversized embedded PNGs are downsampled to 512px.
// Run explicitly with ImageMagick installed, never as part of the cloud build.
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const filename=process.argv[2];
if(!filename)throw new Error('Usage: node scripts/optimize-glb.mjs model.glb');
const bytes=await fs.readFile(filename),jsonLength=bytes.readUInt32LE(12);
if(bytes.readUInt32LE(8)!==bytes.length)throw new Error('Input GLB is truncated');
const doc=JSON.parse(bytes.subarray(20,20+jsonLength)),binary=bytes.subarray(28+jsonLength);
const imageViews=new Set(doc.images.filter(i=>i.mimeType==='image/png').map(i=>i.bufferView));
let offset=0;const parts=[];
doc.bufferViews.forEach((view,i)=>{
  let part=binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);
  if(imageViews.has(i)&&part.length>500000)part=execFileSync('convert',['png:-','-resize','512x512>','png:-'],{input:part,maxBuffer:8*1024*1024});
  view.byteOffset=offset;view.byteLength=part.length;
  const padded=Buffer.alloc(Math.ceil(part.length/4)*4);part.copy(padded);parts.push(padded);offset+=padded.length;
});
doc.buffers=[{byteLength:offset}];
const raw=Buffer.from(JSON.stringify(doc)),json=Buffer.alloc(Math.ceil(raw.length/4)*4,32);raw.copy(json);
const head=Buffer.alloc(20),binHead=Buffer.alloc(8);
head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+offset,8);
head.writeUInt32LE(json.length,12);head.writeUInt32LE(0x4e4f534a,16);
binHead.writeUInt32LE(offset,0);binHead.writeUInt32LE(0x004e4942,4);
const result=Buffer.concat([head,json,binHead,...parts]);await fs.writeFile(filename,result);
console.log(filename+': '+bytes.length+' -> '+result.length+' bytes');
