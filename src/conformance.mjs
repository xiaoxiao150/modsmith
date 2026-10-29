/**
 * 接包验收：manifest / ids / 注入后的 registry 三层离线检查。
 *
 * 这不是"再跑一遍 validate"：validate 只看字段，这里看**行为**——声明的每个方块
 * 有没有形状、每个 state 能不能落到 shape、作物能不能挖、楼梯上下半是不是不同、
 * boss 有没有真的进注册表。conformance 是 modsmith 的验收线，不是宿主的游戏逻辑。
 */
import { checkServerMods } from './server-fingerprint.mjs';
import { installModRegistry } from './cortico-bridge.mjs';
import { shapeTemplateOf } from './block-shapes.mjs';
import { craftRecipeViews } from './recipes-view.mjs';
import { validateManifest, hasErrors, describeIssues } from './validate.mjs';
import { vanillaBlockStateCeiling } from './recipes-join.mjs';

const V_1_21_1 = { blockState: 26683, item: 1332, entity: 129 };
const CROPISH = /wheat|carrot|potato|beetroot|onion|tomato|cabbage|rice|melon|pumpkin|sugarcane|berry|flax|hemp|budding_/i;

function check(checks, id, level, subject, message, details) {
  checks.push({ id, level, subject, message, ...(details === undefined ? {} : { details }) });
}

function ageValues(block) {
  const values = new Set();
  for (const state of block?.states ?? []) {
    const raw = state?.age;
    if (raw !== undefined && Number.isFinite(Number(raw))) values.add(Number(raw));
  }
  return [...values].sort((a, b) => a - b);
}

/** M1–M8：只吃 manifest，不连服务器。 */
export function checkManifest(manifest) {
  const checks = [];
  if (!manifest || typeof manifest !== 'object') {
    check(checks, 'M1', 'fail', 'manifest', '不是对象');
    return checks;
  }
  const issues = validateManifest(manifest);
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level !== 'error');
  check(checks, 'M1', errors.length > 0 ? 'fail' : 'pass', 'manifest',
    errors.length > 0 ? describeIssues(errors).join('；') : 'schema/validate 通过',
    errors.length > 0 ? errors : undefined);
  for (const w of warns) check(checks, 'M1.warn', 'warn', w.path ?? 'manifest', w.message);

  for (const [name, block] of Object.entries(manifest.blocks ?? {})) {
    if (!name.includes(':')) {
      check(checks, 'M2', 'fail', name, '方块名没有 namespace');
      continue;
    }
    const solid = block?.solid !== false;
    const box = block?.box;
    if (solid && !Array.isArray(box) && !shapeTemplateOf(name)) {
      check(checks, 'M3', 'fail', name, 'solid:true 但既没有 box 也没有可用的形状模板');
    } else if (!solid && Array.isArray(box)) {
      check(checks, 'M3', 'warn', name, 'solid:false 却给了 box（会让客户端以为有碰撞）');
    }
    if (!Array.isArray(block?.states) || block.states.length === 0) {
      check(checks, 'M4', 'fail', name, 'states 为空，无法映射 state');
    }
  }

  for (const [crop, spec] of Object.entries(manifest.crops ?? {})) {
    const seed = String(spec?.seed ?? '');
    if (!seed) {
      check(checks, 'M5', 'fail', crop, 'crop 没有 seed');
    } else if (!manifest.items?.[seed] && !manifest.items?.[`${manifest.namespace}:${seed}`]) {
      // 原版种子（wheat_seeds 等）不在模组 items 里，属于正常；只对带 namespace 的种子要求
      if (seed.includes(':') && !seed.startsWith('minecraft:')) {
        check(checks, 'M5', 'warn', crop, `seed ${seed} 不在 items 里`);
      }
    }
    const maxAge = Number(spec?.max_age);
    for (const aliasShort of spec?.aliases ?? []) {
      const alias = aliasShort.includes(':') ? aliasShort : `${manifest.namespace}:${aliasShort}`;
      const block = manifest.blocks?.[alias];
      if (!block) {
        check(checks, 'M5', 'fail', crop, `alias ${alias} 不在 blocks 里`);
        continue;
      }
      const ages = ageValues(block);
      if (ages.length > 0 && Number.isFinite(maxAge) && Math.max(...ages) !== maxAge) {
        const drops = block.drops ?? [];
        const seedOnly = drops.length > 0 && drops.every((d) => d === seed || String(d).endsWith('_seeds'));
        check(checks, 'M5', seedOnly ? 'fail' : 'warn', alias,
          `alias 的 age 上限 ${Math.max(...ages)} 与作物 max_age ${maxAge} 不一致` +
          (seedOnly ? '，且只掉种子（长苗阶段不该当成熟作物）' : ''));
      }
    }
    if (maxAge <= 0) check(checks, 'M5', 'fail', crop, `max_age 非法：${spec?.max_age}`);
  }

  const recipes = manifest.recipes ?? [];
  const resultRequired = new Set([
    'crafting_shaped', 'crafting_shapeless',
    'smelting', 'blasting', 'smoking', 'campfire_cooking',
    'stonecutting', 'smithing_transform',
  ]);
  const customMissing = new Map();
  for (const rec of recipes) {
    if (rec?.unsupported) continue;
    const type = String(rec?.type ?? '').replace(/^minecraft:/, '');
    if (!rec?.result || typeof rec.result.id !== 'string' || !rec.result.id) {
      // 自定义序列化器（twilightforest:emperors_cloth_recipe 之类）本来就可能没有
      // 统一的 result；只对原版有明确产物形状的类型判死，其余按类型汇总提示。
      if (resultRequired.has(type)) {
        check(checks, 'M6', 'fail', rec?.id ?? rec?.file ?? 'recipe', '配方没有可解析的 result.id');
      } else {
        const key = type || '?';
        const hit = customMissing.get(key);
        if (hit) hit.count += 1;
        else customMissing.set(key, { count: 1, first: rec?.id ?? rec?.file ?? 'recipe' });
      }
    }
  }
  for (const [type, hit] of customMissing) {
    check(checks, 'M6', 'warn', type,
      `${hit.count} 条自定义配方没有统一 result，配方视图不会消费（首条 ${hit.first}）`);
  }
  try {
    const views = craftRecipeViews(manifest);
    if (recipes.length > 0 && views.length === 0) {
      check(checks, 'M6', 'fail', 'recipes', '清单有配方，但 craftRecipeViews 一条都产不出');
    } else {
      check(checks, 'M6', 'pass', 'recipes', `craftRecipeViews ${views.length} 条`);
    }
  } catch (err) {
    check(checks, 'M6', 'fail', 'recipes', `craftRecipeViews 抛错：${err.message}`);
  }
  for (const [tag, list] of Object.entries(manifest.candidates ?? {})) {
    if (!Array.isArray(list) || list.length === 0) {
      check(checks, 'M6', 'fail', tag, 'candidate 为空');
    }
  }

  for (const boss of manifest.bosses ?? []) {
    if (!String(boss).includes(':')) check(checks, 'M7', 'fail', boss, 'boss 不是完整实体 id');
  }
  return checks;
}

