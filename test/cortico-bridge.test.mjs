// installModRegistry 的注入行为：用假 registry 对象钉住，不连服务器。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installModRegistry } from '../src/cortico-bridge.mjs';

/** 与 mineflayer registry 同形状的最小假件。 */
function fakeRegistry() {
  return {
    blocks: {},
    blocksByName: {},
    blocksArray: [],
    blocksByStateId: {},
    blockCollisionShapes: { shapes: {}, blocks: {} },
    items: {},
    itemsByName: {},
    itemsArray: [],
    foodsByName: {},
  };
}

function inject(reg, manifest, ids) {
  return installModRegistry({ registry: reg }, { manifest, ids });
}

test('方块与物品按实测 id 注入，返回数量', () => {
  const reg = fakeRegistry();
  const r = inject(reg,
    { blocks: { 'm:crate': { states: [{}] } }, items: { 'm:crate': {} }, names: { 'block.crate': { zh: '板条箱' } } },
    { blocks: { 'm:crate': [{ props: {}, stateId: 500 }] }, items: { 'm:crate': 900 } });
  assert.deepEqual(r, { blocks: 1, states: 1, items: 1 });
  assert.equal(reg.blocksByName['m:crate'].displayName, '板条箱');
  assert.equal(reg.blocksByStateId[500].name, 'm:crate');
  assert.equal(reg.itemsByName['m:crate'].id, 900);
});

test('一个 stateId 只归一个方块：先声明的赢，后来的整块让位', () => {
  const reg = fakeRegistry();
  // b 只量到被 a 占走的 id：宁可不注入，也不改 a 的名
  inject(reg,
    { blocks: { 'm:a': { states: [{}] }, 'm:b': { states: [{}] } } },
    { blocks: { 'm:a': [{ props: {}, stateId: 100 }], 'm:b': [{ props: {}, stateId: 100 }] }, items: {} });
  assert.equal(reg.blocksByStateId[100].name, 'm:a');
  assert.equal(reg.blocksByName['m:b'], undefined);
});

test('gap-fill：没量全的方块按声明状态数补区间，但不抢别人实测过的 id', () => {
  const reg = fakeRegistry();
  // a 声明 6 态只量到 1 个（id 100）；b 在 102 上有实测 —— 102 归 b，其余照 span 补
  inject(reg,
    { blocks: { 'm:a': { states: [{}, {}, {}, {}, {}, {}] }, 'm:b': { states: [{}] } } },
    { blocks: { 'm:a': [{ props: {}, stateId: 100 }], 'm:b': [{ props: {}, stateId: 102 }] }, items: {} });
  assert.equal(reg.blocksByStateId[100].name, 'm:a');
  assert.equal(reg.blocksByStateId[101].name, 'm:a');   // a 自己的区间，补上
  assert.equal(reg.blocksByStateId[102].name, 'm:b');   // b 实测过的，不抢
  assert.equal(reg.blocksByStateId[103].name, 'm:a');   // span 到 106，跳过 102 继续补
  assert.equal(reg.blocksByStateId[106], undefined);    // span 尽头为止
});

test('gap-fill 的 span 是声明状态数，不是实测 id 的宽度', () => {
  const reg = fakeRegistry();
  // a 实测两个 id 相距 20（残留造成的假距离），声明只有 2 态 —— 补齐按 2 走
  inject(reg,
    { blocks: { 'm:a': { states: [{}, {}] } } },
    { blocks: { 'm:a': [{ props: {}, stateId: 100 }, { props: {}, stateId: 120 }] }, items: {} });
  assert.equal(reg.blocksByStateId[100].name, 'm:a');
  assert.equal(reg.blocksByStateId[101].name, 'm:a');
  assert.equal(reg.blocksByStateId[120].name, 'm:a');
  assert.equal(reg.blocksByStateId[102], undefined);
});

test('方块 entry 的 material 从 mineable tag 推，diggable 跟 solid', () => {
  const reg = fakeRegistry();
  inject(reg,
    {
      blocks: {
        'm:stone_like': { states: [{}], tags: ['mineable/pickaxe'], solid: true },
        'm:intangible': { states: [{}], solid: false },
      },
    },
    { blocks: { 'm:stone_like': [{ props: {}, stateId: 10 }], 'm:intangible': [{ props: {}, stateId: 11 }] }, items: {} });
  assert.equal(reg.blocksByName['m:stone_like'].material, 'mineable/pickaxe');
  assert.equal(reg.blocksByName['m:stone_like'].diggable, true);
  assert.equal(reg.blocksByName['m:intangible'].material, 'default');
  assert.equal(reg.blocksByName['m:intangible'].diggable, false);
});

test('碰撞形状注册进 blockCollisionShapes，物理才不会炸在 block.shapes 上', () => {
  const reg = fakeRegistry();
  inject(reg,
    { blocks: { 'm:crate': { states: [{}], box: [0, 0, 0, 1, 1, 1] } } },
    { blocks: { 'm:crate': [{ props: {}, stateId: 500 }] }, items: {} });
  const shapeIds = reg.blockCollisionShapes.blocks['m:crate'];
  assert.equal(shapeIds.length, 1);
  assert.deepEqual(reg.blockCollisionShapes.shapes[shapeIds[0]], [[0, 0, 0, 1, 1, 1]]);
});

test('食物只进 foodsByName：skillEat 靠它放行', () => {
  const reg = fakeRegistry();
  inject(reg,
    { blocks: {}, items: { 'm:pie': {} }, foods: ['m:pie'] },
    { blocks: {}, items: { 'm:pie': 700 } });
  assert.deepEqual(reg.foodsByName['m:pie'], { id: 700, name: 'm:pie', foodPoints: 4, saturation: 0.6, eatingTime: 32 });
});

test('registry 形状不对就拒绝注入', () => {
  assert.throws(() => installModRegistry({ registry: {} }, { manifest: { blocks: {} }, ids: {} }), /registry 形状不对/);
});
