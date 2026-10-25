/**
 * 服务端真配方的翻转：解析 declare_recipes 捕获 → 数字 id 翻回物品名 → manifest.recipes。
 *
 * 反查表两层：ids.items（本 mod，calibrate 量出）+ minecraft-data（vanilla，离线表）。
 * 翻不回名字的配方跳过并计数；成功率低于阈值整份不写——**错名比未知更糟**，半份真值
 * 混着旧 jar 数据比没有更危险。
 */
import { createRequire } from 'node:module';
import { parseDeclareRecipes } from './recipes.mjs';

/**
 * 有完整 payload 但**不是工作台网格**的自定义配方类型：数据照解析、照落 manifest，
 * 只是标 unsupported（下游合成技能执行不了）。文案必须说清"为什么不可消费"——
 * 把"有数据"的类型也写成"服务端只发 category"是错误报告。
 */
const SPECIAL_UNSUPPORTED = {
  'twilightforest:no_template_smithing': '无模板锻造：特殊配方（base/addition + 组件编号表）',
  'twilightforest:travellers_gear_modifier_shaped_recipe': '旅者装备改装（有形状）：payload 内嵌 JSON 配方，未解析',
  'twilightforest:travellers_gear_modifier_shapeless_recipe': '旅者装备改装（无形状）：payload 内嵌 JSON 配方，未解析',
  'twilightforest:travellers_vest_gloves_merge_recipe': '旅者背心/手套合并：特殊配方（只发 category）',
};

/** vanilla 的 数字id → 物品名 表（minecraft-data；modsmith 没直接依赖它，借 mineflayer 的解析路径）。 */
export function vanillaItemTable(mcVersion = '1.21.1') {
  const require = createRequire(import.meta.url);
  let md;
  try {
    md = require('minecraft-data')(mcVersion);
  } catch {
    const requireViaMineflayer = createRequire(require.resolve('mineflayer'));
    md = requireViaMineflayer('minecraft-data')(mcVersion);
  }
  const table = {};
  for (const item of md.itemsArray) table[item.id] = `minecraft:${item.name}`;
  return table;
}

/**
 * vanilla 最大方块状态 id —— mod 方块的状态 id 必然比它大（注册顺序）。
 * calibrate 用这条不变量挡"读到了残留方块"的假数据。
 */
export function vanillaBlockStateCeiling(mcVersion = '1.21.1') {
  const require = createRequire(import.meta.url);
  let md;
  try {
    md = require('minecraft-data')(mcVersion);
  } catch {
    const requireViaMineflayer = createRequire(require.resolve('mineflayer'));
    md = requireViaMineflayer('minecraft-data')(mcVersion);
  }
  return Math.max(0, ...md.blocksArray.map((b) => b.maxStateId));
}

/**
 * 把解析出的配方翻成 manifest.recipes 条目（字段名与 parseDeclareRecipes 的语义字段一致）。
 *
 * @param {object[]} parsed parseDeclareRecipes 的 recipes
 * @param {Record<string, number>} modItems ids.items（名字 → 数字 id）
 * @param {Record<number, string>} vanillaById minecraft-data 表
 * @returns {{entries: object[], unresolved: string[]}}
 */
