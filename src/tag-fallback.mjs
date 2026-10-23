/**
 * tag 兜底展开。
 *
 * jar 里只带"这个 mod 自己声明的 tag"。像 `c:ingots/iron`、`minecraft:logs` 这种由
 * 原版或别的 mod 提供的 tag，静态读不到内容——但配方里又用到了它们。这一层按
 * Fabric/NeoForge 的 `c:` 约定落下具体物品名。
 *
 * **这份表是"约定知识"，不是某个 mod 的知识**：它描述的是社区惯例
 * （c:crops/x 指某种作物、c:ingots/x 指某种锭），所以全 mod 通用。
 */

/** 单数化，用于从 tag 名推物品名。 */
function singular(name) {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('es')) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

/**
 * 一类食物 tag 落到哪几件具体物品。
 *
 * 这些 tag 表达"某类食物"而不是"某件物品"（`c:foods/cooked_meat` 可以是熟牛肉也可以
 * 是熟猪排）。按最常见的那件落，宁可选熟牛肉也别落到不存在的东西上。
 */
const FOOD_CLASSES = {
  'foods/leafy_green': ['minecraft:kelp'],
  'foods/cooked_egg': ['minecraft:cooked_egg'],
  'foods/berry': ['minecraft:sweet_berries', 'minecraft:glow_berries'],
  'foods/cooked_meat': ['minecraft:cooked_beef', 'minecraft:cooked_porkchop'],
  'foods/vegetable': ['minecraft:carrot', 'minecraft:potato'],
  'foods/fruit': ['minecraft:apple'],
  // 生肉的 tag 名跟原版物品名不一样（raw_cod → cod），不特判会推出不存在的 minecraft:raw_cod
  'foods/raw_cod': ['minecraft:cod'],
  'foods/raw_salmon': ['minecraft:salmon'],
  'foods/raw_beef': ['minecraft:beef'],
  'foods/raw_porkchop': ['minecraft:porkchop'],
  'foods/raw_chicken': ['minecraft:chicken'],
  'foods/raw_mutton': ['minecraft:mutton'],
  'foods/raw_rabbit': ['minecraft:rabbit'],
};

/**
 * 展开一个 jar 里查不到的 tag。
 *
 * @param {string} tag 如 `c:ingots/iron` / `minecraft:logs`
 * @param {string} namespace 当前 mod 的命名空间（推 `<ns>:x` 时用）
 * @returns {string[]} 候选物品名；推不出给空数组
 */
export function fallbackTag(tag, namespace) {
  const t = tag.startsWith('c:') ? tag.slice(2) : tag;

  const mat = /^(ingots|nuggets|rods|dusts|gems|storage_blocks)\/(.+)$/.exec(t);
  if (mat) {
    const [, kind, m] = mat;
    if (kind === 'rods') return ['minecraft:stick'];
    if (kind === 'ingots') return [`minecraft:${m}_ingot`];
    if (kind === 'nuggets') return [`minecraft:${m}_nugget`];
    if (kind === 'gems') return m === 'diamond' ? ['minecraft:diamond'] : [];
    if (kind === 'storage_blocks') return [`minecraft:${m}_block`];
    return [];
  }

  if (FOOD_CLASSES[t]) return FOOD_CLASSES[t];

  // c:crops/x：先看 mod 自己有没有这件，再退回原版同名的
  const crop = /^crops\/(.+)$/.exec(t);
  if (crop) {
    const name = crop[1];
    return namespace ? [`${namespace}:${name}`, `minecraft:${name}`] : [`minecraft:${name}`];
  }
  const food = /^foods\/(.+)$/.exec(t);
  if (food) {
    const name = food[1];
    return namespace ? [`${namespace}:${name}`, `minecraft:${name}`] : [`minecraft:${name}`];
  }

  // 单一约定
  const one = {
    'buckets/water': ['minecraft:water_bucket'],
    'buckets/lava': ['minecraft:lava_bucket'],
    'buckets/milk': ['minecraft:milk_bucket'],
    'drinks/milk': ['minecraft:milk_bucket'],
    'drinks/water': ['minecraft:potion'],
    'eggs': ['minecraft:egg'],
    'bones': ['minecraft:bone'],
    'mushrooms': ['minecraft:brown_mushroom', 'minecraft:red_mushroom'],
    'slime_balls': ['minecraft:slime_ball'],
    'clay_balls': ['minecraft:clay_ball'],
    'strings': ['minecraft:string'],
    'feathers': ['minecraft:feather'],
    'leathers': ['minecraft:leather'],
    'seeds': ['minecraft:wheat_seeds'],
    'chests': ['minecraft:chest'],
    'player_workstations': [],
  };
  const dyes = /^dyes\/(.+)$/.exec(t);
  if (dyes) return [`minecraft:${dyes[1]}_dye`];

  const direct = {
    'minecraft:logs': ['minecraft:oak_log'],
    'minecraft:planks': ['minecraft:oak_planks'],
    'minecraft:stone_bricks': ['minecraft:stone_bricks'],
    'minecraft:wool': ['minecraft:white_wool'],
    'minecraft:sand': ['minecraft:sand'],
    'minecraft:coals': ['minecraft:coal'],
  };
  if (direct[tag]) return direct[tag];

  // 剩下的按单数猜：c:raw_materials/iron → minecraft:raw_iron 之类
  const raw = /^raw_materials\/(.+)$/.exec(t);
  if (raw) return [`minecraft:raw_${raw[1]}`];

  return one[t] ?? [];
}

/**
 * 给一批未解析的 tag 全部补上候选。
 *
 * @returns {{ resolved: Record<string,string[]>, stillMissing: string[] }}
 */
export function resolveMissingTags(tags, namespace) {
  const resolved = {};
  const stillMissing = [];
  for (const tag of tags) {
    const cand = fallbackTag(tag, namespace);
    if (cand.length > 0) resolved[tag] = cand;
    else stillMissing.push(tag);
  }
  return { resolved, stillMissing };
}

export { singular };
