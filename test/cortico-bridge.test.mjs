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
    entities: {},
    entitiesByName: {},
    entitiesArray: [],
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
  assert.deepEqual(r, { blocks: 1, states: 1, items: 1, entities: 0 });
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

test('方块 entry 的 material 从 mineable tag 推，diggable 不跟 solid 走', () => {
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
  // 作物/花/火把没有碰撞箱，但 canDigBlock 读 diggable——不能因为 solid:false 就判成挖不动
  assert.equal(reg.blocksByName['m:intangible'].diggable, true);
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

test('楼梯/台阶按原版模板取每个 state 的碰撞形状，不再整块当成空气', () => {
  const reg = fakeRegistry();
  reg.blocksByName['oak_stairs'] = {
    states: [{ name: 'half', type: 'enum', num_values: 2, values: ['top', 'bottom'] }],
  };
  reg.blockCollisionShapes.blocks['oak_stairs'] = [700, 701];
  reg.blockCollisionShapes.shapes[700] = [[0, 0.5, 0, 1, 1, 1]];
  reg.blockCollisionShapes.shapes[701] = [[0, 0, 0, 1, 0.5, 1]];
  inject(reg,
    {
      blocks: {
        'm:canopy_stairs': {
          states: [{ half: 'top' }, { half: 'bottom' }],
          solid: false,
          box: null,
        },
      },
    },
    {
      blocks: {
        'm:canopy_stairs': [
          { props: { half: 'top' }, stateId: 500 },
          { props: { half: 'bottom' }, stateId: 501 },
        ],
      },
      items: {},
    });
  assert.deepEqual(reg.blockCollisionShapes.blocks['m:canopy_stairs'], [700, 701]);
  assert.equal(reg.blocksByName['m:canopy_stairs'].boundingBox, 'block');
  assert.equal(reg.blocksByStateId[500].name, 'm:canopy_stairs');
});

test('食物只进 foodsByName：skillEat 靠它放行', () => {
  const reg = fakeRegistry();
  inject(reg,
    { blocks: {}, items: { 'm:pie': {} }, foods: ['m:pie'] },
    { blocks: {}, items: { 'm:pie': 700 } });
  assert.deepEqual(reg.foodsByName['m:pie'], { id: 700, name: 'm:pie', foodPoints: 4, saturation: 0.6, eatingTime: 32 });
});

test('模组实体注入名字/显示名/boss，monster 组映射成 hostile', () => {
  const reg = fakeRegistry();
  const r = inject(reg,
    { blocks: {}, items: {}, names: { 'entity.naga': { zh: '纳迦' } } },
    {
      blocks: {},
      items: {},
      entities: {
        'm:naga': { id: 158, spawnGroup: 'monster', width: 1.2, height: 2.5, boss: true },
        'm:critter': { id: 159, spawnGroup: 'creature' },
      },
    });
  assert.equal(r.entities, 2);
  assert.deepEqual(reg.entitiesByName['m:naga'], {
    id: 158,
    internalId: 158,
    name: 'm:naga',
    displayName: '纳迦',
    width: 1.2,
    height: 2.5,
    type: 'hostile',
    category: 'monster',
    metadataKeys: [],
    boss: true,
  });
  assert.equal(reg.entitiesByName['m:critter'].type, 'animal');
  assert.equal(reg.entities[159].name, 'm:critter');
  assert.equal(reg.entitiesArray.length, 2);
});

test('老 dump 只有实体 id：boss 仍算敌对，非 boss 退回 mob', () => {
  const reg = fakeRegistry();
  inject(reg, { blocks: {}, items: {} }, {
    entities: { 'm:naga': { id: 200, boss: true }, 'm:critter': { id: 201 } },
  });
  assert.equal(reg.entitiesByName['m:naga'].type, 'hostile');
  assert.equal(reg.entitiesByName['m:critter'].type, 'mob');
});

test('实体 id 与已有名字冲突时不覆盖（错名比未知更糟）', () => {
  const reg = fakeRegistry();
  inject(reg, { blocks: {}, items: {} }, { entities: { 'm:boss': { id: 100 } } });
  assert.equal(reg.entitiesByName['m:boss'].name, 'm:boss');
  // 第二个包拿同一个数字 id、另一个名字来：不能把 100 改姓
  inject(reg, { blocks: {}, items: {} }, { entities: { 'm:impostor': { id: 100 } } });
  assert.equal(reg.entities[100].name, 'm:boss');
  assert.equal(reg.entitiesByName['m:impostor'], undefined);
});

test('registry 形状不对就拒绝注入', () => {
  assert.throws(() => installModRegistry({ registry: {} }, { manifest: { blocks: {} }, ids: {} }), /registry 形状不对/);
});

test('自定义窗口类型不会把进程打崩：记成"开窗但界面未知"', async () => {
  const { installMineflayerFixes } = await import('../src/cortico-bridge.mjs');
  // 模拟 mineflayer：open_window 监听到未知类型时 createWindow 返回 null，随后读 window.id 抛错
  const { EventEmitter } = await import('node:events');
  const client = new EventEmitter();
  client.deserializer = { parsePacketBuffer: (b) => b };
  client.state = 'play';
  const bot = { _client: client };
  installMineflayerFixes(bot);
  client.on('open_window', (packet) => {
    const win = null;               // prismarine-windows 不认识这个 inventoryType
    void win.id;                    // mineflayer 原样会在这里抛 TypeError
  });
  assert.equal(client.emit('open_window', { inventoryType: 25, windowId: 1 }), false, '错误被吞掉，事件不扩散');
  assert.equal(bot._modsmithUnknownWindow, '25', '窗口类型要留下，probe 据此算"开窗"');

  // 别的监听器抛错不能被吞：只有窗口事件有守卫
  client.on('other', () => { throw new Error('boom'); });
  assert.throws(() => client.emit('other'), /boom/);
});
