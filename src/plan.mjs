/**
 * 配方依赖图 + 目标规划（纯函数）。
 *
 * 目的：把清单里已有的配方/站点变成"做一个东西要几步、缺什么"的答案，喂给宿主执行。
 * 这是 L3 剩下的一半——数据已经够，缺的是"从目标倒推材料"的这一层。
 *
 * 输出只有**宿主已有的技能**（craft / cut / pot / cook / smelt），不含自由文本：
 * 技能集合是封闭的，规划器也只能在这个集合里排步骤。
 *
 * 约定：
 *   - 节点是物品；边是配方。同一物品有多条配方时按"能做、材料够、站点在"打分挑一条。
 *   - 步骤是后序：先出原料的加工步骤，再出消费它的那一步。
 *   - 背包按"规划过程中会消耗"记账：够就不排步骤，不够就递归补，补不出来进 missing。
 *   - 工具（knife/axe 这类）不消耗，但必须**已经在背包里**或背包里同类；否则 missing。
 */
import { craftRecipeViews } from './recipes-view.mjs';

const MAX_DEPTH = 6;
const MAX_STEPS = 96;

/** 合成（工作台）类：不是方块交互。 */
const CRAFT_TYPES = new Set(['crafting_shaped', 'crafting_shapeless']);
/** 原版炉子类：走宿主的 smelt（需要燃料）。 */
const SMELT_TYPES = new Set(['smelting', 'blasting', 'smoking']);
/** 被动站点：走宿主的 cook。 */
const PASSIVE_TYPES = new Set(['campfire_cooking']);

const bare = (name) => String(name ?? '').replace(/^minecraft:/, '');
const sameName = (a, b) => bare(a) === bare(b);
const refName = (x) => (typeof x === 'string' ? x : x?.id ?? x?.item?.id ?? x?.item ?? null);

/** 配方产出的第一个物品（cutting 的 results[] 也认）。 */
export function outputOf(recipe) {
  const r = recipe?.result;
  if (r && typeof r === 'object' && !Array.isArray(r)) return refName(r);
  if (Array.isArray(r) && r.length > 0) return refName(r[0]);
  const results = recipe?.results;
  if (Array.isArray(results) && results.length > 0) return refName(results[0]);
  return null;
}

