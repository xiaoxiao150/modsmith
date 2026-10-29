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
 * 1.21.1 原版实体 id 上限（0..129）。模组实体必然注册在原版之后，落在原版区间里的
 * 只可能是残留/坏 dump——收下就是给实体错名（错名比未知更糟）。
 */
const VANILLA_ENTITY_CEILING = 129;

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

  // 只收这个包自己命名空间的实体；boss 标记来自清单的 bosses（jar 里的 entity tag）
  const entities = {};
  const seenEntity = new Map();
  const ns = String(manifest.namespace ?? '');
  const bosses = new Set(manifest.bosses ?? []);
  for (const [name, raw] of Object.entries(dump.entities ?? {})) {
    if (!ns || !name.startsWith(`${ns}:`)) continue;
    // 0.1.2 起是 { id, spawnGroup, width, height }；更早的 dump 只有裸数字
    const id = Number(typeof raw === 'object' && raw !== null ? raw.id : raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (id <= VANILLA_ENTITY_CEILING) {
      failed.push({ entity: name, resp: `数字 id ${id} 落在原版实体区间（<= ${VANILLA_ENTITY_CEILING}）` });
      continue;
    }
    const owner = seenEntity.get(id);
    if (owner && owner !== name) continue;   // 数字 id 重复：先到先得，不猜
    seenEntity.set(id, name);
    const entry = { id };
    if (typeof raw === 'object' && raw !== null) {
      if (typeof raw.spawnGroup === 'string') entry.spawnGroup = raw.spawnGroup;
      if (Number.isFinite(raw.width)) entry.width = raw.width;
      if (Number.isFinite(raw.height)) entry.height = raw.height;
    }
    if (bosses.has(name)) entry.boss = true;
    entities[name] = entry;
  }

  return { blocks, items, entities, failed };
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
  const { blocks, items, entities, failed } = idsFromDump(dump, manifest, { ceiling });
  const ids = {
    mod: manifest.mod,
    version: manifest.version,
    measuredAt: new Date().toISOString(),
    method: 'registry-dump',
    blocks,
    items,
    entities,
    failed,
  };
  if (opts.serverMods) {
    const fp = fingerprintDir(opts.serverMods);
    ids.serverMods = { fingerprint: fp.fingerprint, files: fp.files };
  }
  const out = opts.idsPath ?? manifestPath.replace(/\.json$/, '-ids.json');
  writeFileSync(out, `${JSON.stringify(ids, null, 1)}\n`);
  return { out, ids, failed, hasEntities: Boolean(dump.entities && Object.keys(dump.entities).length > 0) };
}
