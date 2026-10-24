// declare_recipes 解析器与翻转：字节级构造 + 真实形状断言，不连服务器。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeclareRecipes, RecipeParseError, VANILLA_SERIALIZERS } from '../src/recipes.mjs';
import { joinRecipes } from '../src/recipes-join.mjs';

// ---------- 字节构造工具（varint / string / slot）----------

function varint(v) {
  const out = [];
  let x = v >>> 0;
  for (;;) {
    const b = x & 0x7f;
    x >>>= 7;
    if (x === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return out;
}
const str = (s) => [...varint(Buffer.byteLength(s)), ...Buffer.from(s, 'utf8')];
/** Slot：count=0 空槽；非空 [count, itemId, 0, 0]（无组件）。 */
const emptySlot = () => [0];
const slot = (id, count = 1) => [...varint(count), ...varint(id), 0, 0];
const ingredient = (ids) => [...varint(ids.length), ...ids.flatMap((id) => (id === 0 ? emptySlot() : slot(id)))];

/** 帧 = [包号, 条数, 每条 [name, typeId, payload...]]。 */
function frameOf(...entries) {
  const body = [];
  for (const [name, typeId, payload] of entries) {
    body.push(...str(name), ...varint(typeId), ...payload);
  }
  return Buffer.from([0x77, ...varint(entries.length), ...body]);
}

/** shapeless 的 ingredients 字段：[M, M × ingredient]（外层条数 + 每条自己的候选表）。 */
const ingredients = (ings) => [...varint(ings.length), ...ings.flatMap((ids) => ingredient(ids))];

// ---------- 解析 ----------

test('shapeless：group/category/ingredients/result 全解析，整包对齐', () => {
  // yellow_dye_from_dandelion 的形状：group="yellow_dye"，category=3，1 原料，result
  const payload = [...str('yellow_dye'), 3, ...ingredients([[988]]), ...slot(948, 2)];
  const r = parseDeclareRecipes(frameOf(['minecraft:yellow_dye_from_dandelion', 1, payload]));
  assert.equal(r.recipes.length, 1);
  const rec = r.recipes[0];
  assert.equal(rec.type, 'minecraft:crafting_shapeless');
  assert.deepEqual(rec.data, { group: 'yellow_dye', category: 3, ingredients: [[988]], result: { id: 948, count: 2 } });
});

test('shaped：grid 按行优先读（wire 是 [行][列]；3×2 不对称才能验证）', () => {
  // 宽 3 高 2：wire = row0 三个 + row1 三个（用 cutting_board 的真实字节核实过）
  const payload = [
    ...str(''), 0, ...varint(3), ...varint(2),
    ...[11, 12, 13, 21, 22, 23].flatMap((c) => ingredient([c])),
    ...slot(99), 1,
  ];
  const r = parseDeclareRecipes(frameOf(['minecraft:t', 0, payload]));
  assert.deepEqual(r.recipes[0].data.gridWidth, 3);
  assert.deepEqual(r.recipes[0].data.gridHeight, 2);
  assert.deepEqual(r.recipes[0].data.grid, [[[11], [12], [13]], [[21], [22], [23]]]);
});

test('smelting：experience 是大端 f32（网络数值字段），cookTime varint', () => {
  const exp1 = [...Buffer.from([0x3f, 0x80, 0x00, 0x00])];   // 1.0f BE
  const payload = [...str(''), 0, ...ingredient([500]), ...slot(600), ...exp1, ...varint(200)];
  const r = parseDeclareRecipes(frameOf(['minecraft:x', 15, payload]));
  assert.equal(r.recipes[0].data.experience, 1);
  assert.equal(r.recipes[0].data.cookTime, 200);
});

test('自定义类型走 sidesheets 文法；ChanceResult 的 [slot,f32] list', () => {
  // cutting：group, ingredient, ingredient(tool), n×[slot,f32], optional-id(false)
  const chance = [...Buffer.from([0x3f, 0x80, 0x00, 0x00])];
  const payload = [
    ...str(''), ...ingredient([988]), ...ingredient([1404, 1405]),
    ...varint(1), ...slot(1440, 2), ...chance,
    0,
  ];
  const serializers = {
    24: { name: 'farmersdelight:cutting', fields: [
      { name: 'group', kind: 'string' },
      { name: 'ingredient', kind: 'ingredient' },
      { name: 'tool', kind: 'ingredient' },
      { name: 'results', kind: 'list', item: [{ name: 'result', kind: 'slot' }, { name: 'chance', kind: 'f32' }] },
      { name: 'sound', kind: 'optional-identifier' },
    ] },
  };
  const r = parseDeclareRecipes(frameOf(['farmersdelight:cutting/beef', 24, payload]), { serializers });
  const rec = r.recipes[0];
  assert.deepEqual(rec.data.ingredient, [988]);
  assert.deepEqual(rec.data.tool, [1404, 1405]);
  assert.deepEqual(rec.data.results, [{ result: { id: 1440, count: 2 }, chance: 1 }]);
  assert.equal(rec.data.sound, null);
  assert.deepEqual(r.customTypes, [24]);
});

test('未知编号没文法 → 拒绝整包并报配方名', () => {
  const payload = [0, 0, 0];
  assert.throws(
    () => parseDeclareRecipes(frameOf(['farmersdelight:x', 99, payload])),
    (e) => e instanceof RecipeParseError && /未知序列化器编号 99.*farmersdelight:x/.test(e.message),
  );
});

test('残包（payload 多出字节）→ 拒绝，绝不出半份', () => {
  const payload = [...str(''), 0, ...ingredients([[1]]), ...slot(2), 0, 0xff, 0xff];
  assert.throws(
    () => parseDeclareRecipes(frameOf(['minecraft:x', 1, payload])),
    (e) => e instanceof RecipeParseError && /还剩 \d+ 字节/.test(e.message),
  );
});

test('Slot 带组件 → 拒绝（组件载荷按类型各异，无法盲读）', () => {
  const payload = [...str(''), 0, ...[1, ...varint(42), 1, 0, 0x3f], ...slot(2), 0];
  // ingredient: m=1, slot: count=1, id=42, added=1(带组件), removed=0, 后面是垃圾
  assert.throws(
    () => parseDeclareRecipes(frameOf(['minecraft:x', 1, payload])),
    (e) => /带组件/.test(e.message),
  );
});

// ---------- join ----------

const VANILLA = { 988: 'minecraft:beef', 948: 'minecraft:yellow_dye' };
const MOD = { 'farmersdelight:minced_beef': 1440, 'farmersdelight:flint_knife': 1404 };

test('join：数字 id 翻成物品名，vanilla 与 mod 表合用', () => {
  const parsed = [
    { name: 'minecraft:y', type: 'minecraft:crafting_shapeless', typeId: 1,
      data: { group: 'g', category: 3, ingredients: [[988]], result: { id: 948, count: 2 } } },
  ];
  const { entries, unresolved } = joinRecipes(parsed, MOD, VANILLA);
  assert.equal(unresolved.length, 0);
  assert.deepEqual(entries[0].ingredients, [[{ id: 'minecraft:beef' }]]);
  assert.deepEqual(entries[0].result, { id: 'minecraft:yellow_dye', count: 2 });
  assert.equal(entries[0]._source, 'server');
});

test('join：翻不出的条目进 unresolved，不出错名', () => {
  const parsed = [
    { name: 'x', type: 'minecraft:crafting_shapeless', typeId: 1,
      data: { ingredients: [[99999]], result: { id: 948, count: 2 } } },
  ];
  const { entries, unresolved } = joinRecipes(parsed, MOD, VANILLA);
  assert.equal(entries.length, 0);
  assert.deepEqual(unresolved, ['x']);
});

test('join：shaped 的 grid 原样保留（parser 已行优先，不再转置）', () => {
  const parsed = [{
    name: 's', type: 'minecraft:crafting_shaped', typeId: 0,
    data: { gridWidth: 2, gridHeight: 2, grid: [[[988], [948]], [[948], [948]]], result: { id: 948, count: 2 } },
  }];
  const { entries } = joinRecipes(parsed, MOD, VANILLA);
  assert.deepEqual(entries[0].grid, [
    [[{ id: 'minecraft:beef' }], [{ id: 'minecraft:yellow_dye' }]],
    [[{ id: 'minecraft:yellow_dye' }], [{ id: 'minecraft:yellow_dye' }]],
  ]);
});

test('vanilla 22 种序列化器全部带名且编号连续', () => {
  for (let i = 0; i <= 22; i++) {
    const s = VANILLA_SERIALIZERS[i];
    assert.ok(s, `编号 ${i} 缺失`);
    assert.ok(s.name.startsWith('minecraft:'));
    for (const f of s.fields) assert.equal(typeof f.name, 'string', `${s.name} 有无名字段`);
  }
});

// ---------- 数量 / 去重 / 噪声 / unsupported（接缝修复回归） ----------

test('join：result.count 保留产物数量（一根木头 4 根木棍）', () => {
  const parsed = [{
    name: 'minecraft:stick', type: 'minecraft:crafting_shaped', typeId: 0,
    data: {
      gridWidth: 1, gridHeight: 2,
      grid: [[[988]], [[988]]],
      result: { id: 948, count: 4 },
    },
  }];
  const { entries } = joinRecipes(parsed, MOD, VANILLA);
  assert.deepEqual(entries[0].result, { id: 'minecraft:yellow_dye', count: 4 });
});

test('join：候选去重保序（嵌套 tag 在服务端会重复展开，实测两遍）', () => {
  const parsed = [{
    name: 'farmersdelight:cutting/beef', type: 'farmersdelight:cutting', typeId: 24,
    data: {
      ingredient: [988],
      tool: [1404, 1405, 1404, 1405],   // 服务端确实发了两遍
      results: [{ result: { id: 1440, count: 2 }, chance: 1 }],
      sound: null,
    },
  }];
  const { entries } = joinRecipes(parsed, { ...MOD, 'farmersdelight:iron_knife': 1405 }, VANILLA);
  assert.deepEqual(entries[0].tool, [
    { id: 'farmersdelight:flint_knife' },
    { id: 'farmersdelight:iron_knife' },
  ], '重复的刀要去掉，顺序保持首次出现');
  assert.deepEqual(entries[0].results, [{ id: 'farmersdelight:minced_beef', count: 2, chance: 1 }]);
});

test('join：f32 噪声 round 到 3 位（0.20000000298023224 → 0.2）', () => {
  const parsed = [{
    name: 'minecraft:x', type: 'minecraft:smelting', typeId: 15,
    data: { ingredient: [988], result: { id: 948, count: 1 }, experience: 0.20000000298023224, cookTime: 200 },
  }];
  const { entries } = joinRecipes(parsed, MOD, VANILLA);
  assert.equal(entries[0].experience, 0.2);
});

test('join：SimpleRecipeSerializer 条目标 unsupported，不再混进可消费计数', () => {
  const parsed = [
    { name: 'farmersdelight:wheat_dough_from_water', type: 'farmersdelight:dough', typeId: 26, data: { category: 3 } },
    { name: 'minecraft:armordye', type: 'minecraft:crafting_special_armordye', typeId: 2, data: { category: 0 } },
  ];
  const { entries } = joinRecipes(parsed, MOD, VANILLA);
  for (const e of entries) {
    assert.match(e.unsupported, /SimpleRecipeSerializer/);
    assert.equal(e.result, undefined);
  }
});