export function joinRecipes(parsed, modItems, vanillaById) {
  const byId = { ...vanillaById };
  for (const [name, id] of Object.entries(modItems ?? {})) byId[id] = name;
  const entries = [];
  const unresolved = [];

  /** f32 在线上是二进制，透传会带出 0.20000000298023224 这种噪声。 */
  const round3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : (v ?? null));

  for (const rec of parsed) {
    const out = { id: rec.name, type: rec.type.replace(/^minecraft:/, ''), _source: 'server' };
    const d = rec.data ?? {};
    let ok = true;
    /** 产物槽：{id, count} —— count 是产出数量（4 根木棍靠它），下游合成次数按它算。 */
    const resultItem = (slot) => {
      if (!slot || slot.id === 0) return null;
      const n = byId[slot.id];
      if (!n) { ok = false; return null; }
      return { id: n, count: slot.count ?? 1 };
    };
    /** 原料引用：候选的堆叠数在配方语义里无意义，只留 id。 */
    const ref = (id) => {
      if (id === 0 || id == null) return null;
      const n = byId[id];
      if (!n) { ok = false; return null; }
      return { id: n };
    };
    /** 候选列表：去重保序。**嵌套 tag 会被服务端重复展开**（#c:tools/knives 实测出现两遍），
     *  这不是解析错，是 tag 里有同名成员；这里顺手清掉，别把重复带进清单。 */
    const items = (ids) => {
      const seen = new Set();
      const list = [];
      for (const raw of ids ?? []) {
        const it = ref(raw);
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        list.push(it);
      }
      return list;
    };
    const t = out.type;

    if (t === 'crafting_shapeless') {
      out.ingredients = (d.ingredients ?? []).map((ids) => items(ids));
      out.result = resultItem(d.result);
    } else if (t === 'crafting_shaped') {
      const w = d.gridWidth ?? 0;
      const h = d.gridHeight ?? 0;
      out.width = w;
      out.height = h;
      // parser 已按行优先读出 grid[y][x]（wire 的实际顺序就是 [行][列]），这里不再转置。
      // 之前多转一次，锅/炉灶的合成形状被转了 90°，摆到工作台上服务端认不出配方。
      out.grid = [];
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) row.push(items(d.grid?.[y]?.[x] ?? []));
        out.grid.push(row);
      }
      out.result = resultItem(d.result);
    } else if (t === 'smelting' || t === 'blasting' || t === 'smoking' || t === 'campfire_cooking') {
      out.ingredients = items(d.ingredient);
      out.result = resultItem(d.result);
      out.experience = round3(d.experience);
      out.cooking_time = d.cookTime ?? null;
    } else if (t === 'stonecutting') {
      out.ingredients = items(d.ingredient);
      out.result = resultItem(d.result);
    } else if (t === 'smithing_transform' || t === 'smithing_trim') {
      out.template = items(d.template);
      out.base = items(d.base);
      out.addition = items(d.addition);
      if (t === 'smithing_transform') out.result = resultItem(d.result);
    } else if (t.endsWith(':cutting')) {
      // modsmith 语义口径：与 inspect 的 jar 提取同形
      out.ingredients = items(d.ingredient);
      out.tool = items(d.tool);
      const results = d.results ?? [];
      out.results = results.map((r) => {
        const it = resultItem(r.result ?? null);
        return it ? { ...it, chance: round3(r.chance) } : null;
      }).filter(Boolean);
      if (out.results.length === 0) out.result = null;
    } else if (t.endsWith(':cooking')) {
      out.ingredients = (Array.isArray(d.ingredients?.[0]) ? d.ingredients : [d.ingredients]).map((ids) => items(ids));
      out.result = resultItem(d.result);
      out.container = resultItem(d.container);
      out.experience = round3(d.experience);
      out.cooking_time = d.cookTime ?? null;
    } else if (t === 'twilightforest:drying') {
      // 协议里有完整数据（input/result/dryingTime），但它是方块交互配方——不是工作台网格，
      // 标 unsupported 别混进可消费计数；字段照留，人查 manifest 时看得见真值。
      out.ingredients = items(d.input);
      out.result = resultItem(d.result);
      out.cooking_time = d.dryingTime ?? null;
      out.unsupported = '晾干：方块交互配方（有 input/result/dryingTime，非工作台网格）';
    } else if (t === 'twilightforest:uncrafting') {
      out.cost = d.cost ?? null;
      out.ingredients = items(d.input);
      out.width = d.gridWidth ?? 0;
      out.height = d.gridHeight ?? 0;
      out.grid = [];
      for (let y = 0; y < (d.gridHeight ?? 0); y++) {
        const row = [];
        for (let x = 0; x < (d.gridWidth ?? 0); x++) row.push(items(d.grid?.[y]?.[x] ?? []));
        out.grid.push(row);
      }
      out.unsupported = '拆解：特殊配方（cost/input/pattern，非工作台网格）';
    } else if (t === 'twilightforest:scepter_repair') {
      out.ingredients = (d.repairItems ?? []).map((ids) => items(ids));
      const scepter = ref(d.scepter);
      out.result = scepter ? { ...scepter, count: 1 } : null;
      out.durability = d.durability ?? null;
      out.unsupported = '权杖修复：特殊配方（scepter/repairItems/durability，非工作台网格）';
    } else if (SPECIAL_UNSUPPORTED[t]) {
      out.raw = d;
      out.unsupported = SPECIAL_UNSUPPORTED[t];
    } else {
      // crafting_special_* / dough / food_serving：SimpleRecipeSerializer 只发一个 category，
      // 没有原料也没有产物数据——不是"解析失败"，是协议里就没有。标出来，别混进可消费计数。
      out.raw = d;
      out.unsupported = 'SimpleRecipeSerializer：服务端只发 category，无原料/产物数据';
    }

    if (!ok) unresolved.push(rec.name);
    else entries.push(out);
  }
  return { entries, unresolved };
}
