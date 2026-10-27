/**
 * 配方依赖图 + 目标规划（纯函数）。
 *
 * 用合成清单钉住行为，不依赖本机路径/真实 mod：形状照服务端真值写
 * （cooking 有 container，cutting 有 tool + results[]，合成是 grid）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipeGraph, planTarget } from '../src/plan.mjs';

const manifest = {
  mod: 'farm', namespace: 'farm',
  blocks: {},
  items: {},
  stations: [
    { id: 'pot', kind: 'sidecar-recipe', block: 'farm:pot', recipeType: 'farm:cooking' },
    { id: 'board', kind: 'two-step-use', block: 'farm:board', recipeType: 'farm:cutting' },
  ],
  recipes: [
    {
      id: 'farm:cooking/beef_stew', type: 'farm:cooking',
      ingredients: [[{ id: 'minecraft:beef' }], [{ id: 'farm:minced_beef' }], [{ id: 'minecraft:carrot' }]],
      result: { id: 'farm:beef_stew', count: 1 },
      container: { id: 'minecraft:bowl', count: 1 },
    },
    {
      id: 'farm:cutting/beef', type: 'farm:cutting',
      ingredients: [{ id: 'minecraft:beef' }],
      tool: [{ id: 'farm:iron_knife' }, { id: 'farm:diamond_knife' }],
      results: [{ id: 'farm:minced_beef', count: 2, chance: 1 }],
    },
    {
      id: 'minecraft:torch', type: 'crafting_shaped',
      grid: [[[{ id: 'minecraft:coal' }]], [[{ id: 'minecraft:stick' }]]],
      result: { id: 'minecraft:torch', count: 4 },
    },
    {
      id: 'farm:a', type: 'crafting_shapeless',
      ingredients: [[{ id: 'farm:b' }]],
      result: { id: 'farm:a', count: 1 },
    },
    {
      id: 'farm:b', type: 'crafting_shapeless',
      ingredients: [[{ id: 'farm:a' }]],
      result: { id: 'farm:b', count: 1 },
    },
  ],
};

const graph = buildRecipeGraph(manifest);
const stations = manifest.stations;

test('牛肉炖：先切牛肉、再下锅，材料齐时不报缺口', () => {
  const r = planTarget(graph, {
    item: 'farm:beef_stew', count: 1, stations,
    have: { 'minecraft:beef': 2, 'minecraft:carrot': 1, 'farm:iron_knife': 1, 'minecraft:bowl': 1 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  assert.deepEqual(r.steps, [
    { skill: 'cut', items: ['minecraft:beef'], count: 1 },
    { skill: 'pot', recipe: 'farm:cooking/beef_stew', count: 1 },
  ]);
});

test('没有刀：缺口指到工具，不排步骤', () => {
  const r = planTarget(graph, {
    item: 'farm:beef_stew', count: 1, stations,
    have: { 'minecraft:beef': 2, 'minecraft:carrot': 1 },
  });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.item === 'farm:iron_knife' && /工具/.test(m.reason)), JSON.stringify(r.missing));
});

test('没有站点：缺口说清楚是站点，不是材料', () => {
  const r = planTarget(graph, {
    item: 'farm:beef_stew', count: 1, stations: [],
    have: { 'minecraft:beef': 2, 'minecraft:carrot': 1, 'farm:iron_knife': 1 },
  });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => /站点/.test(m.reason)), JSON.stringify(r.missing));
});

test('合成配方按产出数量算批数（火把 4 个/批）', () => {
  const one = planTarget(graph, { item: 'minecraft:torch', count: 1, stations, have: { 'minecraft:coal': 1, 'minecraft:stick': 1 } });
  assert.deepEqual(one.steps, [{ skill: 'craft', item: 'minecraft:torch', count: 1 }]);
  const five = planTarget(graph, { item: 'minecraft:torch', count: 5, stations, have: { 'minecraft:coal': 9, 'minecraft:stick': 9 } });
  assert.deepEqual(five.steps, [{ skill: 'craft', item: 'minecraft:torch', count: 2 }], '5 个要两批（每批 4）');
});

test('已经够的东西不排步骤', () => {
  const r = planTarget(graph, { item: 'minecraft:beef', count: 2, stations, have: { 'minecraft:beef': 3 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps, []);
});

test('配方循环不会死循环，缺口写明白', () => {
  const r = planTarget(graph, { item: 'farm:a', count: 1, stations, have: {} });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => /循环/.test(m.reason)), JSON.stringify(r.missing));
});