/** I1–I6：manifest + ids 的交叉检查；不需要 registry。 */
export function checkIds(manifest, ids, opts = {}) {
  const checks = [];
  if (!ids || typeof ids !== 'object') {
    check(checks, 'I1', 'fail', 'ids', '没有 ids');
    return checks;
  }
  const blockCeiling = Number(opts.blockStateCeiling ?? V_1_21_1.blockState);
  const itemCeiling = Number(opts.itemCeiling ?? V_1_21_1.item);
  const entityCeiling = Number(opts.entityCeiling ?? V_1_21_1.entity);

  const declaredBlocks = new Set(Object.keys(manifest.blocks ?? {}));
  const gotBlocks = new Set(Object.keys(ids.blocks ?? {}));
  for (const name of declaredBlocks) if (!gotBlocks.has(name)) check(checks, 'I1', 'warn', name, 'manifest 声明了但服务器没有注册（兼容/技术方块，通常按实测裁剪）');
  for (const name of gotBlocks) if (!declaredBlocks.has(name)) check(checks, 'I1', 'warn', name, 'ids 有但 manifest 没声明');

  const declaredItems = new Set(Object.keys(manifest.items ?? {}));
  const gotItems = new Set(Object.keys(ids.items ?? {}));
  for (const name of declaredItems) if (!gotItems.has(name)) check(checks, 'I1', 'warn', name, 'manifest 声明了但服务器没有注册这个物品（兼容/技术物品，通常按实测裁剪）');

  const stateOwner = new Map();
  const ranges = [];
  for (const [name, states] of Object.entries(ids.blocks ?? {})) {
    if (!Array.isArray(states) || states.length === 0) {
      check(checks, 'I2', 'fail', name, 'ids.blocks 为空');
      continue;
    }
    let min = Infinity;
    let max = -1;
    for (const state of states) {
      const id = Number(state?.stateId);
      if (!Number.isInteger(id) || id <= 0) {
        check(checks, 'I2', 'fail', name, `stateId 非法：${state?.stateId}`);
        continue;
      }
      if (id <= blockCeiling) {
        check(checks, 'I2', 'fail', name, `stateId ${id} 落在 vanilla 区间（<= ${blockCeiling}）`);
        continue;
      }
      const owner = stateOwner.get(id);
      if (owner && owner !== name) check(checks, 'I2', 'fail', name, `stateId ${id} 已被 ${owner} 占用`);
      else stateOwner.set(id, name);
      min = Math.min(min, id);
      max = Math.max(max, id);
    }
    if (Number.isFinite(min)) ranges.push({ name, min, max });
  }
  ranges.sort((a, b) => a.min - b.min);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].min <= ranges[i - 1].max) {
      check(checks, 'I2', 'fail', ranges[i].name,
        `stateId 区间与 ${ranges[i - 1].name} 重叠：[${ranges[i].min}, ${ranges[i].max}] vs [${ranges[i - 1].min}, ${ranges[i - 1].max}]`);
    }
  }

  const itemOwner = new Map();
  for (const [name, raw] of Object.entries(ids.items ?? {})) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) check(checks, 'I3', 'fail', name, `item id 非法：${raw}`);
    else if (id <= itemCeiling) check(checks, 'I3', 'fail', name, `item id ${id} 落在 vanilla 区间（<= ${itemCeiling}）`);
    else {
      const owner = itemOwner.get(id);
      if (owner && owner !== name) check(checks, 'I3', 'fail', name, `item id ${id} 已被 ${owner} 占用`);
      else itemOwner.set(id, name);
    }
  }

  const entities = ids.entities ?? {};
  const entityOwner = new Map();
  for (const [name, spec] of Object.entries(entities)) {
    const id = Number(spec?.id);
    if (!Number.isInteger(id) || id <= entityCeiling) {
      check(checks, 'I4', 'fail', name, `entity id ${spec?.id} 落在原版区间（<= ${entityCeiling}）或非法`);
      continue;
    }
    const owner = entityOwner.get(id);
    if (owner && owner !== name) check(checks, 'I4', 'fail', name, `entity id ${id} 已被 ${owner} 占用`);
    else entityOwner.set(id, name);
  }
  for (const boss of manifest.bosses ?? []) {
    if (!entities[boss]) check(checks, 'I4', 'fail', boss, 'boss 不在 ids.entities 里');
    else if (!entities[boss].boss) check(checks, 'I4', 'fail', boss, 'boss 条目没有 boss:true');
  }
  if ((manifest.bosses ?? []).length > 0 && Object.keys(entities).length === 0) {
    check(checks, 'I4', 'fail', 'entities', '清单有 boss，但 ids 没有 entities（dump mod 太旧？）');
  }

  if (opts.serverMods) {
    const v = checkServerMods(ids.serverMods, opts.serverMods);
    check(checks, 'I5', v.fatal ? 'fail' : 'pass', 'server-mods', v.lines.join('；') || '指纹检查完成');
  } else if (!ids.serverMods?.fingerprint) {
    check(checks, 'I5', 'warn', 'ids', '没有 serverMods 指纹，换 jar 组合时无法拒绝旧 ids');
  }

  if (!ids.method) check(checks, 'I6', 'warn', 'ids', '缺少 method');
  if (!ids.measuredAt) check(checks, 'I6', 'warn', 'ids', '缺少 measuredAt');
  if (Array.isArray(ids.failed) && ids.failed.length > 0) {
    check(checks, 'I6', 'warn', 'ids', `${ids.failed.length} 项在导入时被剔除（见 ids.failed）`);
  }
  return checks;
}

