/**
 * 从 mod jar 里静态提取语义 manifest。
 *
 * 这一层**没有 LLM**，也不认识任何具体的 mod：命名空间、方块、物品、配方、tag 图、
 * 中文名全部从 jar 里读。唯一的推断是作物年龄上限（见 crops.mjs）。
 *
 * 拿不到的东西（站点用法、玩法说明）留给 `learn` 阶段，拿不到的数字 id 留给
 * `calibrate` 阶段——静态分析有边界，这是明说的。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Zip } from './zip.mjs';
import { inferCrops } from './crops.mjs';
import { resolveMissingTags } from './tag-fallback.mjs';
import { containerCandidates } from './containers.mjs';
import { compareVersions, modVersionOf } from './version.mjs';

/**
 * 包名：Cortico 的 `worlds.minecraft.mods.pack` 要逐字对上这个字符串。
 *
 * 默认 `${mod id}-${MC 版本}-${mod 版本}`。**以 id 为准而不是显示名**：id 稳定，
 * 显示名带空格和撇号（"Farmer's Delight"），推出来的东西不可预测。
 *
 * 代价是 id 不带连字符的 mod 算出来跟"手改过的部署名"不一定一致（`farmersdelight-...`
 * vs 部署里的 `farmers-delight-...`）。这种情况下用 `--pack` 指过去 —— 显式优先，
 * 而且 `inspect` 发现同目录已有同 mod 的旧清单时会直接告诉你该用哪个名字。
 */
export function packNameOf(modId, version, opts = {}) {
  if (opts.pack) return String(opts.pack);
  const id = String(modId).replace(/_/g, '-');
  const mc = String(opts.mcVersion ?? '1.21.1').trim();
  const ver = String(version ?? 'unknown').replace(/[^\w.\-]/g, '_');
  return mc ? `${id}-${mc}-${ver}` : `${id}-${ver}`;
}

/** 目录里有没有同一个 mod 的另一个包名（返回文件名，不含 .json）。 */
export function findExistingPack(dir, mod, selfName) {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.endsWith('-ids.json') || f === 'manifest.schema.json') continue;
      const name = f.slice(0, -5);
      if (name === selfName) continue;
      try {
        const other = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (other?.mod === mod) return name;
      } catch {
        // 坏文件跳过
      }
    }
  } catch {
    // 目录不存在：第一次跑，正常
  }
  return null;
}

/** 方块模型里能取到碰撞盒；取不到就当实心整块。 */
function boxFromModel(model, blockstates, name) {
  // 1.21 的 blockstates 只给 model 名，碰撞盒要看 models/block/*.json 的 elements
  const refs = [];
  const variants = blockstates?.variants;
  if (variants) {
    for (const v of Object.values(variants)) {
      const list = Array.isArray(v) ? v : [v];
      for (const item of list) if (item?.model) refs.push(item.model);
    }
  }
  if (blockstates?.multipart) {
    for (const part of blockstates.multipart) {
      if (part?.apply?.model) refs.push(part.apply.model);
    }
  }
  return { refs, model };
}

/** 从 elements 里算整体包围盒（0..1 归一化，跟 prismarine 的 box 一致）。 */
function boxFromElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const el of elements) {
    const [a, b] = el.from ?? [0, 0, 0];
    const [c, d, e] = el.to ?? [16, 16, 16];
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); z0 = Math.min(z0, c);
    x1 = Math.max(x1, c); y1 = Math.max(y1, d); z1 = Math.max(z1, e);
  }
  if (!Number.isFinite(x0)) return null;
  return [x0 / 16, y0 / 16, z0 / 16, x1 / 16, y1 / 16, z1 / 16];
}

/** 顺着 model 的 parent 链找第一个带 elements 的（模型常常继承 cube_all 之类）。 */
function resolveModel(materials, ref, depth = 0) {
  if (!ref || depth > 8) return null;
  const name = ref.includes(':') ? ref.split(':')[1] : ref;
  const ns = ref.includes(':') ? ref.split(':')[0] : null;
  const candidates = ns ? [`assets/${ns}/models/${name}.json`] : [`assets/${'__NS__'}/models/${name}.json`];
  let json = null;
  for (const c of candidates) {
    json = materials.readJson(c);
    if (json) break;
  }
  if (!json) return null;
  if (Array.isArray(json.elements) && json.elements.length > 0) return json;
  if (json.parent) return resolveModel(materials, json.parent, depth + 1);
  return null;
}

