// v0.2 新增纯函数：包名、probe 回写、站点判定、统计口径、校验器。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packNameOf, resultRef } from '../src/inspect.mjs';
import { applyProbe, stationMatches } from '../src/manifest-probe.mjs';
import { validateManifest, hasErrors, statsOf } from '../src/validate.mjs';

// ---------- 包名 ----------

test('包名默认是 id-MC版本-mod版本', () => {
  assert.equal(packNameOf('sprout_and_soil', '0.3.0', { mcVersion: '1.21.1' }),
    'sprout-and-soil-1.21.1-0.3.0');
  // 以 id 为准：id 里没有连字符就不会凭空长出来
  assert.equal(packNameOf('farmersdelight', '3.3.6', { mcVersion: '1.21.1' }),
    'farmersdelight-1.21.1-3.3.6');
});

test('包名可以显式指定，优先级最高', () => {
  assert.equal(packNameOf('farmersdelight', '3.3.6', { pack: 'farmers-delight-1.21.1-3.3.6' }),
    'farmers-delight-1.21.1-3.3.6');
});

test('包名里的版本号会清掉危险字符', () => {
  assert.equal(packNameOf('m', '1.0+build/2', { mcVersion: '' }), 'm-1.0_build_2');
});

// ---------- stationMatches ----------

test('不开窗符合所有无界面机制', () => {
  for (const kind of ['two-step-use', 'place-and-wait', 'sidecar-recipe']) {
    const r = stationMatches(kind, { opensWindow: false, placed: true });
    assert.equal(r.matches, true, kind);
  }
});

test('sidecar-recipe 声明了但右键能开窗 → 驳回（不需要侧车）', () => {
  const r = stationMatches('sidecar-recipe', {
    opensWindow: true, windowType: 'mymod:custom_menu', placed: true,
  });
  assert.equal(r.matches, false);
  assert.match(r.why, /不需要侧车/);
});

test('two-step-use 声明了但右键开窗 → 驳回（盲点右键不成立）', () => {
  const r = stationMatches('two-step-use', {
    opensWindow: true, windowType: 'mymod:custom_menu', placed: true,
  });
  assert.equal(r.matches, false);
  assert.match(r.why, /盲点右键/);
});

test('开出原版容器菜单 → 应该进 containers 而不是 stations', () => {
  const r = stationMatches('two-step-use', {
    opensWindow: true, windowType: 'minecraft:generic_9x3', placed: true,
  });
  assert.equal(r.matches, false);
  assert.match(r.why, /containers/);
});

test('方块没放下去直接驳回', () => {
  const r = stationMatches('place-and-wait', { opensWindow: false, placed: false });
  assert.equal(r.matches, false);
  assert.match(r.why, /没放下去/);
});

// ---------- applyProbe ----------

function manifestWith(over = {}) {
  return {
    mod: 'm', version: '1', namespace: 'm',
    blocks: {
      'm:chest_like': { states: [{}], solid: true, box: [0, 0, 0, 1, 1, 1] },
      'm:crate': { states: [{}], solid: true, box: [0, 0, 0, 1, 1, 1] },
      'm:board': { states: [{}], solid: true, box: [0, 0, 0, 1, 0.1, 1] },
      'm:pot': { states: [{}], solid: true, box: [0, 0, 0, 1, 1, 1] },
    },
    items: {}, crops: {}, names: {}, recipes: [],
    containers: ['m:chest_like', 'm:crate'],
    stations: [
      { id: 'board', kind: 'two-step-use', block: 'm:board', toolSuffix: '_knife' },
      { id: 'pot', kind: 'sidecar-recipe', block: 'm:pot', command: '/x cook {recipe}', recipeType: 'm:c' },
    ],
    ...over,
  };
}

