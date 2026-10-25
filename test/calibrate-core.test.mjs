// calibrate 的纯函数判据：放置补测嫌疑、stateId 两遍认领去重、去重记账。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSuspects, dedupeStateIds, dedupReport, dropVanillaStateIds, sampleOf } from '../src/calibrate-core.mjs';

// ---------- sampleOf ----------

test('sampleOf：均匀抽样且首尾覆盖，不比 n 长就原样返回', () => {
  assert.deepEqual(sampleOf(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3), ['a', 'd', 'g']);
  assert.deepEqual(sampleOf(['a', 'b'], 3), ['a', 'b']);
  assert.deepEqual(sampleOf([], 3), []);
});

// ---------- computeSuspects ----------

test('suspects：不同 id 数少于声明状态数才算，单状态与量全的都不算', () => {
  const manifestBlocks = {
    'm:full': { states: [{ age: '0' }, { age: '1' }] },
    'm:single': { states: [{}] },
    'm:collapsed': { states: [{ age: '0' }, { age: '1' }, { age: '2' }, { age: '3' }] },
  };
  const idsBlocks = {
    'm:full': [{ props: { age: '0' }, stateId: 10 }, { props: { age: '1' }, stateId: 11 }],
    'm:single': [{ props: {}, stateId: 30 }],
    'm:collapsed': [{ props: { age: '0' }, stateId: 20 }, { props: { age: '1' }, stateId: 20 }],
  };
  assert.deepEqual(computeSuspects(idsBlocks, manifestBlocks), [
    { name: 'm:collapsed', distinct: 1, declared: 4 },
  ]);
});

test('suspects：半塌也抓得到（12 个状态只量到 8 个）', () => {
  const declared = Array.from({ length: 12 }, (_, i) => ({ support: String(i % 2) }));
  const list = Array.from({ length: 8 }, (_, i) => ({ props: {}, stateId: 100 + i }));
  assert.deepEqual(
    computeSuspects({ 'm:pot': list }, { 'm:pot': { states: declared } }),
    [{ name: 'm:pot', distinct: 8, declared: 12 }],
  );
});

test('suspects：块内重复不虚增状态数——判据数的是 Set，重复条目骗不了它', () => {
  // 生产数据的形状：rope 6 个状态全读到同一个残留 id，列了 6 条
  const idsBlocks = {
    'm:rope': Array.from({ length: 6 }, () => ({ props: {}, stateId: 26867 })),
  };
  const manifestBlocks = {
    'm:rope': { states: Array.from({ length: 6 }, (_, i) => ({ part: String(i) })) },
  };
  assert.deepEqual(computeSuspects(idsBlocks, manifestBlocks), [
    { name: 'm:rope', distinct: 1, declared: 6 },
  ]);
});

test('suspects：清单里没有的方块跳过（declared 为 0）', () => {
  assert.deepEqual(computeSuspects({ 'm:ghost': [{ props: {}, stateId: 1 }] }, {}), []);
});

// ---------- dedupeStateIds ----------

test('两遍认领：真实放置量到的 id 越过声明顺序先认领', () => {
  // a 声明在前但量到的是残留值；b 的真身是真实放置量到的 —— 冲突时 b 赢
  const blocks = {
    'm:a': [{ props: {}, stateId: 100 }],
    'm:b': [{ props: {}, stateId: 100, note: '真实放置校准' }],
  };
  const r = dedupeStateIds(blocks, ['m:a', 'm:b']);
  assert.deepEqual(r.blocks['m:b'], [{ props: {}, stateId: 100, note: '真实放置校准' }]);
  assert.equal('m:a' in r.blocks, false);
  assert.deepEqual(r.dupDropped, [{ block: 'm:a', stateId: 100, owner: 'm:b' }]);
  assert.deepEqual(r.sameBlockDropped, []);
});

test('两遍认领：同为 setblock 量到的，先声明者得', () => {
  const blocks = {
    'm:a': [{ props: {}, stateId: 100 }],
    'm:b': [{ props: {}, stateId: 100 }],
  };
  const r = dedupeStateIds(blocks, ['m:a', 'm:b']);
  assert.deepEqual(r.blocks['m:a'], [{ props: {}, stateId: 100 }]);
  assert.equal('m:b' in r.blocks, false);
  assert.deepEqual(r.dupDropped, [{ block: 'm:b', stateId: 100, owner: 'm:a' }]);
});