function shapeIdsFor(registry, name) {
  return registry.blockCollisionShapes?.blocks?.[name];
}

function shapeOf(registry, name, stateId) {
  const arr = shapeIdsFor(registry, name);
  const entry = registry.blocksByName?.[name];
  if (!Array.isArray(arr) || !entry) return undefined;
  return arr[stateId - entry.minStateId];
}

/** R1–R7：注入真实 prismarine registry 后检查行为。 */
export function checkRegistry(manifest, ids, registry, opts = {}) {
  const checks = [];
  if (!registry?.blocksByName || !registry?.blockCollisionShapes) {
    check(checks, 'R1', 'fail', 'registry', '不是可注入的 prismarine registry');
    return checks;
  }
  try {
    if (!opts.installed) installModRegistry({ registry }, { manifest, ids });
  } catch (err) {
    check(checks, 'R1', 'fail', 'registry', `注入失败：${err.message}`);
    return checks;
  }

  for (const [name, spec] of Object.entries(manifest.blocks ?? {})) {
    const entry = registry.blocksByName[name];
    if (!entry) {
      check(checks, 'R1', 'fail', name, '注入后 registry 里没有这个方块');
      continue;
    }
    const shapeArr = shapeIdsFor(registry, name);
    if (!Array.isArray(shapeArr)) {
      check(checks, 'R2', 'fail', name, '没有 blockCollisionShapes 条目');
      continue;
    }
    const span = entry.maxStateId - entry.minStateId + 1;
    if (shapeArr.length < span) check(checks, 'R2', 'fail', name, `shape 数组 ${shapeArr.length} < state 区间 ${span}`);
    const missing = shapeArr.filter((id) => id === undefined || id === null);
    if (missing.length > 0) check(checks, 'R2', 'fail', name, `${missing.length} 个 state 没有 shape`);
    const empty = shapeArr.filter((id) => (registry.blockCollisionShapes.shapes[id]?.length ?? 0) === 0).length;
    if (spec.solid !== false && empty === shapeArr.length && shapeArr.length > 0) {
      check(checks, 'R3', 'fail', name, 'solid 方块的所有 state 都是空 shape（会被当空气）');
    } else if (empty > 0 && spec.solid !== false && !/_fence_gate/.test(name)) {
      check(checks, 'R3', 'warn', name, `${empty}/${shapeArr.length} 个 state 是空 shape`);
    }

    const tags = spec.tags ?? [];
    const cropLike = tags.includes('crops') || CROPISH.test(name);
    if (cropLike) {
      if (entry.diggable !== true) check(checks, 'R4', 'fail', name, '作物不可挖（diggable:false）');
      else if (entry.harvestTools && Object.keys(entry.harvestTools).length === 0) {
        check(checks, 'R4', 'fail', name, 'harvestTools 是空对象，canHarvest 会永远 false');
      } else {
        check(checks, 'R4', 'pass', name, '作物可挖');
      }
    }

    const short = name.split(':')[1] ?? name;
    if (/_stairs/.test(short)) {
      const byHalf = new Map();
      for (const state of ids.blocks?.[name] ?? []) {
        const half = state?.props?.half;
        if (!half) continue;
        const sid = shapeOf(registry, name, Number(state.stateId));
        const shape = registry.blockCollisionShapes.shapes[sid];
        const key = JSON.stringify(shape ?? []);
        if (!byHalf.has(half)) byHalf.set(half, new Set());
        byHalf.get(half).add(key);
      }
      const top = byHalf.get('top');
      const bottom = byHalf.get('bottom');
      if (top && bottom && JSON.stringify([...top].sort()) === JSON.stringify([...bottom].sort())) {
        check(checks, 'R5', 'fail', name, '楼梯 top/bottom 的 shape 完全相同，形状映射没生效');
      } else if (!top || !bottom) {
        check(checks, 'R5', 'warn', name, '楼梯缺少 top 或 bottom state，无法核对');
      } else {
        check(checks, 'R5', 'pass', name, '楼梯 top/bottom shape 不同');
      }
    }
  }

  try {
    const views = craftRecipeViews(manifest);
    if ((manifest.recipes ?? []).length > 0 && views.length === 0) {
      check(checks, 'R6', 'fail', 'recipes', '注入后仍没有可消费配方');
    } else {
      check(checks, 'R6', 'pass', 'recipes', `${views.length} 条可消费配方`);
    }
  } catch (err) {
    check(checks, 'R6', 'fail', 'recipes', `配方视图失败：${err.message}`);
  }

  for (const [name, spec] of Object.entries(ids.entities ?? {})) {
    const e = registry.entitiesByName?.[name];
    if (!e) check(checks, 'R7', 'fail', name, '实体没有注入 registry');
    else if (spec.boss && !e.boss) check(checks, 'R7', 'fail', name, 'boss 条目没有 boss 标记');
  }
  if (Object.keys(ids.entities ?? {}).length > 0) {
    check(checks, 'R7', 'pass', 'entities', `${Object.keys(ids.entities).length} 个实体已注入`);
  }
  return checks;
}

export function summarize(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, total: checks.length };
  for (const c of checks) {
    if (c.level === 'fail') summary.fail += 1;
    else if (c.level === 'warn') summary.warn += 1;
    else summary.pass += 1;
  }
  return summary;
}

export function runConformance({ manifest, ids, registry, serverMods, mcv = '1.21.1' }) {
  const checks = checkManifest(manifest);
  if (ids) {
    const ceiling = vanillaBlockStateCeiling(mcv) || V_1_21_1.blockState;
    checks.push(...checkIds(manifest, ids, { blockStateCeiling: ceiling, serverMods }));
    if (registry) checks.push(...checkRegistry(manifest, ids, registry));
  }
  return { pack: manifest?.mod ?? manifest?.source ?? 'unknown', summary: summarize(checks), checks };
}