test('probe 回写：容器表以实测为准，打不开的自动出局', () => {
  const m = manifestWith();
  const { notes } = applyProbe(m, {
    probedAt: '2026-10-23T00:00:00Z',
    containers: { ok: ['m:chest_like'], failed: [{ name: 'm:crate', error: 'no window' }] },
    stations: [
      { id: 'board', opensWindow: false, placed: true, windowType: null },
      { id: 'pot', opensWindow: false, placed: true, windowType: null },
    ],
  });
  assert.deepEqual(m.containers, ['m:chest_like']);
  assert.ok(notes.some((n) => n.includes('去掉 1 个')));
  assert.equal(m.probe.at, '2026-10-23T00:00:00Z');
});

test('probe 回写：站点只标注不改 kind', () => {
  const m = manifestWith();
  applyProbe(m, {
    containers: { ok: [] },
    stations: [{ id: 'pot', opensWindow: true, windowType: 'm:menu', placed: true }],
  });
  const pot = m.stations.find((s) => s.id === 'pot');
  assert.equal(pot.kind, 'sidecar-recipe', 'kind 不许被 probe 改');
  assert.equal(pot.opensWindow, true);
  assert.equal(pot.needsReview, true);
  assert.match(pot.reviewReason, /不需要侧车/);
});

test('probe 回写：符合的站点不留 needsReview 残留', () => {
  const m = manifestWith({
    stations: [
      { id: 'pot', kind: 'sidecar-recipe', block: 'm:pot', command: '/x {recipe}',
        needsReview: true, reviewReason: '上次的疑点' },
    ],
  });
  applyProbe(m, { containers: { ok: [] }, stations: [{ id: 'pot', opensWindow: false, placed: true }] });
  const pot = m.stations[0];
  assert.equal(pot.needsReview, undefined);
  assert.equal(pot.reviewReason, undefined);
});

test('probe 回写：可以只标注不动容器表', () => {
  const m = manifestWith();
  applyProbe(m, { containers: { ok: [] }, stations: [] }, { writeContainers: false });
  assert.deepEqual(m.containers, ['m:chest_like', 'm:crate']);
});

// ---------- 统计口径 ----------

test('统计分开报"声明"和"可用"', () => {
  const m = manifestWith({ items: { 'm:a': {}, 'm:b': {}, 'm:c': {} } });
  const ids = {
    items: { 'm:a': 1, 'm:b': 2 },
    failed: [
      { item: 'm:c', kind: 'block-only' },
      { item: 'm:d', kind: 'unknown-item' },
    ],
  };
  const s = statsOf(m, ids);
  assert.equal(s.declaredItems, 3);
  assert.equal(s.usableItems, 2);
  assert.equal(s.blockOnlyItems, 1);
  assert.equal(s.unknownItems, 1);
  assert.equal(s.containers, 2);
  assert.equal(s.stations, 2);
});

test('没有 ids 时可用数等于声明数', () => {
  const s = statsOf(manifestWith({ items: { 'm:a': {}, 'm:b': {} } }));
  assert.equal(s.declaredItems, 2);
  assert.equal(s.usableItems, 2);
});

// ---------- 校验器 ----------

test('校验器：好清单没有 error', () => {
  const issues = validateManifest(manifestWith());
  assert.equal(hasErrors(issues), false, JSON.stringify(issues.filter((i) => i.level === 'error')));
});

test('校验器：坏清单逐条报出来', () => {
  const issues = validateManifest({ mod: '', version: 1, blocks: [], recipes: 'x' });
  assert.equal(hasErrors(issues), true);
  const paths = issues.filter((i) => i.level === 'error').map((i) => i.path);
  for (const p of ['mod', 'version', 'blocks', 'recipes']) assert.ok(paths.includes(p), p);
});

test('校验器：站点 kind 写错要挡住', () => {
  const issues = validateManifest(manifestWith({
    stations: [{ id: 'x', kind: 'magic', block: 'm:board' }],
  }));
  assert.equal(hasErrors(issues), true);
  assert.ok(issues.some((i) => i.path === 'stations[0].kind'));
});

test('校验器：sidecar 命令缺 {recipe} 要挡住', () => {
  const issues = validateManifest(manifestWith({
    stations: [{ id: 'p', kind: 'sidecar-recipe', block: 'm:pot', command: '/x cook', recipeType: 'm:c' }],
  }));
  assert.equal(hasErrors(issues), true);
  assert.ok(issues.some((i) => i.path === 'stations[0].command'));
});

