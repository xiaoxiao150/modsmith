// 消费视图：清单 → mineflayer 可消费的合成形状。接缝修复的契约测试。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { craftRecipeViews } from '../src/recipes-view.mjs';

const manifest = (recipes) => ({ mod: 'm', version: '1', recipes });

test('shaped：服务端 grid（[y][x] 行 × 候选数组）→ pattern/key，相同候选复用字符', () => {
  const views = craftRecipeViews(manifest([{
    id: 'minecraft:t',
    type: 'crafting_shaped',
    width: 2,
    height: 2,
    // join 已按行（y 外层）排好；每格是候选数组
    grid: [
      [[{ id: 'minecraft:oak_planks' }], [{ id: 'minecraft:oak_planks' }]],
      [[{ id: 'minecraft:oak_planks' }], []],
    ],
    result: { id: 'minecraft:crafting_table', count: 1 },
  }]));
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].pattern, ['AA', 'A ']);
  assert.deepEqual(views[0].key, { A: { id: 'minecraft:oak_planks' } });
  assert.deepEqual(views[0].result, { id: 'minecraft:crafting_table', count: 1 });
});

test('shaped：多候选格把候选数组原样放进 key（名字解析留给消费方）', () => {
  const views = craftRecipeViews(manifest([{
    id: 'x',
    type: 'crafting_shaped',
    grid: [[
      [{ id: 'minecraft:cod' }, { id: 'farmersdelight:cod_slice' }],
    ]],
    result: { id: 'minecraft:stick', count: 1 },
  }]));
  assert.deepEqual(views[0].key.A, [{ id: 'minecraft:cod' }, { id: 'farmersdelight:cod_slice' }]);
});

test('shaped：旧 jar 形状（pattern/key）原样透传', () => {
  const views = craftRecipeViews(manifest([{
    id: 'old', type: 'crafting_shaped',
    pattern: ['AB'], key: { A: { item: 'minecraft:oak_log' }, B: { tag: 'c:planks' } },
    result: { id: 'minecraft:stick', count: 4 },
  }]));
  assert.deepEqual(views[0].pattern, ['AB']);
  assert.deepEqual(views[0].key, { A: { item: 'minecraft:oak_log' }, B: { tag: 'c:planks' } });
  assert.equal(views[0].result.count, 4);
});

test('shapeless：每格统一成候选数组（旧形状单引用包成单元素）', () => {
  const views = craftRecipeViews(manifest([
    { id: 'new', type: 'crafting_shapeless', ingredients: [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]], result: { id: 'r', count: 1 } },
    { id: 'old', type: 'crafting_shapeless', ingredients: [{ item: 'a' }, { tag: 'c:x' }], result: { id: 'r', count: 1 } },
  ]));
  assert.deepEqual(views[0].ingredients, [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]]);
  assert.deepEqual(views[1].ingredients, [[{ item: 'a' }], [{ tag: 'c:x' }]]);
});

test('跳过 unsupported 与非合成类型（smelting/cooking 走厨锅技能，不进合成表）', () => {
  const views = craftRecipeViews(manifest([
    { id: 'a', type: 'crafting_special_armordye', unsupported: 'SimpleRecipeSerializer：无数据', raw: {} },
    { id: 'b', type: 'smelting', ingredients: [], result: { id: 'x', count: 1 } },
    { id: 'c', type: 'crafting_shapeless', ingredients: [[{ id: 'a' }]], result: { id: 'r', count: 1 } },
  ]));
  assert.deepEqual(views.map((v) => v.id), ['c']);
});

test('result 缺失或空位整行 → 不出视图（错名比未知更糟）', () => {
  const views = craftRecipeViews(manifest([
    { id: 'no-result', type: 'crafting_shapeless', ingredients: [[{ id: 'a' }]] },
    { id: 'empty-grid', type: 'crafting_shaped', grid: [[[]], [[]]], result: { id: 'r', count: 1 } },
  ]));
  assert.deepEqual(views, []);
});

test('result.count 缺省补 1，非法值也落 1', () => {
  const views = craftRecipeViews(manifest([
    { id: 'a', type: 'crafting_shapeless', ingredients: [[{ id: 'a' }]], result: { id: 'r' } },
    { id: 'b', type: 'crafting_shapeless', ingredients: [[{ id: 'a' }]], result: { id: 'r', count: 0 } },
  ]));
  assert.equal(views[0].result.count, 1);
  assert.equal(views[1].result.count, 1);
});
