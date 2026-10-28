/**
 * import-dump：注册表 dump → ids 的过滤与校验（纯函数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idsFromDump } from '../src/import-dump.mjs';

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
