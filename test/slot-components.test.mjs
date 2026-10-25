/**
 * 带组件 Slot 的读取测试（1.20.5+ 物品组件）。
 *
 * 用合成字节按 1.21.1 的 wire 形状写：count、itemId、added、removed、组件(type + data)。
 * 覆盖暮色森林实跑踩到的三个坑：
 *   - enchantments（TF 装备产物全带）——组件表要能整段吃掉；
 *   - potion_contents（TF tannin 的水瓶首格）——minecraft-data 3.112.0 的 1.21.1 定义多了
 *     一个 customName，真实服务端不写；按服务端裁掉，否则整包配方从这一格开始错位；
 *   - charged_projectiles（嵌套 Slot）——组件里再套一个带组件的 Slot。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSlotWithComponents, componentTypeId } from '../src/slot-components.mjs';

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

const slot = (id, { count = 1, added = [], removed = [] } = {}) => Buffer.concat([
  wv(count), wv(id), wv(added.length), wv(removed.length),
  ...added, ...removed.map(wv),
]);

test('enchantments 组件：槽位末尾精确落在组件之后', () => {
  const encType = componentTypeId('enchantments');
  assert.notEqual(encType, undefined, 'minecraft-data 应提供组件表');
  // enchantments = [array(varint){id varint, level varint}, showTooltip bool]
  const component = Buffer.concat([wv(encType), wv(1), wv(12), wv(2), Buffer.from([1])]);
  const buf = slot(1575, { added: [component] });
  const r = readSlotWithComponents(buf, 0);
  assert.equal(r.id, 1575);
  assert.equal(r.count, 1);
  assert.equal(r.next, buf.length);
});

test('potion_contents 组件按 1.21.1 服务端形状读（没有 customName）', () => {
  const potType = componentTypeId('potion_contents');
  // potionId?: varint（0 = water）、customColor?: i32、customEffects: []varint —— 到这就结束
  const component = Buffer.concat([wv(potType), Buffer.from([1]), wv(0), Buffer.from([0, 0])]);
  const buf = Buffer.concat([slot(998, { added: [component] }), Buffer.from([0xaa, 0xbb])]);
  const r = readSlotWithComponents(buf, 0);
  assert.equal(r.id, 998);
  assert.equal(r.next, buf.length - 2, '组件之后必须恰好剩两个哨兵字节');
  assert.deepEqual([...buf.slice(r.next)], [0xaa, 0xbb]);
});

test('charged_projectiles：组件里嵌套带组件的 Slot', () => {
  const cpType = componentTypeId('charged_projectiles');
  const inner = slot(1100, { added: [Buffer.concat([wv(componentTypeId('enchantments')), wv(0), Buffer.from([1])])] });
  const component = Buffer.concat([wv(cpType), wv(1), inner]);
  const buf = slot(1200, { added: [component], removed: [3] });
  const r = readSlotWithComponents(buf, 0);
  assert.equal(r.id, 1200);
  assert.equal(r.next, buf.length, '嵌套槽 + removed 组件表都要吃掉');
});

test('不认识的组件类型：抛错而不是猜着跳（错名比未知更糟）', () => {
  const buf = slot(1, { added: [Buffer.concat([wv(9999), Buffer.from([0])])] });
  assert.throws(() => readSlotWithComponents(buf, 0), /mapper 不认识的枚举值|组件/);
});
