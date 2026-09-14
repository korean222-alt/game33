import fs from 'node:fs/promises';
import { MODELS } from '../public/js/config.js';

export async function verifyModels() {
  for (const [key, model] of Object.entries(MODELS)) {
    const file = new URL('../public' + model.url, import.meta.url);
    const bytes = await fs.readFile(file).catch(() => { throw new Error(`Missing required model: ${key} (${model.url})`); });
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`Invalid GLB header: ${key}`);
    if (bytes.readUInt32LE(8) !== bytes.length) throw new Error(`Truncated GLB: ${key}; expected ${bytes.readUInt32LE(8)} bytes, received ${bytes.length}. Restore the complete binary file in GitHub.`);
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    if (json.buffers.some(b => b.uri) || (json.images || []).some(i => i.uri)) throw new Error(`External model dependency: ${key}`);
  }
}
