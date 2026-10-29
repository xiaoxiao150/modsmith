// modsmith 冒烟测试：不连服务器、不调 LLM，只验各模块的纯函数。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTag, resolveMissingTags } from '../src/tag-fallback.mjs';
import { inferCrops } from '../src/crops.mjs';
import { containerCandidates } from '../src/containers.mjs';
import { modVersionOf, compareVersions } from '../src/version.mjs';
import { extractJson, validateLearned, STATION_KINDS } from '../src/learn.mjs';
import { Zip } from '../src/zip.mjs';

test('版本清洗：MC 版本在前 / 在后 / 没有', () => {
  assert.equal(modVersionOf('1.21.1-3.3.6+refabricated'), '3.3.6');
  assert.equal(modVersionOf('3.3.6+1.21.1'), '3.3.6');
  assert.equal(modVersionOf('3.3.6'), '3.3.6');
  assert.equal(modVersionOf(''), 'unknown');
});

test('版本比较', () => {
  assert.ok(compareVersions('3.3.10', '3.3.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('tag 兜底：锭 / 原版 tag / 染料 / 作物', () => {
  assert.deepEqual(fallbackTag('c:ingots/iron', 'x'), ['minecraft:iron_ingot']);
  assert.deepEqual(fallbackTag('minecraft:logs', 'x'), ['minecraft:oak_log']);
  assert.deepEqual(fallbackTag('c:dyes/red', 'x'), ['minecraft:red_dye']);
  assert.ok(fallbackTag('c:crops/tomato', 'fd').includes('fd:tomato'));
  assert.deepEqual(fallbackTag('c:totally_unknown_tag', 'x'), []);
});

test('tag 批量解析：能解的进 resolved，解不了进 stillMissing', () => {
  const { resolved, stillMissing } = resolveMissingTags(['c:eggs', 'c:zzz'], 'x');
  assert.deepEqual(resolved['c:eggs'], ['minecraft:egg']);
  assert.deepEqual(stillMissing, ['c:zzz']);
});

test('作物推断：有 age 的才认，中间形态不独立成作物', () => {
  const blocks = {
    'm:tomatoes': { states: [{ age: '0' }, { age: '3' }], tags: [], solid: false, drops: [] },
    'm:budding_tomatoes': { states: [{ age: '0' }, { age: '3' }], tags: [], solid: false, drops: [] },
    'm:stone': { states: [{}], tags: [], solid: true, drops: [] },
  };
  const { crops } = inferCrops({ blocks, namespace: 'm', recipes: [] });
  assert.ok(crops.tomatoes, '番茄应被认成作物');
  assert.ok(!crops.budding_tomatoes, '中间形态不该独立成作物');
  assert.deepEqual(crops.tomatoes.aliases, ['budding_tomatoes']);
  assert.ok(!crops.stone);
});

test('作物推断：sidecar 覆盖优先，_drop 生效', () => {
  const blocks = {
    'm:tomatoes': { states: [{ age: '0' }, { age: '7' }], tags: [], solid: false, drops: [] },
    'm:budding_tomatoes': { states: [{ age: '0' }, { age: '3' }], tags: [], solid: false, drops: [] },
  };
  const { crops } = inferCrops({
    blocks, namespace: 'm', recipes: [],
    sidecar: { tomatoes: { seed: 'tomato_seeds', max_age: 3, age_prop: 'age', soils: ['minecraft:farmland'] } },
    drop: ['budding_tomatoes'],
  });
  assert.equal(crops.tomatoes.max_age, 3, 'sidecar 的 max_age 应压过 blockstate 的 7');
  assert.equal(crops.tomatoes.seed, 'tomato_seeds');
  assert.ok(!crops.budding_tomatoes);
});

test('容器候选：只给候选，纯装饰方块不进来', () => {
  const blocks = { 'm:oak_cabinet': { solid: true }, 'm:stone': { solid: true } };
  const items = { 'm:oak_cabinet': {}, 'm:stone': {} };
  const { candidates } = containerCandidates(blocks, items);
  assert.deepEqual(candidates, ['m:oak_cabinet']);
});

test('learn 输出解析：剥掉 markdown 代码块', () => {
  const j = extractJson('```json\n{"stations":[],"prompt":"x"}\n```');
  assert.equal(j.prompt, 'x');
  assert.equal(extractJson('完全不是 json'), null);
});

test('learn 结果校验：只收已知机制和真实方块', () => {
  const manifest = { blocks: { 'm:board': {} }, names: {} };
  const bad = validateLearned(
    { stations: [{ id: 'x', kind: 'magic', block: 'm:board' }], prompt: 'p' }, manifest,
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('未知机制')));

  const ghost = validateLearned(
    { stations: [{ id: 'x', kind: 'two-step-use', block: 'm:nope' }], prompt: 'p' }, manifest,
  );
  assert.equal(ghost.ok, false);

  const good = validateLearned({
    stations: [{ id: 'board', kind: 'two-step-use', block: 'm:board', toolSuffix: '_knife' }],
    prompt: '怎么玩', unsupported: ['做不到 A'],
  }, manifest);
  assert.equal(good.ok, true, good.errors.join(';'));
  assert.equal(good.cleaned.stations[0].toolSuffix, '_knife');
});

test('三种站点机制都在表里', () => {
  assert.deepEqual(Object.keys(STATION_KINDS).sort(),
    ['place-and-wait', 'sidecar-recipe', 'two-step-use']);
});

test('zip 读取器：能读真实 jar', () => {
  // 用仓库里的合成夹具，不依赖本机任何路径（CI 上也跑得起来）
  const jar = process.env.MODSMITH_TEST_JAR
    ?? new URL('./fixtures/tiny-mod.jar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const zip = Zip.open(jar);
  assert.ok(zip.entries.size >= 10, `条目太少：${zip.entries.size}`);
  const fabric = zip.readJson('fabric.mod.json');
  assert.equal(fabric.id, 'tinymod');
  assert.ok(zip.names('assets/tinymod/blockstates/').length >= 1);
  // 中文名读得到
  const lang = zip.readJson('assets/tinymod/lang/zh_cn.json');
  assert.equal(lang['block.tinymod.tiny_block'], '小方块');
});

test('inspect 能处理合成夹具（含旧版复数目录、tag 展开、作物推断）', async () => {
  const { inspectJar } = await import('../src/inspect.mjs');
  const jar = process.env.MODSMITH_TEST_JAR
    ?? new URL('./fixtures/tiny-mod.jar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const r = inspectJar(jar);

  assert.equal(r.packName, 'tinymod-1.21.1-1.2.3');
  assert.deepEqual(Object.keys(r.manifest.blocks).sort(), ['tinymod:tiny_block', 'tinymod:tiny_crop']);
  // 有 item model 的才算物品：tiny_crop 只有方块形式
  assert.deepEqual(Object.keys(r.manifest.items).sort(), ['tinymod:tiny_block', 'tinymod:tiny_item']);
  // 旧版复数 recipes/ 也要扫到
  assert.equal(r.manifest.recipes.length, 2);
  // tag 必须展开进 candidates（漏了这行，重新生成的清单会丢所有 tag）
  assert.deepEqual(r.manifest.candidates['c:ingots/iron'], ['minecraft:iron_ingot']);
  // 带 age 的方块被认成作物
  assert.ok(r.manifest.crops.tiny_crop, 'tiny_crop 应被认成作物');
  // 中文名
  assert.equal(r.manifest.names['block.tiny_block'].zh, '小方块');
  // 实体 tag 里的 boss + 实体显示名（她靠这两个把 unknown 叫成名字）
  assert.deepEqual(r.manifest.bosses, ['tinymod:tiny_boss']);
  assert.equal(r.manifest.names['entity.tiny_boss'].zh, '小老板');
  // 旧版复数 loot_tables/ 也要扫到
  assert.deepEqual(r.manifest.blocks['tinymod:tiny_block'].drops, ['tinymod:tiny_block']);
});

test('模组模型继承原版 parent 时也能推出碰撞盒（TF 木板曾是 solid:false）', async () => {
  const { vanillaParentBox } = await import('../src/block-shapes.mjs');
  assert.deepEqual(vanillaParentBox('minecraft:block/cube_all'), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(vanillaParentBox('minecraft:block/slab_top'), [0, 0.5, 0, 1, 1, 1]);
  assert.deepEqual(vanillaParentBox('minecraft:block/stairs'), [0, 0, 0, 1, 0.5, 1]);
  assert.equal(vanillaParentBox('minecraft:block/cross'), null);
});