/** 一份产出多少（缺省 1）。 */
export function outputCountOf(recipe) {
  const r = recipe?.result ?? (Array.isArray(recipe?.results) ? recipe.results[0] : null);
  const n = Number(r?.count ?? r?.Count ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 原料分组：每格一个候选名数组；[[{id}]] 与 [{id}] 两种形状都归一。 */
function ingredientGroups(recipe) {
  const raw = recipe?.ingredients ?? recipe?.grid;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw) {
    const list = Array.isArray(g) ? g : [g];
    const names = list.map(refName).filter(Boolean);
    if (names.length > 0) out.push(names);
  }
  return out;
}

/** 工具名：显式 tool 字段之外，盲搜/自动命名后的配方只能靠名字后缀认工具。 */
/** 工具候选：显式 tool 字段；没有就返回空。 */
function toolCandidates(recipe) {
  const t = recipe?.tool;
  if (!Array.isArray(t)) return [];
  return t.map(refName).filter(Boolean);
}

/**
 * 建图：resultId → [{ recipe, stationKind, stationId, tool, type }]
 * 只收"有产物"的条目；unsupported 也收（有些仍可执行），但打分时降权。
 * @param {object} manifest
 * @param {{stations?: Array<{id:string,kind:string,recipeType?:string,recipeTypes?:string[]}>}} [opts]
 */
export function buildRecipeGraph(manifest, opts = {}) {
  const stations = opts.stations ?? manifest.stations ?? [];
  const stationOf = new Map();
  for (const st of stations) {
    if (!st?.recipeType && !Array.isArray(st.recipeTypes)) continue;
    const types = Array.isArray(st.recipeTypes) ? st.recipeTypes : [st.recipeType];
    for (const t of types) {
      if (!t) continue;
      if (!stationOf.has(String(t))) stationOf.set(String(t), st);
    }
  }
  const views = craftRecipeViews(manifest);
  const viewById = new Map(views.map((v) => [v.id, v]));

  const byResult = new Map();
  for (const r of manifest.recipes ?? []) {
    const out = outputOf(r);
    if (!out) continue;
    const type = String(r.type ?? '');
    const st = stationOf.get(type);
    const view = viewById.get(r.id);
    // 合成配方用视图归一（grid/pattern→pattern）后的原料；其余用 ingredients。
    let groups = ingredientGroups(r);
    if (view) {
      if (view.type === 'crafting_shaped') {
        const key = view.key ?? {};
        const cells = [];
        for (const row of view.pattern ?? []) {
          for (const ch of row) {
            if (ch === ' ') continue;
            const ref = key[ch];
            const cands = (Array.isArray(ref) ? ref : [ref]).map(refName).filter(Boolean);
            if (cands.length > 0) cells.push(cands);
          }
        }
        groups = cells;
      } else if (view.type === 'crafting_shapeless') {
        groups = (view.ingredients ?? []).map((g) => (Array.isArray(g) ? g : [g]).map(refName).filter(Boolean));
      }
    }
    const entry = {
      recipe: r,
      id: String(r.id ?? ''),
      type,
      kind: st?.kind ?? null,
      stationId: st?.id ?? null,
      tool: toolCandidates(r),
      groups,
      out,
      outCount: outputCountOf(r),
      unsupported: typeof r.unsupported === 'string' ? r.unsupported : null,
    };
    const list = byResult.get(bare(out)) ?? [];
    list.push(entry);
    byResult.set(bare(out), list);
  }
  return { byResult, views };
}

/** 这个物品能不能靠图做出来（有没有产物是它的配方）。 */
export function canMake(graph, item) {
  return (graph.byResult.get(bare(item)) ?? []).length > 0;
}

/**
 * 一条配方的步骤形态（可能多步）。返回 null = 这个类型没有对应的宿主技能。
 * @returns {Array<{skill:string, [k:string]: unknown}>|null}
 */
export function stepsFor(entry, count) {
  const t = bare(entry.type);
  if (entry.kind === 'two-step-use') {
    // 两步式：每个原料组各放一次（宿主 cut 的 items 就是这个语义）
    const items = entry.groups.map((g) => g[0]).filter(Boolean);
    return items.length > 0 ? [{ skill: 'cut', items, count }] : null;
  }
  if (entry.kind === 'sidecar-recipe') {
    return [{ skill: 'pot', recipe: entry.id, count }];
  }
  if (entry.kind === 'place-and-wait' || PASSIVE_TYPES.has(t)) {
    const input = entry.groups[0]?.[0];
    return input ? [{ skill: 'cook', item: input, count }] : null;
  }
  if (SMELT_TYPES.has(t)) {
    const input = entry.groups[0]?.[0];
    return input ? [{ skill: 'smelt', input, count }] : null;
  }
  if (t === 'crafting_shaped' || t === 'crafting_shapeless') {
    return [{ skill: 'craft', item: entry.out, count }];
  }
  return null;
}

/**
 * 规划：做出 `count` 个 item，返回可执行的步骤序列与缺口。
 *
 * @param {object} graph buildRecipeGraph 的结果
 * @param {{item: string, count?: number, have?: Record<string, number>,
 *          stations?: Array<object>, maxSteps?: number, depth?: number}} opts
 * @returns {{ok: boolean, steps: Array<object>, missing: Array<{item:string, reason:string}>, notes: string[]}}
 */
export function planTarget(graph, opts) {
  const target = String(opts.item ?? '');
  const want = Math.max(1, Math.floor(Number(opts.count ?? 1)) || 1);
  const have = new Map();
  for (const [k, v] of Object.entries(opts.have ?? {})) have.set(bare(k), Number(v) || 0);
  const stations = opts.stations ?? [];
  const stationTypes = new Set();
  for (const st of stations) {
    if (Array.isArray(st.recipeTypes)) for (const t of st.recipeTypes) stationTypes.add(String(t));
    else if (st.recipeType) stationTypes.add(String(st.recipeType));
  }
  const maxSteps = Number(opts.maxSteps ?? MAX_STEPS);

  const steps = [];
  const missing = [];
  const notes = [];

  const haveCount = (name) => have.get(bare(name)) ?? 0;
  const take = (name, n) => {
    const key = bare(name);
    const cur = have.get(key) ?? 0;
    if (cur < n) return false;
    have.set(key, cur - n);
    return true;
  };

  /** 这条配方能不能执行：站点在、工具在、原料组都有可选来源。 */
  const viable = (entry, depth) => {
    if (!stepsFor(entry, 1)) return false;
    if (entry.kind === 'sidecar-recipe' && !stationTypes.has(entry.type)) return false;
    if (entry.kind === 'two-step-use' && !stationTypes.has(entry.type)) return false;
    if (entry.kind === 'place-and-wait' && !stationTypes.has(entry.type) && !PASSIVE_TYPES.has(bare(entry.type))) return false;
    // 工具是"一组候选里有一把就行"（刀有好几种），不是每把都要
    if (entry.tool.length > 0
      && !entry.tool.some((t) => haveCount(t) > 0 || (depth < MAX_DEPTH && canMake(graph, t)))) return false;
    for (const group of entry.groups) {
      if (group.some((name) => haveCount(name) > 0 || (depth < MAX_DEPTH && canMake(graph, name)))) continue;
      return false;
    }
    return true;
  };

  const score = (entry) => (entry.unsupported ? 100 : 0) + entry.groups.length;
  const pick = (item, depth) => (graph.byResult.get(bare(item)) ?? [])
    .filter((e) => viable(e, depth))
    .sort((a, b) => score(a) - score(b) || String(a.id).localeCompare(String(b.id)))[0] ?? null;

  /**
   * 保证 name 在背包里有 need 个（缺的排步骤补）。
   * @returns {boolean} 最终够不够
   */
  const ensure = (name, need, depth, path) => {
    const key = bare(name);
    const deficit = need - haveCount(key);
    if (deficit <= 0) return true;
    if (depth >= MAX_DEPTH) { missing.push({ item: key, reason: `嵌套超过 ${MAX_DEPTH} 层` }); return false; }
    if (path.has(key)) { missing.push({ item: key, reason: '配方循环（自己需要自己）' }); return false; }
    if (steps.length > maxSteps) { missing.push({ item: key, reason: `步骤超过 ${maxSteps} 条` }); return false; }

    const entry = pick(key, depth);
    if (!entry) {
      // 没有可执行配方：把最具体的原因说出来（站点缺 / 工具缺 / 单纯没配方），
      // 否则回执只有一句"没有可用站点/工具/材料"，人不知道该去装站点还是拿刀。
      const candidates = graph.byResult.get(key) ?? [];
      if (candidates.length === 0) {
        missing.push({ item: key, reason: '没有配方（要去找/种/杀）' });
        return false;
      }
      const e = candidates[0];
      if (e.kind && !stationTypes.has(e.type)) {
        missing.push({ item: key, reason: `做「${key}」需要 ${e.type} 的站点（清单里没有可用站点）` });
      } else if (e.tool.length > 0 && !e.tool.some((t) => haveCount(t) > 0 || canMake(graph, t))) {
        missing.push({ item: bare(e.tool[0]), reason: `做「${key}」要工具（${e.tool.map(bare).join(' / ')}），背包里没有也做不出` });
      } else {
        missing.push({ item: key, reason: '有配方但没有可用站点/工具/材料' });
      }
      return false;
    }
    const batches = Math.ceil(deficit / entry.outCount);
    const nextPath = new Set(path).add(key);

    // 工具：不消耗，但必须在背包里（拿在手上的那种）；候选里有一把就够
    if (entry.tool.length > 0 && !entry.tool.some((t) => haveCount(t) > 0)) {
      const craftable = entry.tool.find((t) => depth < MAX_DEPTH && pick(t, depth + 1));
      if (!craftable) {
        missing.push({ item: bare(entry.tool[0]), reason: `做「${key}」要工具（${entry.tool.map(bare).join(' / ')}），背包里没有也做不出` });
        return false;
      }
      if (!ensure(craftable, 1, depth + 1, nextPath)) return false;
    }

    // 原料：按批数逐组凑（每组任选一种可满足的候选）
    for (const group of entry.groups) {
      const needN = batches;
      const known = group.find((g) => haveCount(g) >= needN);
      if (known) { take(known, needN); continue; }
      const craftable = group.find((g) => canMake(graph, g));
      if (craftable) {
        if (!ensure(craftable, needN, depth + 1, nextPath)) return false;
        take(craftable, needN);
        continue;
      }
      const partial = group.find((g) => haveCount(g) > 0);
      if (partial) {
        missing.push({ item: bare(partial), reason: `只够 ${haveCount(partial)}/${needN} 个「${key}」` });
      } else {
        missing.push({ item: bare(group[0] ?? '?'), reason: `做「${key}」缺原料（候选：${group.map(bare).join(' / ')}）` });
      }
      return false;
    }

    // 容器（锅要碗）：不消耗判断太细，缺了只提示
    const container = refName(entry.recipe.container);
    if (container && haveCount(container) <= 0) {
      notes.push(`「${key}」需要容器 ${bare(container)}（侧车实现可能要它）`);
    }

    const planned = stepsFor(entry, batches);
    for (const step of planned) {
      if (step.skill === 'smelt' && !step.fuel) {
        // 宿主的 smelt 必须要燃料（它不会自己挑）；从背包里找煤/木炭，没有就如实报缺
        const fuel = [...have.entries()].find(([k, v]) => v > 0 && /(^|_)(coal|charcoal)$/.test(k));
        if (!fuel) {
          missing.push({ item: 'minecraft:coal', reason: `要炼「${key}」但背包里没有燃料（煤/木炭）` });
          return false;
        }
        step.fuel = fuel[0];
        have.set(fuel[0], fuel[1] - 1);
      }
      steps.push(step);
    }
    // 产出 batches 批，用掉这次的缺口，余数留在背包里给别的分支用
    have.set(key, haveCount(key) + entry.outCount * batches - deficit);
    return true;
  };

  if (!target) return { ok: false, steps, missing: [{ item: '', reason: '没给目标物品' }], notes };
  const ok = ensure(target, want, 0, new Set());
  return { ok, steps, missing, notes };
}
