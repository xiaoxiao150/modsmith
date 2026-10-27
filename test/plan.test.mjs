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
    have: { 'minecraft:beef': 2, 'minecraft:carrot': 1, 'minecraft:bowl': 1 },
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


test('箱子里的料也算：缺的先排 take，再照常做', () => {
  const r = planTarget(graph, {
    item: 'farm:beef_stew', count: 1, stations,
    have: { 'minecraft:beef': 2, 'farm:iron_knife': 1 },
    stock: { 'minecraft:carrot': 1, 'minecraft:potato': 1, 'minecraft:bowl': 1 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const skills = r.steps.map((s) => s.skill);
  assert.ok(skills.includes('take'), '缺的胡萝卜/马铃薯要从箱子取');
  assert.ok(skills.includes('cut'), '肉馅要从生牛肉切');
  assert.equal(skills[skills.length - 1], 'pot', '最后才是下锅');
});

test('工具在箱子里也能取出来用（刀）', () => {
  const r = planTarget(graph, {
    item: 'farm:minced_beef', count: 2, stations,
    have: { 'minecraft:beef': 1 },
    stock: { 'farm:diamond_knife': 1 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  assert.deepEqual(r.steps[0], { skill: 'take', item: 'farm:diamond_knife', count: 1 });
  assert.equal(r.steps[1].skill, 'cut');
});

test('成品本身就在箱子里：只排一步 take', () => {
  const r = planTarget(graph, {
    item: 'minecraft:torch', count: 2, stations, have: {}, stock: { 'minecraft:torch': 5 },
  });
  assert.equal(r.ok, true);
  // take 用短名（宿主的 take 认短名）：bare('minecraft:torch') = 'torch'
  assert.deepEqual(r.steps, [{ skill: 'take', item: 'torch', count: 2 }]);
});

test('箱子里也不够：缺口照实说（不是整单失败）', () => {
  const r = planTarget(graph, {
    item: 'farm:beef_stew', count: 1, stations,
    have: { 'minecraft:beef': 2, 'farm:iron_knife': 1, 'minecraft:bowl': 1 }, stock: {},
  });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => /carrot/.test(m.item + m.reason)), JSON.stringify(r.missing));
});

test('容器（碗）也算料：缺了先从箱子取，取不到如实报缺', () => {
  const withStock = planTarget(graph, {
    item: 'farm:beef_stew', count: 2, stations,
    have: { 'minecraft:beef': 4, 'farm:iron_knife': 1, 'minecraft:carrot': 2 },
    stock: { 'minecraft:bowl': 2 },
  });
  assert.equal(withStock.ok, true, JSON.stringify(withStock.missing));
  assert.ok(withStock.steps.some((s) => s.skill === 'take' && s.item === 'bowl'), JSON.stringify(withStock.steps));

  const without = planTarget(graph, {
    item: 'farm:beef_stew', count: 2, stations,
    have: { 'minecraft:beef': 4, 'farm:iron_knife': 1, 'minecraft:carrot': 2 },
  });
  assert.equal(without.ok, false);
  assert.ok(without.missing.some((m) => /bowl/.test(m.item)), JSON.stringify(without.missing));
});
