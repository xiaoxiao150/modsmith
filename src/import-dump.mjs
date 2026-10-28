/**
 * Registry dump → modsmith ids.
 *
 * `templates/registry-dump` 在服务端启动时把真实注册表写成 JSON：
 *   blocks: { "ns:id": [{ props, stateId }] }
 *   items:  { "ns:id": numericId }
 *
 * 这里只做**过滤与校验**：只留 manifest 声明的方块/物品，剔除落在 vanilla 区间里的
 * 可疑 stateId、跨方块重复的 stateId、以及 dump 里不存在的条目。不调 LLM、不连服务器。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { vanillaBlockStateCeiling } from './recipes-join.mjs';
import { fingerprintDir } from './server-fingerprint.mjs';

/**
 * @param {object} dump
 * @param {object} manifest
 * @param {{ceiling?: number}} [opts]
 */
export function idsFromDump(dump, manifest, opts = {}) {
  if (!dump || typeof dump !== 'object' || !dump.blocks || !dump.items) {
    throw new Error('dump 缺少 blocks/items；这不是 modsmith-dump 产出的文件？');
  }
  const ceiling = Number(opts.ceiling ?? vanillaBlockStateCeiling('1.21.1')) || 0;
  const blocks = {};
  const items = {};
  const failed = [];
  const seenState = new Map();

  for (const name of Object.keys(manifest.blocks ?? {})) {
    const raw = dump.blocks[name];
    if (!Array.isArray(raw) || raw.length === 0) {
      failed.push({ block: name, resp: 'dump 里没有这个方块（服务端未注册）' });
      continue;
    }
    const list = [];
    for (const entry of raw) {
      const stateId = Number(entry?.stateId);
      if (!Number.isInteger(stateId) || stateId <= 0) {
        failed.push({ block: name, props: entry?.props, resp: `stateId 非法：${entry?.stateId}` });
        continue;
      }
      if (ceiling > 0 && stateId <= ceiling) {
        failed.push({ block: name, props: entry?.props, resp: `stateId ${stateId} 落在 vanilla 区间（<= ${ceiling}）` });
        continue;
      }
      const owner = seenState.get(stateId);
      if (owner && owner !== name) {
        failed.push({ block: name, props: entry?.props, resp: `stateId ${stateId} 已被 ${owner} 占用` });
        continue;
      }
      seenState.set(stateId, name);
      list.push({ props: entry.props ?? {}, stateId });
    }
    if (list.length > 0) blocks[name] = list;
    else failed.push({ block: name, resp: '所有状态都被剔除' });
  }

  const seenItem = new Map();
  for (const name of Object.keys(manifest.items ?? {})) {
    const id = Number(dump.items[name]);
    if (!Number.isInteger(id) || id <= 0) {
      failed.push({ item: name, kind: 'unknown-item', resp: 'dump 里没有这个物品（服务端未注册）' });
      continue;
    }
    const owner = seenItem.get(id);
    if (owner && owner !== name) {
      failed.push({ item: name, resp: `物品 id ${id} 已被 ${owner} 占用` });
      continue;
    }
    seenItem.set(id, name);
    items[name] = id;
  }

  return { blocks, items, failed };
}

/**
 * @param {string} dumpPath
 * @param {string} manifestPath
 * @param {{idsPath?: string, serverMods?: string, mcv?: string}} [opts]
 */
export function importDump(dumpPath, manifestPath, opts = {}) {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const mcv = String(opts.mcv ?? '1.21.1');
  const ceiling = vanillaBlockStateCeiling(mcv);
  const { blocks, items, failed } = idsFromDump(dump, manifest, { ceiling });
  const ids = {
    mod: manifest.mod,
    version: manifest.version,
    measuredAt: new Date().toISOString(),
    method: 'registry-dump',
    blocks,
    items,
    failed,
  };
  if (opts.serverMods) {
    const fp = fingerprintDir(opts.serverMods);
    ids.serverMods = { fingerprint: fp.fingerprint, files: fp.files };
  }
  const out = opts.idsPath ?? manifestPath.replace(/\.json$/, '-ids.json');
  writeFileSync(out, `${JSON.stringify(ids, null, 1)}\n`);
  return { out, ids, failed };
}
