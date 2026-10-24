/**
 * 服务端真配方的翻转：解析 declare_recipes 捕获 → 数字 id 翻回物品名 → manifest.recipes。
 *
 * 反查表两层：ids.items（本 mod，calibrate 量出）+ minecraft-data（vanilla，离线表）。
 * 翻不回名字的配方跳过并计数；成功率低于阈值整份不写——**错名比未知更糟**，半份真值
 * 混着旧 jar 数据比没有更危险。
 */
import { createRequire } from 'node:module';
import { parseDeclareRecipes } from './recipes.mjs';

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

  for (const rec of parsed) {
    const out = { id: rec.name, type: rec.type.replace(/^minecraft:/, ''), _source: 'server' };
    const d = rec.data ?? {};
    let ok = true;
    const item = (id) => {
      if (id === 0 || id == null) return null;
      const n = byId[id];
      if (!n) { ok = false; return null; }
      return { id: n };
    };
    const items = (ids) => (ids ?? []).map(item).filter(Boolean);
    const t = out.type;

    if (t === 'crafting_shapeless') {
      out.ingredients = (d.ingredients ?? []).map((ids) => items(ids));
      out.result = item(d.result);
    } else if (t === 'crafting_shaped') {
      const w = d.gridWidth ?? 0;
      const h = d.gridHeight ?? 0;
      out.width = w;
      out.height = h;
      // 网络按 [x][y]（先宽后高）存；清单的 pattern 按行（y 外层）读
      out.grid = [];
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) row.push(items(d.grid?.[x]?.[y] ?? []));
        out.grid.push(row);
      }
      out.result = item(d.result);
    } else if (t === 'smelting' || t === 'blasting' || t === 'smoking' || t === 'campfire_cooking') {
      out.ingredients = items(d.ingredient);
      out.result = item(d.result);
      out.experience = d.experience ?? null;
      out.cooking_time = d.cookTime ?? null;
    } else if (t === 'stonecutting') {
      out.ingredients = items(d.ingredient);
      out.result = item(d.result);
    } else if (t === 'smithing_transform' || t === 'smithing_trim') {
      out.template = items(d.template);
      out.base = items(d.base);
      out.addition = items(d.addition);
      if (t === 'smithing_transform') out.result = item(d.result);
    } else if (t.endsWith(':cutting')) {
      // modsmith 语义口径：与 inspect 的 jar 提取同形
      out.ingredients = items(d.ingredient);
      out.tool = items(d.tool);
      const results = d.results ?? [];
      out.results = results.map((r) => ({ ...(item(r.result ?? 0) ?? {}), chance: r.chance ?? null }));
      if (out.results.length === 0) out.result = null;
    } else if (t.endsWith(':cooking')) {
      out.ingredients = (Array.isArray(d.ingredients?.[0]) ? d.ingredients : [d.ingredients]).map((ids) => items(ids));
      out.result = item(d.result);
      out.container = item(d.container);
      out.experience = d.experience ?? null;
      out.cooking_time = d.cookTime ?? null;
    } else {
      // crafting_special / dough / food_serving 等：无原料产物的，保留原样
      out.raw = d;
    }

    if (!ok) unresolved.push(rec.name);
    else entries.push(out);
  }
  return { entries, unresolved };
}
