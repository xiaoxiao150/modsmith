/**
 * recipes --discover 的文法搜索测试。
 *
 * 不连服务器：合成 declare_recipes 帧（已知 vanilla 类型 + 未知类型 + 隐藏文法），
 * 断言 discover 能把文法搜回来、歧义时列出多个候选不擅断、物品 id 不合理时毙掉。
 * 字节写入器与 recipes.mjs 的读取器一一对应（varint/string/slot/ingredient/f32）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSerializers, SHAPES } from '../src/recipes-discover.mjs';
import { parseDeclareRecipes } from '../src/recipes.mjs';

// ---- 字节写入器（与 wire 格式一一对应） ----

const wv = (v) => {
  const bytes = [];
  let x = v >>> 0;
  for (;;) {
    let b = x & 0x7f;
    x >>>= 7;
    if (x !== 0) b |= 0x80;
    bytes.push(b);
    if (x === 0) break;
  }
  return Buffer.from(bytes);
};
const ws = (s) => {
  const u = Buffer.from(s, 'utf8');
  return Buffer.concat([wv(u.length), u]);
};
const wslot = (id, count = 1) => (count === 0 ? wv(0) : Buffer.concat([wv(count), wv(id), wv(0), wv(0)]));
const wing = (ids) => Buffer.concat([wv(ids.length), ...ids.map((id) => wslot(id))]);
const wings = (groups) => Buffer.concat([wv(groups.length), ...groups.map(wing)]);
const wf32 = (f) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(f, 0);
  return b;
};

/** vanilla smelting (15) / stonecutting (19) 的 payload，按内置文法写。 */
const smeltingPayload = ({ group = 'test', category = 0, ids = [100], result = 110, xp = 0.7, time = 200 }) =>
  Buffer.concat([ws(group), wv(category), wing(ids), wslot(result), wf32(xp), wv(time)]);
const stonecuttingPayload = ({ group = 'test', ids = [101], result = 111 }) =>
  Buffer.concat([ws(group), wing(ids), wslot(result)]);

/** FD cooking 形的隐藏文法（未知 typeId 的 payload）。 */
const cookingPayload = ({ group = 'test', category = 'stuff', groups = [[100], [101, 102]], result = 110, container = 103, xp = 0.35, time = 400 }) =>
  Buffer.concat([ws(group), ws(category), wings(groups), wslot(result), wslot(container), wf32(xp), wv(time)]);

function frame(recipes) {
  const head = Buffer.concat([wv(0), wv(recipes.length)]);
  const body = recipes.map((r) => Buffer.concat([ws(r.name), wv(r.typeId), r.payload]));
  return Buffer.concat([head, ...body]);
}

const KNOWN_IDS = new Set([100, 101, 102, 103, 110, 111]);
const OPTS = { knownItemIds: KNOWN_IDS, maxItemId: 111 };