test('块内重复收进 sameBlockDropped，不算跨方块冲突', () => {
  // 生产数据的形状：rope 6 条全是 26867，留下 1 条、丢 5 条
  const blocks = {
    'm:rope': Array.from({ length: 6 }, (_, i) => ({ props: { part: String(i) }, stateId: 26867 })),
  };
  const r = dedupeStateIds(blocks, ['m:rope']);
  assert.equal(r.blocks['m:rope'].length, 1);
  assert.equal(r.blocks['m:rope'][0].props.part, '0');
  assert.equal(r.sameBlockDropped.length, 5);
  assert.deepEqual(r.sameBlockDropped[0], { block: 'm:rope', stateId: 26867 });
  assert.deepEqual(r.dupDropped, []);
});

test('stateId 无效的条目直接丢弃，全空的方块从结果里消失', () => {
  const blocks = {
    'm:a': [{ props: {}, stateId: 0 }, { props: {}, stateId: 5 }],
    'm:b': [{ props: {}, stateId: 0 }],
  };
  const r = dedupeStateIds(blocks, ['m:a', 'm:b']);
  assert.deepEqual(r.blocks['m:a'], [{ props: {}, stateId: 5 }]);
  assert.equal('m:b' in r.blocks, false);
});

test('纯函数：不改入参', () => {
  const blocks = {
    'm:a': [{ props: {}, stateId: 1 }, { props: {}, stateId: 1 }],
    'm:b': [{ props: {}, stateId: 1, note: '真实放置校准' }],
  };
  const snapshot = JSON.stringify(blocks);
  dedupeStateIds(blocks, ['m:a', 'm:b']);
  assert.equal(JSON.stringify(blocks), snapshot);
});

// ---------- dedupReport ----------

test('记账：跨方块与块内重复分开报，failed 条数与报告数字一致', () => {
  const { lines, failed } = dedupReport(
    [
      { block: 'm:a', stateId: 100, owner: 'm:b' },
      { block: 'm:c', stateId: 101, owner: 'm:b' },
    ],
    [{ block: 'm:d', stateId: 7 }],
  );
  assert.match(lines[0], /去重：2 条重复 stateId/);
  assert.match(lines[1], /m:a 的 100 其实属于 m:b/);
  assert.match(lines[2], /m:c 的 101 其实属于 m:b/);
  assert.match(lines[3], /块内重复 1 条/);
  assert.deepEqual(failed, [
    { block: 'm:a', kind: 'duplicate-state', resp: 'stateId 100 已归 m:b' },
    { block: 'm:c', kind: 'duplicate-state', resp: 'stateId 101 已归 m:b' },
    { block: 'm:d', kind: 'duplicate-in-block', resp: 'stateId 7 在同一方块内重复' },
  ]);
});

test('记账：没有丢弃就没有行、没有 failed 条目', () => {
  assert.deepEqual(dedupReport([], []), { lines: [], failed: [] });
});

// ---------- dropVanillaStateIds ----------

test('落在 vanilla 区间里的 stateId 一律剔除（mod 方块必然排在 vanilla 之后）', () => {
  const blocks = {
    'm:good': [{ props: {}, stateId: 30000 }, { props: { a: '1' }, stateId: 30001 }],
    'm:mixed': [{ props: {}, stateId: 13344 }, { props: { a: '1' }, stateId: 31000 }],
    'm:allbad': [{ props: {}, stateId: 46160 }].map((s) => ({ ...s, stateId: 900 })),
  };
  const { blocks: kept, dropped } = dropVanillaStateIds(blocks, 26683);
  assert.deepEqual(Object.keys(kept).sort(), ['m:good', 'm:mixed']);
  assert.deepEqual(kept['m:mixed'].map((s) => s.stateId), [31000]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.some((d) => d.block === 'm:allbad' && d.stateId === 900));
  assert.ok(!('m:allbad' in kept), '整块都落在 vanilla 区间 → 整块丢弃（未知好过错名）');
});

test('没有落进 vanilla 区间的数据原样保留（不误伤）', () => {
  const blocks = { 'm:a': [{ props: {}, stateId: 30000 }] };
  const snapshot = JSON.stringify(blocks);
  const { blocks: kept, dropped } = dropVanillaStateIds(blocks, 26683);
  assert.equal(JSON.stringify(kept), snapshot);
  assert.equal(dropped.length, 0);
});
