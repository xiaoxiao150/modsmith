/**
 * manifest 落盘与读取。
 *
 * 命名约定和 Cortico 那边一致：`<pack>.json` 是语义 manifest，`<pack>-ids.json` 是实测
 * 数字 id。两者都放在同一个目录（默认为目标项目的 `src/worlds/minecraft/mods/`）。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 写 manifest；键顺序固定，diff 才好看。 */
const ORDER = ['mod', 'version', 'namespace', 'source', 'blocks', 'items', 'foods', 'crops',
  'recipes', 'names', 'containers', 'stations', 'prompt', 'candidates', 'unsupported'];

export function writeManifest(file, manifest) {
  const out = {};
  for (const k of ORDER) if (manifest[k] !== undefined) out[k] = manifest[k];
  for (const k of Object.keys(manifest)) if (out[k] === undefined) out[k] = manifest[k];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
  return file;
}

export function readManifest(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function manifestPaths(dir, packName) {
  return {
    manifest: join(dir, `${packName}.json`),
    ids: join(dir, `${packName}-ids.json`),
  };
}

export function readIds(file) {
  return readManifest(file);
}

export function writeIds(file, ids) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ids, null, 1)}\n`, 'utf8');
  return file;
}