test('形状库命中：未知类型的 cooking 形文法被完整找回（含语义字段名）', () => {
  const buf = frame([
    { name: 'test:a', typeId: 15, payload: smeltingPayload({}) },
    { name: 'test:b', typeId: 15, payload: smeltingPayload({ ids: [101], result: 110, xp: 1.0, time: 100 }) },
    { name: 'testmod:cooking/stew', typeId: 30, payload: cookingPayload({}) },
    { name: 'testmod:cooking/soup', typeId: 30, payload: cookingPayload({ groups: [[102]], result: 111, container: 100, xp: 0.5, time: 600 }) },
    { name: 'testmod:cooking/juice', typeId: 30, payload: cookingPayload({ groups: [[100], [101]], result: 110, container: 0, xp: 0.1, time: 50 }) },
    { name: 'test:c', typeId: 19, payload: stonecuttingPayload({}) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  assert.equal(result.ok, true, `应走通整包：${result.notes.join('；')}`);
  const d = result.discovered.find((x) => x.typeId === 30);
  assert.ok(d, '应发现 #30');
  assert.equal(d.shape, 'cooking-like');
  assert.equal(d.packetValidated, true);
  assert.deepEqual(
    d.fields.map((f) => f.kind),
    ['string', 'string', 'ingredients', 'slot', 'slot', 'f32', 'varint'],
  );
  assert.deepEqual(d.fields.map((f) => f.name), ['group', 'category', 'ingredients', 'result', 'container', 'experience', 'cookTime']);
  assert.equal(d.occurrences, 3);
  // 段划分：3 条已知各一段 + 未知类型一整段（3 条出现记 1 段）
  assert.equal(result.segments.length, 4);
  const runSeg = result.segments.find((s) => !s.known);
  assert.equal(runSeg.typeId, 30);
  assert.equal(runSeg.occurrences, 3);
});

test('发现结果直接喂回 parseDeclareRecipes 能整包解析（discover→parse 闭环）', () => {
  const buf = frame([
    { name: 'testmod:cooking/stew', typeId: 30, payload: cookingPayload({}) },
    { name: 'testmod:cooking/soup', typeId: 30, payload: cookingPayload({ groups: [[102]], result: 111, time: 600 }) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  assert.equal(result.ok, true, result.notes.join('；'));
  const d = result.discovered[0];
  const parsed = parseDeclareRecipes(buf, {
    serializers: { 30: { name: 'testmod:cooking', fields: d.fields } },
  });
  assert.equal(parsed.recipes.length, 2);
  const stew = parsed.recipes[0];
  assert.equal(stew.type, 'testmod:cooking');
  assert.deepEqual(stew.data.result, { id: 110, count: 1 });
  assert.deepEqual(stew.data.ingredients, [[100], [101, 102]]);
  assert.equal(stew.data.cookTime, 400);
});

test('歧义不擅断：单字节 payload 有多个能对齐的候选，全部列出', () => {
  const buf = frame([
    { name: 'test:x1', typeId: 31, payload: wv(3) },
    { name: 'test:x2', typeId: 31, payload: wv(3) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  assert.equal(result.ok, true, result.notes.join('；'));
  const cands = result.candidates[31] ?? [];
  const kinds = new Set(cands.map((c) => c.fields.map((f) => f.kind).join(',')));
  assert.ok(kinds.has('varint'), 'varint 应在候选里');
  assert.ok(kinds.has('bool'), 'bool 也对得齐，必须在候选里');
  assert.ok(cands.length >= 2, `应列出多个候选，实际 ${cands.length}`);
  const validated = cands.filter((c) => c.packetValidated);
  assert.equal(validated.length, 1, '只有第一个走通整包的标记 packetValidated');
});

test('物品 id 不合理：带 Slot 的候选被毙掉（垃圾文法可能仍对齐，但绝不带物品字段）', () => {
  const bad = Buffer.concat([wv(5), wslot(99999)]);
  const buf = frame([{ name: 'test:bad', typeId: 33, payload: bad }]);
  const result = discoverSerializers(buf, { ...OPTS });
  const cands = result.candidates[33] ?? [];
  // 闸门保的是「不把非法物品 id 当真」：垃圾文法（空 ingredient 之类）可能仍对齐，
  // 但没有任何候选敢声称读到了物品 id——99999 绝不出现在任何候选的 slotIds 里。
  for (const c of cands) assert.equal(c.slotIds.length, 0, `候选不该读出物品：${c.slotIds}`);
  // 对照：把物品 id 上限放开，带 Slot 的真形状就能被找到（放宽后垃圾文法也会对齐，属正常歧义）
  const relaxed = discoverSerializers(buf, { knownItemIds: KNOWN_IDS, maxItemId: 200000, maxCandidates: 20 });
  const kinds = (relaxed.candidates[33] ?? []).map((c) => c.fields.map((f) => f.kind).join(','));
  assert.ok(kinds.includes('varint,slot'), `放开上限后应找到 varint,slot：${kinds.join(' / ')}`);
});

test('发现结果永不自动生效：packetValidated 之外都只是 runValidated 候选', () => {
  const buf = frame([
    { name: 'testmod:cooking/stew', typeId: 30, payload: cookingPayload({}) },
    { name: 'testmod:cooking/soup', typeId: 30, payload: cookingPayload({ groups: [[102]], time: 600 }) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  const chosen = result.discovered[0];
  for (const cand of result.candidates[30]) {
    if (JSON.stringify(cand.fields) === JSON.stringify(chosen.fields)) {
      assert.equal(cand.packetValidated, true, '被选中的候选标 packetValidated');
    } else {
      assert.notEqual(cand.packetValidated, true, '其余候选不得标 packetValidated');
    }
  }
});

test('形状库覆盖 FD 四个家族；盲搜生成器按预算收敛', () => {
  const shapes = new Set(SHAPES.map((s) => s.shape));
  for (const need of ['smelting-like', 'cooking-like', 'cutting-like', 'category-only']) {
    assert.ok(shapes.has(need), `形状库应有 ${need}`);
  }
  const buf = frame([{ name: 'test:y', typeId: 34, payload: cookingPayload({}) }]);
  const result = discoverSerializers(buf, { ...OPTS, budget: 20 });
  assert.equal(result.ok, false);
  assert.ok(result.notes.some((n) => n.includes('预算')), '预算耗尽要写进 notes');
});

test('同类型两次出现之间夹别的类型：非连续段照常解析（sidesheet 已知文法）', () => {
  const buf = frame([
    { name: 'test:a', typeId: 15, payload: smeltingPayload({}) },
    { name: 'testmod:cooking/stew', typeId: 30, payload: cookingPayload({}) },
    { name: 'test:b', typeId: 15, payload: smeltingPayload({ ids: [101] }) },
    { name: 'testmod:cooking/soup', typeId: 30, payload: cookingPayload({ groups: [[102]], time: 600 }) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  assert.equal(result.ok, true, result.notes.join('；'));
  const d = result.discovered.find((x) => x.typeId === 30);
  assert.ok(d, '两段不连续的未知类型也应各自被发现');
});

test('配方头必须是资源名：payload 里的 JSON 片段不会被当成配方名', () => {
  // 真实事故：TF 的改装配方 payload 是一整段 JSON 字符串，错位后从里面读出的
  // "名字"（含引号/花括号）曾让 DFS 走进死胡同、烧光预算。名字形状是硬判据。
  const buf = frame([
    { name: 'test:a', typeId: 15, payload: smeltingPayload({}) },
    { name: 'stained_glass_pane"}},"pattern":["M M","YGY"]', typeId: 15, payload: smeltingPayload({ ids: [101] }) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  assert.equal(result.ok, false, '非法配方名必须让整包走不通');
  assert.ok(result.notes.some((n) => n.includes('头读不出')), `notes 要指出头读不出：${result.notes.join('；')}`);
});

test('配方名在当前路径上重复 = 前一段错位，直接否掉', () => {
  const buf = frame([
    { name: 'test:dup', typeId: 15, payload: smeltingPayload({}) },
    { name: 'test:dup', typeId: 15, payload: smeltingPayload({ ids: [101] }) },
  ]);
  const result = discoverSerializers(buf, OPTS);
  assert.equal(result.ok, false);
  assert.ok(result.notes.some((n) => n.includes('重复')), `notes 要指出重复：${result.notes.join('；')}`);
});

test('盲搜能发现 i32 / varints 字段（TF 的 drying 与 no_template_smithing 形状）', () => {
  const wi32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v, 0); return b; };
  const drying = Buffer.concat([wing([100]), wslot(110), wi32(7200)]);
  const smithing = Buffer.concat([wing([101]), wing([102]), wv(2), wv(4), wv(7)]);
  const buf = frame([
    { name: 'testmod:drying/a', typeId: 40, payload: drying },
    { name: 'testmod:drying/b', typeId: 40, payload: Buffer.concat([wing([102]), wslot(111), wi32(6000)]) },
    { name: 'testmod:smithing/a', typeId: 41, payload: smithing },
  ]);
  const result = discoverSerializers(buf, { ...OPTS, budget: 200000 });
  assert.equal(result.ok, true, result.notes.join('；'));

  // 线上 f32 与 i32 同形（都吃 4 字节）：备选必须都列出来，让人审挑语义对的那个。
  const kinds40 = (result.candidates[40] ?? []).map((c) => c.fields.map((f) => f.kind).join(','));
  assert.ok(kinds40.includes('list,slot,f32') || kinds40.some((k) => k.endsWith('f32')), `应保留 f32 候选：${kinds40}`);
  assert.ok(kinds40.some((k) => k.endsWith('i32')), `应保留 i32 候选：${kinds40}`);
  const i32Fields = result.candidates[40].find((c) => c.fields.at(-1).kind === 'i32').fields;

  const kinds41 = (result.candidates[41] ?? []).map((c) => c.fields.map((f) => f.kind).join(','));
  assert.ok(kinds41.some((k) => k.endsWith('varints')), `应保留 varints 候选：${kinds41}`);
  const varintsFields = result.candidates[41].find((c) => c.fields.at(-1).kind === 'varints').fields;

  const parsed = parseDeclareRecipes(buf, {
    serializers: { 40: { name: 'testmod:drying', fields: i32Fields }, 41: { name: 'testmod:smithing', fields: varintsFields } },
  });
  assert.equal(parsed.recipes[0].data[i32Fields.at(-1).name], 7200);
  assert.equal(parsed.recipes[1].data[i32Fields.at(-1).name], 6000);
  assert.deepEqual(parsed.recipes[2].data[varintsFields.at(-1).name], [4, 7]);
});
