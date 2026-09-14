// Run --write after intentionally changing an asset; cloud builds only verify.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MODELS} from '../public/js/config.js';
const manifestURL=new URL('../asset-integrity.json',import.meta.url);
export const textures=['concrete-color.jpg','concrete-normal.jpg','concrete-rough.jpg','brick-color.jpg','brick-normal.jpg'];
export async function assetIntegrity(write=false){
  // 선택 모델(역할별 캐릭터)은 없을 수 있다. 있는 파일만 검사 대상에 넣는다.
  const candidates=[...Object.values(MODELS).map(m=>({name:'public'+m.url,optional:!!m.optional})),
    ...textures.map(n=>({name:'public/assets/textures/'+n,optional:false}))];
  const files=[];
  const actual={};
  for(const {name,optional} of candidates){
    const bytes=await fs.readFile(new URL('../'+name,import.meta.url)).catch(e=>{
      if(optional)return null; throw e;});
    if(!bytes)continue;
    files.push(name);
    actual[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  if(write){await fs.writeFile(manifestURL,JSON.stringify(actual,null,2)+'\n');return;}
  const expected=JSON.parse(await fs.readFile(manifestURL,'utf8'));
  for(const name of files)if(actual[name].sha256!==expected[name]?.sha256)
    throw new Error('Asset integrity mismatch: '+name+'; check the complete uploaded file.');
}
if(process.argv.includes('--write'))await assetIntegrity(true);