test('校验器：heatTag 格式', () => {
  const bad = validateManifest(manifestWith({
    stations: [{ id: 'p', kind: 'sidecar-recipe', block: 'm:pot', command: '/x {recipe}',
      recipeType: 'm:c', heatTag: 'nocolon' }],
  }));
  assert.equal(hasErrors(bad), true);
  const good = validateManifest(manifestWith({
    stations: [{ id: 'p', kind: 'sidecar-recipe', block: 'm:pot', command: '/x {recipe}',
      recipeType: 'm:c', heatTag: 'm:heat_sources' }],
  }));
  assert.equal(hasErrors(good), false, JSON.stringify(good));
});

test('校验器：分阶段方块作物要给 stages', () => {
  const bad = validateManifest(manifestWith({
    crops: { c: { seed: 'm:s', max_age: 3, age_prop: 'stage', soils: ['minecraft:farmland'],
      kind: 'stage-blocks' } },
  }));
  assert.equal(hasErrors(bad), true);
  assert.ok(bad.some((i) => i.path === 'crops.c.stages'));
});

// ---------- 配方条目：两种形状都要能过校验（接缝修复回归） ----------

test('校验器：服务端真值配方（grid + 候选 + count）零 error', () => {
  const issues = validateManifest(manifestWith({
    recipes: [
      { id: 'minecraft:oak_planks', type: 'crafting_shaped', width: 1, height: 1,
        grid: [[[{ id: 'minecraft:oak_log' }]]], result: { id: 'minecraft:oak_planks', count: 4 }, _source: 'server' },
      { id: 'minecraft:stick', type: 'crafting_shapeless',
        ingredients: [[{ id: 'minecraft:oak_planks' }]], result: { id: 'minecraft:stick', count: 4 } },
    ],
  }));
  assert.equal(hasErrors(issues), false, JSON.stringify(issues));
});

test('校验器：配方缺 id/type、shaped 没形状、result 缺 id 都报 error', () => {
  const issues = validateManifest(manifestWith({
    recipes: [
      { type: 'crafting_shapeless', ingredients: [], result: { id: 'x' } },
      { id: 'b', type: 'crafting_shaped' },
      { id: 'c', type: 'crafting_shapeless', ingredients: [], result: { count: 2 } },
      { id: 'd', type: 'crafting_shapeless', ingredients: [], result: { id: 'x', count: 0 } },
    ],
  }));
  const paths = issues.filter((i) => i.level === 'error').map((i) => i.path);
  assert.ok(paths.includes('recipes[0].id'), paths.join(','));
  assert.ok(paths.includes('recipes[1]'), paths.join(','));
  assert.ok(paths.includes('recipes[2].result'), paths.join(','));
  assert.ok(paths.includes('recipes[3].result.count'), paths.join(','));
});

// ---------- 物品模型变体不是物品 ----------

test('isItemModelVariant：护甲 trim 与巨人方块 base/gui 模型不算物品', async () => {
  const { isItemModelVariant } = await import('../src/inspect.mjs');
  for (const name of [
    'ironwood_chestplate_gold_trim',
    'arctic_boots_netherite_trim',
    'giant_block_base',
    'giant_block_gui',
    'giant_log_separate_base',
  ]) {
    assert.equal(isItemModelVariant(name), true, `${name} 是变体模型`);
  }
  for (const name of ['ironwood_chestplate', 'banister_item', 'giant_pickaxe', 'moonworm_queen', 'bowl']) {
    assert.equal(isItemModelVariant(name), false, `${name} 是真物品`);
  }
});

// ---------- 自定义序列化器的字符串产物 ----------

test('resultRef：字符串产物收成 {id,count}，对象原样保留', () => {
  assert.deepEqual(resultRef('supplementaries:bubble_blower'), {
    id: 'supplementaries:bubble_blower', count: 1,
  });
  const obj = { id: 'minecraft:stick', count: 4 };
  assert.equal(resultRef(obj), obj);
});