/** 掉落表 → 物品名清单。 */
function dropsOf(loot) {
  const out = [];
  const walk = (entry) => {
    if (!entry) return;
    if (typeof entry.name === 'string' && entry.type === 'minecraft:item') out.push(entry.name);
    if (Array.isArray(entry.children)) entry.children.forEach(walk);
    if (Array.isArray(entry.pools)) {
      for (const pool of entry.pools) for (const e of pool.entries ?? []) walk(e);
    }
  };
  walk(loot);
  return [...new Set(out)];
}

/**
 * 读一个 Fabric mod jar，产出 manifest 的静态部分。
 *
 * @param {string} jarPath
 * @param {{ namespace?: string }} [opts] 覆盖命名空间（jar 里读不到时用）
 */
export function inspectJar(jarPath, opts = {}) {
  const { sidecar, drop } = opts;
  const zip = Zip.open(jarPath);
  const fabric = zip.readJson('fabric.mod.json');
  if (!fabric) {
    throw new Error(`${jarPath} 不是 Fabric 模组：缺 fabric.mod.json`);
  }
  const namespace = opts.namespace || fabric.id;
  if (!namespace) throw new Error('读不到 mod id，也不会自己猜：用 --namespace 指定');
  const version = modVersionOf(fabric.version);
  const packName = packNameOf(fabric.id, version, {
    pack: opts.pack,
    mcVersion: opts.mcVersion,
  });

  // ---- 方块：blockstates 就是"有哪些方块"的唯一来源 ----
  const blockstates = new Map();
  for (const n of zip.names(`assets/${namespace}/blockstates/`)) {
    if (!n.endsWith('.json')) continue;
    const name = n.slice(`assets/${namespace}/blockstates/`.length, -5);
    const json = zip.readJson(n);
    if (json) blockstates.set(name, json);
  }

  // ---- 物品：模型目录 + 方块自带物品 ----
  const itemModels = new Set();
  for (const n of zip.names(`assets/${namespace}/models/item/`)) {
    if (!n.endsWith('.json')) continue;
    itemModels.add(n.slice(`assets/${namespace}/models/item/`.length, -5));
  }

  // ---- 语言文件 ----
  const names = {};
  for (const [lang, key] of [['zh_cn', 'zh'], ['en_us', 'en']]) {
    const data = zip.readJson(`assets/${namespace}/lang/${lang}.json`);
    if (!data) continue;
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('block.' + namespace + '.')) {
        const short = k.slice(('block.' + namespace + '.').length);
        (names[`block.${short}`] ??= {})[key] = v;
      } else if (k.startsWith('item.' + namespace + '.')) {
        const short = k.slice(('item.' + namespace + '.').length);
        (names[`item.${short}`] ??= {})[key] = v;
      }
    }
  }

  // ---- 全局方块 tag（minecraft:mineable/* 之类，用来估挖掘方式） ----
  const blockTags = new Map();
  for (const n of zip.names('data/')) {
    const m = /^data\/([^/]+)\/tags\/(blocks?)\/(.+)\.json$/.exec(n);
    if (!m) continue;
    const json = zip.readJson(n);
    if (json) blockTags.set(`${m[1]}:${m[3]}`, json.values ?? []);
  }
  const tagsOfBlock = (fullName) => {
    const out = [];
    for (const [tag, values] of blockTags) {
      if (values.includes(fullName)) out.push(tag.split(':')[1]);
    }
    return out;
  };

  // ---- 组装 blocks ----
  const blocks = {};
  for (const [name, bs] of blockstates) {
    const full = `${namespace}:${name}`;
    const { refs } = boxFromModel(null, bs, name);
    let box = null;
    for (const ref of refs) {
      const model = resolveModel(zip, ref);
      const b = boxFromElements(model?.elements);
      if (b) { box = b; break; }
    }
    const hasVariants = Object.keys(bs.variants ?? {}).length > 0;
    const states = parseStates(bs, namespace);
    // 1.21 用单数（loot_table），旧版本用复数（loot_tables）；两种都要认
    const loot = zip.readJson(`data/${namespace}/loot_table/blocks/${name}.json`)
      ?? zip.readJson(`data/${namespace}/loot_tables/blocks/${name}.json`);
    blocks[full] = {
      states,
      // 没有模型也没有状态变量的多属"技术方块"（作物/植物），给空碰撞盒
      box,
      solid: box !== null,
      drops: dropsOf(loot),
      tags: tagsOfBlock(full),
      model: refs[0] ?? '',
    };
    if (!hasVariants && !bs.multipart) {
      // 单状态方块（机器、箱子之类）模型缺失时按实心整块算，别让她以为能穿过去
      if (box === null) { blocks[full].box = [0, 0, 0, 1, 1, 1]; blocks[full].solid = true; }
    }
  }

  // ---- 物品 ----
  const items = {};
  const blockItems = new Set();
  for (const name of itemModels) {
    items[`${namespace}:${name}`] = { stack: 64 };
    if (blocks[`${namespace}:${name}`]) blockItems.add(name);
  }
  // 有方块但没 item model 的，unobtainable；有 model 才是能拿在手里的物品

  // ---- 配方 ----
  // 资源目录有两代写法：1.21 用 `recipe/`，旧版用 `recipes/`。两种都扫。
  const recipes = [];
  for (const n of zip.names('data/')) {
    if (!n.endsWith('.json')) continue;
    const m = /^data\/([^/]+)\/(recipes?)\/(.+)\.json$/.exec(n);
    if (!m) continue;
    const ns = m[1];
    const rel = m[3];
    const raw = zip.readJson(n);
    if (!raw) continue;
    const type = String(raw.type ?? '').replace(/^minecraft:/, '');
    const rec = { file: rel.split('/').pop(), type, id: `${ns}:${rel}` };
    if (type === 'crafting_shaped') {
      rec.pattern = raw.pattern ?? [];
      rec.key = raw.key ?? {};
    } else if (type === 'crafting_shapeless') {
      rec.ingredients = raw.ingredients ?? [];
    } else if (/cutting|cooking|smelting|smoking|blasting|dough/.test(type)) {
      rec.ingredients = raw.ingredients ?? [];
      rec.tool = raw.tool ?? null;
      rec.cooking_time = raw.cookingtime ?? raw.cooking_time ?? null;
      rec.container = raw.container ?? null;
      rec.experience = raw.experience ?? null;
    }
    if (raw.result !== undefined && rec.result === undefined) rec.result = raw.result;
    recipes.push(rec);
  }

  // ---- tag 图 + 候选展开 ----
  const tagmap = new Map();
  for (const n of zip.names('data/')) {
    const m = /^data\/([^/]+)\/tags\/(items?)\/(.+)\.json$/.exec(n);
    if (!m) continue;
    const json = zip.readJson(n);
    if (!json) continue;
    const values = [];
    for (const v of json.values ?? []) {
      if (typeof v === 'string') values.push(v);
      else if (v && typeof v.id === 'string') values.push(v.id);
    }
    tagmap.set(`${m[1]}:${m[3]}`, values);
  }
  const expandTag = (tag, seen = new Set()) => {
    const key = String(tag).replace(/^#/, '');
    if (seen.has(key)) return [];
    seen.add(key);
    const out = [];
    for (const v of tagmap.get(key) ?? []) {
      if (v.startsWith('#')) out.push(...expandTag(v, seen));
      else out.push(v);
    }
    return out;
  };

  const usedTags = collectTags(recipes);
  const candidates = {};
  const missing = [];
  for (const tag of usedTags) {
    const expanded = [...new Set(expandTag(tag))];
    if (expanded.length > 0) candidates[tag] = expanded;
    else missing.push(tag);
  }
  // jar 里没有的那些：按社区约定落成具体物品（原版 tag 与跨 mod 的 c: tag 都走这条）
  const filled = resolveMissingTags(missing, namespace);
  Object.assign(candidates, filled.resolved);
  const unresolvedTags = filled.stillMissing;

  // ---- 可食用物品 ----
  const foods = collectFoods(tagmap, expandTag, namespace);

  // ---- 作物 ----
  const { crops, cropNotes } = inferCrops({ blocks, items, namespace, recipes, sidecar, drop });

  // ---- 容器：只是候选，真假要 probe 阶段实测（crate 名字像却打不开） ----
  const { candidates: containerList, rejected: containerRejected } = containerCandidates(blocks, items);

  const manifest = {
    mod: fabric.id.replace(/_/g, '-'),
    version,
    namespace,
    source: jarPath.split(/[\\/]/).pop(),
    blocks,
    items,
    foods,
    crops,
    recipes,
    names,
    containers: containerList,
    // 配方里的 tag 在**生成时**就展开成具体物品：运行时不再靠启发式猜
    // （漏了这一行的话，重新生成的清单会丢掉所有 tag，配方大批变成"做不了"）
    candidates,
    // stations / prompt / unsupported 留给 learn 阶段；空数组让校验器给出 warn 而不是 error
    stations: [],
  };

  return {
    manifest,
    packName,
    unresolvedTags,
    cropNotes,
    containerRejected,
    stats: {
      blocks: Object.keys(blocks).length,
      /** 声明有多少件物品（有 item model 才算） */
      items: Object.keys(items).length,
      /** 其中有多少是真拿得到的（inspect 阶段还没量，等于声明数；calibrate 后由 verify 报实际值） */
      itemsDeclared: Object.keys(items).length,
      recipes: recipes.length,
      states: Object.values(blocks).reduce((n, b) => n + b.states.length, 0),
      foods: foods.length,
      crops: Object.keys(crops).length,
      candidates: Object.keys(candidates).length,
      unresolvedTags: unresolvedTags.length,
      containers: containerList.length,
      containersRejected: containerRejected.length,
    },
  };
}

