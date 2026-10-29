/**
 * import-dump：注册表 dump → ids 的过滤与校验（纯函数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idsFromDump, importDump } from '../src/import-dump.mjs';

const manifest = {
  mod: 'TestMod',
  version: '1.0',
  blocks: {
    'test:lamp': { states: [] },
    'test:vanilla_ghost': {},
  },
  items: {
    'test:lamp': {},
    'test:missing': {},
  },
};

const dump = {
  blocks: {
    'test:lamp': [{ props: { lit: 'true' }, stateId: 40000 }, { props: { lit: 'false' }, stateId: 40001 }],
    // 这个 stateId 落在 vanilla 区间：只能是残留读数，不能收
    'test:vanilla_ghost': [{ props: {}, stateId: 1234 }],
  },
  items: {
    'test:lamp': 900,
  },
};

test('只保留 manifest 声明的方块/物品，剔除 vanilla 区间与 dump 缺失项', () => {
  const r = idsFromDump(dump, manifest, { ceiling: 26683 });
  assert.deepEqual(r.blocks, {
    'test:lamp': [
      { props: { lit: 'true' }, stateId: 40000 },
      { props: { lit: 'false' }, stateId: 40001 },
    ],
  });
  assert.deepEqual(r.items, { 'test:lamp': 900 });
  assert.ok(r.failed.some((f) => f.block === 'test:vanilla_ghost' && String(f.resp).includes('vanilla')));
  assert.ok(r.failed.some((f) => f.item === 'test:missing'));
});

test('跨方块重复的 stateId 只让先出现的认领', () => {
  const dup = {
    blocks: {
      'test:lamp': [{ props: {}, stateId: 40000 }],
    },
    items: {},
  };
  const m = { blocks: { 'test:lamp': {}, 'test:lamp2': {} }, items: {} };
  const d = { blocks: { ...dup.blocks, 'test:lamp2': [{ props: {}, stateId: 40000 }] }, items: {} };
  const r = idsFromDump(d, m, { ceiling: 26683 });
  assert.deepEqual(Object.keys(r.blocks), ['test:lamp']);
  assert.ok(r.failed.some((f) => f.block === 'test:lamp2' && String(f.resp).includes('40000')));
});

test('实体：只收本命名空间，boss 来自清单，随 dump 带碰撞箱与生成组', () => {
  const m = { namespace: 'test', blocks: {}, items: {}, bosses: ['test:naga'] };
  const d = {
    blocks: {},
    items: {},
    entities: {
      'test:naga': { id: 158, spawnGroup: 'monster', width: 1.2, height: 2.5 },
      'test:critter': { id: 159, spawnGroup: 'creature', width: 0.5, height: 0.5 },
      'minecraft:zombie': { id: 124, spawnGroup: 'monster', width: 0.6, height: 1.95 },
    },
  };
  const r = idsFromDump(d, m, { ceiling: 26683 });
  assert.deepEqual(r.entities, {
    'test:naga': { id: 158, spawnGroup: 'monster', width: 1.2, height: 2.5, boss: true },
    'test:critter': { id: 159, spawnGroup: 'creature', width: 0.5, height: 0.5 },
  });
});

test('实体：0.1.1 的裸数字 dump 仍能导入，重复 id 不猜', () => {
  const m = { namespace: 'test', blocks: {}, items: {}, bosses: ['test:naga'] };
  const d = {
    blocks: {},
    items: {},
    entities: { 'test:naga': 158, 'test:other': 158 },
  };
  const r = idsFromDump(d, m, { ceiling: 26683 });
  assert.deepEqual(r.entities, { 'test:naga': { id: 158, boss: true } });
});

test('没有 entities 的老 dump：方块/物品照收，实体表为空', () => {
  const r = idsFromDump(dump, manifest, { ceiling: 26683 });
  assert.deepEqual(r.entities, {});
});

test('实体 id 落在原版区间（<=129）一律剔除：那是残留，不是模组实体', () => {
  const m = { namespace: 'test', blocks: {}, items: {} };
  const d = {
    blocks: {},
    items: {},
    entities: { 'test:fake': { id: 100, spawnGroup: 'monster' }, 'test:real': { id: 130 } },
  };
  const r = idsFromDump(d, m, { ceiling: 26683 });
  assert.deepEqual(Object.keys(r.entities), ['test:real']);
  assert.ok(r.failed.some((f) => f.entity === 'test:fake' && String(f.resp).includes('原版实体区间')));
});

test('接缝：dump 落盘 → ids → 注入后模组 boss 有名字且算敌对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-dump-'));
  try {
    const manifestPath = join(dir, 'm.json');
    const dumpPath = join(dir, 'dump.json');
    const idsPath = join(dir, 'm-ids.json');
    writeFileSync(manifestPath, JSON.stringify({
      mod: 'm', version: '1.0', namespace: 'm', blocks: {}, items: {},
      bosses: ['m:naga'],
      names: { 'entity.naga': { zh: '纳迦' } },
    }));
    writeFileSync(dumpPath, JSON.stringify({
      blocks: {}, items: {},
      entities: { 'm:naga': { id: 158, spawnGroup: 'monster', width: 1.2, height: 2.5 } },
    }));
    const result = importDump(dumpPath, manifestPath, { idsPath, mcv: '1.21.1' });
    assert.equal(result.hasEntities, true);
    const ids = JSON.parse(readFileSync(idsPath, 'utf8'));
    assert.deepEqual(ids.entities['m:naga'], { id: 158, spawnGroup: 'monster', width: 1.2, height: 2.5, boss: true });

    const { installModRegistry } = await import('../src/cortico-bridge.mjs');
    const reg = {
      blocks: {}, blocksByName: {}, blocksArray: [], blocksByStateId: {},
      blockCollisionShapes: { shapes: {}, blocks: {} },
      items: {}, itemsByName: {}, itemsArray: [], foodsByName: {},
      entities: {}, entitiesByName: {}, entitiesArray: [],
    };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const counts = installModRegistry({ registry: reg }, { manifest, ids });
    assert.equal(counts.entities, 1);
    assert.equal(reg.entitiesByName['m:naga'].displayName, '纳迦');
    assert.equal(reg.entitiesByName['m:naga'].boss, true);
    assert.equal(reg.entitiesByName['m:naga'].type, 'hostile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
