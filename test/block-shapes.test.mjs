/**
 * 共享方块形状规则：原版 parent 回退、楼梯 state 映射、工具/可挖性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxForRef, harvestToolsFor, isDiggable, shapeTemplateOf, templateShapeId, vanillaParentBox,
} from '../src/block-shapes.mjs';

test('模组模型只写原版 parent 时仍能推出碰撞盒（TF 木板曾是空气）', () => {
  const materials = {
    readJson: (p) => ({
      'assets/m/models/block/planks.json': { parent: 'minecraft:block/cube_all' },
      'assets/m/models/block/stairs.json': { parent: 'minecraft:block/stairs' },
      'assets/m/models/block/cross.json': { parent: 'minecraft:block/cross' },
    })[p],
  };
  assert.deepEqual(boxForRef(materials, 'm:block/planks'), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(boxForRef(materials, 'm:block/stairs'), [0, 0, 0, 1, 0.5, 1]);
  assert.equal(boxForRef(materials, 'm:block/cross'), null);
  assert.deepEqual(vanillaParentBox('minecraft:block/slab_top'), [0, 0.5, 0, 1, 1, 1]);
});

test('楼梯/台阶按名字找同族模板；作物/花不找工具', () => {
  assert.equal(shapeTemplateOf('m:canopy_stairs'), 'oak_stairs');
  assert.equal(shapeTemplateOf('m:canopy_stairs_left'), 'oak_stairs');
  assert.equal(shapeTemplateOf('m:canopy_slab'), 'oak_slab');
  assert.equal(shapeTemplateOf('m:canopy_planks'), null);
  const reg = {
    blocksByName: {
      oak_stairs: {
        states: [{ name: 'half', type: 'enum', num_values: 2, values: ['top', 'bottom'] }],
        harvestTools: null,
      },
      stone: { harvestTools: { 270: true } },
    },
    blockCollisionShapes: { blocks: { oak_stairs: [700, 701] } },
  };
  assert.equal(templateShapeId(reg, 'oak_stairs', { half: 'top' }), 700);
  assert.equal(templateShapeId(reg, 'oak_stairs', { half: 'bottom' }), 701);
  assert.equal(templateShapeId(reg, 'oak_stairs', { half: 'nope' }), null);
  assert.deepEqual(harvestToolsFor(reg, ['mineable/pickaxe']), { 270: true });
  assert.equal(harvestToolsFor(reg, ['crops']), null);
  assert.equal(isDiggable('farmersdelight:onions'), true);
  assert.equal(isDiggable('minecraft:water'), false);
});

test('模板状态索引按最后一个属性最快变化（否则台阶上下形状互换）', () => {
  // 与 prismarine-registry 的 oak_slab 同形：type 是慢维、waterlogged 是快维。
  const reg = {
    blocksByName: {
      oak_slab: {
        states: [
          { name: 'type', type: 'enum', num_values: 3, values: ['top', 'bottom', 'double'] },
          { name: 'waterlogged', type: 'bool', num_values: 2 },
        ],
      },
    },
    blockCollisionShapes: { blocks: { oak_slab: [773, 773, 774, 774, 1, 1] } },
  };
  assert.equal(templateShapeId(reg, 'oak_slab', { type: 'top', waterlogged: 'true' }), 773);
  assert.equal(templateShapeId(reg, 'oak_slab', { type: 'top', waterlogged: 'false' }), 773);
  assert.equal(templateShapeId(reg, 'oak_slab', { type: 'bottom', waterlogged: 'true' }), 774);
  assert.equal(templateShapeId(reg, 'oak_slab', { type: 'bottom', waterlogged: 'false' }), 774);
  assert.equal(templateShapeId(reg, 'oak_slab', { type: 'double', waterlogged: 'false' }), 1);
});