/**
 * blockstates 的 variants/multipart → 状态组合列表。
 *
 * key 形如 `age=0,facing=north` 或单个 `normal`；值可以是数组（随机模型）。
 */
function parseStates(bs, namespace) {
  /** @type {Set<string>} */
  const out = new Set();
  const pushKey = (key) => {
    if (!key || key === 'normal' || key === '') {
      out.add('{}');
      return;
    }
    const parts = key.split(',').map((s) => s.trim()).filter(Boolean);
    const props = {};
    let ok = true;
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (!k || v === undefined) { ok = false; break; }
      props[k] = v;
    }
    out.add(ok ? JSON.stringify(props) : '{}');
  };
  for (const key of Object.keys(bs.variants ?? {})) pushKey(key);
  for (const part of bs.multipart ?? []) {
    const when = part.when;
    if (!when) { out.add('{}'); continue; }
    // multipart 的 when 是布尔组合，完整枚举太贵：只取其中最具体的一支
    const flat = flattenWhen(when);
    for (const k of Object.keys(flat)) {
      const values = flat[k];
      for (const v of values) pushKey(`${k}=${v}`);
    }
  }
  return [...out].map((s) => JSON.parse(s));
}

/** multipart 的 when 可能是 {OR:[...]} / {AND:[...]} / {prop:value}。取所有叶子。 */
function flattenWhen(when, acc = {}) {
  if (!when || typeof when !== 'object') return acc;
  for (const [k, v] of Object.entries(when)) {
    if (k === 'OR' || k === 'AND') {
      for (const sub of Array.isArray(v) ? v : [v]) flattenWhen(sub, acc);
      continue;
    }
    if (Array.isArray(v)) { acc[k] = v.map(String); continue; }
    acc[k] = [String(v)];
  }
  return acc;
}

/** 配方里出现过的所有 tag（含 key/ingredients 两种写法）。 */
function collectTags(recipes) {
  const out = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.tag === 'string') out.add(x.tag);
    for (const v of Object.values(x)) walk(v);
  };
  for (const r of recipes) {
    walk(r.key);
    walk(r.ingredients);
  }
  return [...out].sort();
}

/** 从 item tag 图里递归展开出本 mod 的可食用物品。 */
function collectFoods(tagmap, expandTag, namespace) {
  const out = new Set();
  for (const tag of tagmap.keys()) {
    if (!/foods|drinks/.test(tag)) continue;
    for (const item of expandTag(tag)) {
      if (item.startsWith(`${namespace}:`)) out.add(item);
    }
  }
  return [...out].sort();
}

export { compareVersions };
