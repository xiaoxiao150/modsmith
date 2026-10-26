/**
 * 工作站推断（规则优先，不调 LLM）的测试。
 *
 * 合成清单覆盖两类真实事故：
 *   - FD cooking 被别名 `stove` 抢走（词干必须优先于别名）
 *   - 同族食材（brown_mushroom/red_mushroom）被当成工具后缀（只认显式 tool 字段）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { commonSuffix, toolSuffixOf, matchBlock, inferStations } from '../src/stations.mjs';

const manifest = {
  mod: 'testmod',
  namespace: 'testmod',
  containers: ['testmod:chest'],
  blocks: {
    'testmod:cooking_pot': {},
    'testmod:stove': {},
    'testmod:cutting_board': {},
    'testmod:drying_rack': {},
    'testmod:chest': {},
    'testmod:chair': {},
  },
  items: {
    'testmod:flint_knife': {},
    'testmod:iron_knife': {},
    'testmod:gold_knife': {},
    'testmod:brown_mushroom': {},
    'testmod:red_mushroom': {},
  },
  recipes: [
    { id: 'testmod:cooking/stew', type: 'testmod:cooking', ingredients: [[{ id: 'testmod:brown_mushroom' }], [{ id: 'testmod:red_mushroom' }]] },
    { id: 'testmod:cooking/soup', type: 'testmod:cooking', ingredients: [[{ id: 'testmod:red_mushroom' }]] },
    {
      id: 'testmod:cutting/beef',
      type: 'testmod:cutting',
      ingredients: [[{ id: 'minecraft:beef' }]],
      tool: [{ id: 'testmod:flint_knife' }, { id: 'testmod:iron_knife' }, { id: 'testmod:gold_knife' }],
    },
    {
      id: 'testmod:cutting/pork',
      type: 'testmod:cutting',
      ingredients: [[{ id: 'minecraft:porkchop' }]],
      tool: [{ id: 'testmod:iron_knife' }, { id: 'testmod:gold_knife' }],
    },
    { id: 'testmod:drying/kelp', type: 'testmod:drying', ingredients: [[{ id: 'minecraft:kelp' }]] },
    { id: 'x:crafting', type: 'crafting_shaped' },
  ],
};

test('commonSuffix：同族物品的长公共后缀，太短或非 _ 开头不算', () => {
  assert.equal(commonSuffix(['testmod:flint_knife', 'testmod:iron_knife', 'testmod:gold_knife']), '_knife');
  assert.equal(commonSuffix(['minecraft:oak_planks', 'minecraft:spruce_planks']), '_planks');
  assert.equal(commonSuffix(['a:x', 'b:y']), null);
  assert.equal(commonSuffix(['testmod:knife']), null, '只有一个不算家族');
});

test('toolSuffixOf：只认显式 tool 字段，不把同族食材当工具', () => {
  const cooking = manifest.recipes.filter((r) => r.type === 'testmod:cooking');
  assert.equal(toolSuffixOf(cooking), null, 'cooking 没有 tool 字段，_mushroom 不能算工具');
  const cutting = manifest.recipes.filter((r) => r.type === 'testmod:cutting');
  assert.deepEqual(toolSuffixOf(cutting), { suffix: '_knife', hits: 2 });
});

test('matchBlock：配方类型词干优先于别名（cooking→cooking_pot，不是 stove）', () => {
  const containers = new Set(manifest.containers);
  const r = matchBlock('testmod:cooking', manifest, containers);
  assert.equal(r.chosen, 'testmod:cooking_pot');
  assert.equal(matchBlock('testmod:cutting', manifest, containers).chosen, 'testmod:cutting_board');
  assert.equal(matchBlock('testmod:drying', manifest, containers).chosen, 'testmod:drying_rack');
});

test('matchBlock：容器不算站点', () => {
  const containers = new Set(manifest.containers);
  const r = matchBlock('testmod:chest', manifest, containers);
  assert.notEqual(r.chosen, 'testmod:chest');
});

test('inferStations：两条真规则（工具→两步、无工具→侧车），容器不进站点', () => {
  const { stations } = inferStations(manifest);
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
  assert.equal(byId.cooking_pot.kind, 'sidecar-recipe');
  assert.equal(byId.cooking_pot.recipeType, 'testmod:cooking');
  assert.equal(byId.cooking_pot.command, '/cooking_pot cook {recipe}');
  assert.equal(byId.cutting_board.kind, 'two-step-use');
  assert.equal(byId.cutting_board.toolSuffix, '_knife');
  assert.equal(byId.drying_rack.kind, 'sidecar-recipe', '没有实测证据时不猜被动加工');
  assert.ok(stations.every((s) => s.needsReview === true), '推断结果一律待审');
  assert.ok(!stations.some((s) => s.block === 'testmod:chest'));
});

test('inferStations：实测确认"不开窗"的被动加工才判 place-and-wait', () => {
  const { stations } = inferStations(manifest, { evidence: { 'testmod:drying_rack': { opensWindow: false } } });
  const drying = stations.find((s) => s.block === 'testmod:drying_rack');
  assert.equal(drying.kind, 'place-and-wait');
});

test('inferStations：实测到自定义界面 → 即使有工具也走侧车（私有菜单机器人开不了）', () => {
  const { stations } = inferStations(manifest, {
    evidence: { 'testmod:cutting_board': { opensWindow: true, windowType: 'testmod:cutting_board' } },
  });
  const board = stations.find((s) => s.block === 'testmod:cutting_board');
  assert.equal(board.kind, 'sidecar-recipe');
  assert.equal(board.recipeType, 'testmod:cutting');
});

// ---------- 扫描候选与证据 ----------

test('scanCandidates：跳过容器、多状态、明显装饰；站点优先、可疑方块保留', async () => {
  const { scanCandidates } = await import('../src/stations.mjs');
  const m = {
    containers: ['m:chest'],
    blocks: {
      'm:chest': { states: [{}] },
      'm:oak_stairs': { states: [{}, {}, {}, {}] },
      'm:oak_leaves': { states: [{}] },
      'm:crate': { states: [{}] },
      'm:weird_machine': { states: [{}] },
      'm:known_station': { states: [{}] },
    },
    stations: [{ id: 'ks', kind: 'two-step-use', block: 'm:known_station' }],
  };
  const { candidates, skipped } = scanCandidates(m);
  // 已知站点排在最前（它们决定机制，必须先测），其余是可疑方块
  assert.deepEqual(candidates.sort(), ['m:crate', 'm:known_station', 'm:weird_machine']);
  assert.equal(skipped.container, 1);
  assert.equal(skipped.multiState, 1);
  assert.equal(skipped.decorative, 1);
});

test('evidenceFromProbe：没测成的方块不进证据（未知 ≠ 不开窗）', async () => {
  const { evidenceFromProbe } = await import('../src/stations.mjs');
  const ev = evidenceFromProbe({
    blockScan: {
      evidence: {
        'm:a': { placed: true, opensWindow: true, windowType: 'm:custom_gui' },
        'm:b': { placed: true, opensWindow: false },
        'm:c': { placed: false, error: '放不下去' },
      },
    },
  });
  assert.deepEqual(Object.keys(ev).sort(), ['m:a', 'm:b']);
  assert.equal(ev['m:a'].windowType, 'm:custom_gui');
  assert.equal(ev['m:b'].opensWindow, false);
});

test('证据优先：实测到自定义界面 → 改成侧车；实测不开窗的干燥架 → 被动加工', async () => {
  const { inferStations } = await import('../src/stations.mjs');
  const m = {
    mod: 'm', namespace: 'm', containers: [], blocks: {
      'm:cooking_pot': {}, 'm:cutting_board': {}, 'm:drying_rack': {},
    },
    items: { 'm:iron_knife': {}, 'm:gold_knife': {} },
    recipes: [
      { id: 'm:cooking/a', type: 'm:cooking', ingredients: [[{ id: 'minecraft:beef' }]] },
      { id: 'm:cutting/a', type: 'm:cutting', ingredients: [[{ id: 'minecraft:beef' }]], tool: [{ id: 'm:iron_knife' }, { id: 'm:gold_knife' }] },
      { id: 'm:cutting/b', type: 'm:cutting', ingredients: [[{ id: 'minecraft:pork' }]], tool: [{ id: 'm:iron_knife' }, { id: 'm:gold_knife' }] },
      { id: 'm:drying/a', type: 'm:drying', ingredients: [[{ id: 'minecraft:kelp' }]] },
    ],
  };
  // 没有证据时：cutting 有工具 → 两步式；cooking 无工具 → 侧车
  const plain = inferStations(m);
  assert.equal(plain.stations.find((s) => s.block === 'm:cutting_board').kind, 'two-step-use');
  assert.equal(plain.stations.find((s) => s.block === 'm:cooking_pot').kind, 'sidecar-recipe');

  // 实测说 cutting_board 自己弹菜单：机器人开不了 → 侧车
  const withGui = inferStations(m, { evidence: { 'm:cutting_board': { opensWindow: true, windowType: 'm:cutting_menu' } } });
  const board = withGui.stations.find((s) => s.block === 'm:cutting_board');
  assert.equal(board.kind, 'sidecar-recipe');
  assert.equal(board.recipeType, 'm:cutting');

  // 实测说 drying_rack 不开窗：被动加工
  const withPassive = inferStations(m, { evidence: { 'm:drying_rack': { opensWindow: false } } });
  assert.equal(withPassive.stations.find((s) => s.block === 'm:drying_rack').kind, 'place-and-wait');
});

test('toolSuffixOf：原版工具标签（minecraft:axes）也能推出后缀', async () => {
  const { toolSuffixOf } = await import('../src/stations.mjs');
  const mk = (tag) => ({ tool: { 'fabric:type': 'fabric:any', ingredients: [{ tag }] } });
  // 关键：manifest.items 只收**模组**物品，等原版物品名永远等不到，
  // 所以常见标签必须有内置映射，不能靠 items 兜底。
  assert.deepEqual(toolSuffixOf([mk('minecraft:axes'), mk('minecraft:axes')], []), { suffix: '_axe', hits: 2 });
  assert.deepEqual(toolSuffixOf([mk('c:tools/knife'), mk('c:tools/knife')], []), { suffix: '_knife', hits: 2 });
  assert.deepEqual(toolSuffixOf([mk('minecraft:axes')], []), null, '只出现一次不算家族');
});

test('同一方块可以服务多种配方类型（id 加类型后缀，不再整类丢弃）', async () => {
  const { inferStations } = await import('../src/stations.mjs');
  const m = {
    mod: 'm', namespace: 'm', containers: [], blocks: { 'm:cooking_pot': {}, 'm:cutting_pot': {} },
    items: { 'm:iron_knife': {}, 'm:gold_knife': {} },
    recipes: [
      { id: 'm:cooking/a', type: 'm:cooking', ingredients: [[{ id: 'minecraft:beef' }]] },
      { id: 'm:cutting/a', type: 'm:cutting', ingredients: [[{ id: 'minecraft:beef' }]], tool: [{ id: 'm:iron_knife' }, { id: 'm:gold_knife' }] },
      { id: 'm:cutting/b', type: 'm:cutting', ingredients: [[{ id: 'minecraft:pork' }]], tool: [{ id: 'm:iron_knife' }, { id: 'm:gold_knife' }] },
    ],
  };
  const { stations, skipped } = inferStations(m);
  // 两个类型都命中名字里的词干（cooking_pot / cutting_pot），不该互相挤掉；
  // 真实场景里同一个方块服务两种配方时用同一块，id 加类型后缀区分。
  assert.equal(stations.length, 2, `应出 2 个站点：${JSON.stringify(stations.map((s) => s.id))}`);
  assert.deepEqual(new Set(stations.map((s) => s.id)).size, 2, 'id 必须唯一');
  assert.deepEqual(skipped, [], `不该有跳过：${JSON.stringify(skipped)}`);
  const board = stations.find((s) => s.kind === 'two-step-use');
  assert.equal(board.recipeType, 'm:cutting');
});

test('place-and-wait 站点必须带 recipeType，否则会被显式报出来（不许静默跳过）', async () => {
  const { inferStations } = await import('../src/stations.mjs');
  const m = {
    mod: 'm', namespace: 'm', containers: [], blocks: { 'm:drying_rack': {} },
    recipes: [{ id: 'm:drying/a', type: 'm:drying', ingredients: [[{ id: 'minecraft:kelp' }]] }],
  };
  const { stations } = inferStations(m, { evidence: { 'm:drying_rack': { opensWindow: false } } });
  const drying = stations.find((s) => s.block === 'm:drying_rack');
  assert.equal(drying.kind, 'place-and-wait');
  // verify 要靠 recipeType 挑配方执行；缺了它就只能"已知但未验"。
  assert.equal(drying.recipeType, 'm:drying');
});
