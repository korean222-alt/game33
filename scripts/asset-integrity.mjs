// Run --write after intentionally changing an asset; cloud builds only verify.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MODELS} from '../public/js/config.js';
const manifestURL=new URL('../asset-integrity.json',import.meta.url);
export const textures=['concrete-color.jpg','concrete-normal.jpg','concrete-rough.jpg','brick-color.jpg','brick-normal.jpg'];
export async function assetIntegrity(write=false){
  const files=[...Object.values(MODELS).map(m=>'public'+m.url),...textures.map(n=>'public/assets/textures/'+n)];
  const actual={};
  for(const name of files){
    const bytes=await fs.readFile(new URL('../'+name,import.meta.url));
    actual[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  if(write){await fs.writeFile(manifestURL,JSON.stringify(actual,null,2)+'\n');return;}
  const expected=JSON.parse(await fs.readFile(manifestURL,'utf8'));
  for(const name of files)if(actual[name].sha256!==expected[name]?.sha256)
    throw new Error('Asset integrity mismatch: '+name+'; check the complete uploaded file.');
}
if(process.argv.includes('--write'))await assetIntegrity(true);
