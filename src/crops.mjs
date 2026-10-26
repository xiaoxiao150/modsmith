/**
 * 作物推断。
 *
 * 这是整条管线里唯一"必须猜"的地方：jar 里没有"这个方块是作物、成熟时 age 是 3"
 * 这种数据。FD 的番茄 blockstate 有 age 0..7，实际只长到 3 —— 猜错会让校准脚本拿
 * 无效状态去 setblock，堆一屏失败。
 *
 * 所以走三档，从可信到不可信：
 *   1. sidecar 覆盖（人手写的 `crops.sidecar.json`）—— 最可信
 *   2. blockstate 的 age 值域 —— 常见情况够用
 *   3. 名字启发式 + 种子物品存在性 —— 只在没有 age 属性时才用
 *
 * **推断出来的每条都带 `_inferred` 标记**，`modsmith learn` 会按需修正，人也能直接改。
 */

/** 这些 tag 基本只出现在作物上。 */
const CROP_TAGS = ['crops', 'maintains_farmland', 'sword_efficient'];
/** 名字像作物的后缀。 */
/** 名字像植物的后缀。**带上复数形式**：tomatoes / cabbages / onions 都是复数。 */
const CROP_NAME_HINTS = /(^|_)(crops?|crops?es|colony|bush|plant|vine|sprouts?|sapling|berries|tomatoes|potatoes|cabbages|onions|carrots|beetroots|wheats?)$/;
/** 明显不是作物的（作物农场里出现的"土"和"箱子"）。 */
const NOT_CROP = /(farmland|soil|rich_soil|basket|cabinet|crate|_block$|_sack$)/;

/**
 * @param {{
 *   blocks: Record<string, {states: Array<Record<string,string>>, tags: string[], solid: boolean, drops: string[]}>,
 *   blockstates: Map<string, unknown>,
 *   namespace: string,
 *   recipes: Array<Record<string, unknown>>,
 *   sidecar?: Record<string, unknown>,
 *   drop?: string[],
 * }} input
 */
export function inferCrops({ blocks, items = {}, namespace, recipes, sidecar = {}, drop = [] }) {
  const crops = {};
  const notes = [];
  const dropped = new Set(drop);

  // 手写覆盖优先：它是唯一可信的来源。
  // 下划线开头的是注释/元数据（readSidecar 会剥，这里再兜一层，防止直接传裸 JSON）
  for (const [key, spec] of Object.entries(sidecar)) {
    if (key.startsWith('_')) continue;
    crops[key] = { ...spec, _source: 'sidecar' };
    notes.push(`${key}: 来自 sidecar`);
  }
  for (const key of Object.keys(crops)) {
    if (dropped.has(key)) {
      delete crops[key];
      notes.push(`${key}: sidecar 要求丢弃`);
    }
  }

  // sidecar 已经挂成别名的，别再当独立作物推断
  const declaredAliases = new Set(Object.values(crops).flatMap((c) => c.aliases ?? []));

  // ---- 先把"长得像作物"的全收进来，再统一决定谁是正主、谁是别名 ----
  // 顺序很关键：`budding_tomatoes` 和 `tomatoes` 都是作物形态，
  // "先到先得"的写法会把前者当独立作物（踩过）。
  const candidates = [];
  for (const [full, spec] of Object.entries(blocks)) {
    const short = full.slice(namespace.length + 1);
    if (crops[short] || dropped.has(short) || declaredAliases.has(short)) continue;
    if (NOT_CROP.test(short)) continue;
    const ages = agesOf(spec.states);
    if (ages === null) continue;
    const looksLike = CROP_NAME_HINTS.test(short)
      || (spec.tags ?? []).some((t) => CROP_TAGS.includes(t));
    if (!looksLike) continue;
    candidates.push({ short, ages });
  }
  // 名字短的优先当正主：'tomatoes' 比 'budding_tomatoes' 短
  candidates.sort((a, b) => a.short.length - b.short.length);

  for (const { short, ages } of candidates) {
    if (crops[short]) continue;
    const aliasOwner = Object.keys(crops).find((c) => {
      const base = stripPlural(c);
      return base.length >= 3 && short.includes(base) && c !== short;
    });
    if (aliasOwner) {
      const list = crops[aliasOwner].aliases ?? [];
      if (!list.includes(short)) {
        crops[aliasOwner].aliases = [...list, short];
        notes.push(`${short}: 当 ${aliasOwner} 的别名（推断）`);
      }
      continue;
    }
    const seed = guessSeed(short, blocks, recipes, namespace);
    crops[short] = {
      seed,
      max_age: ages.max,
      age_prop: 'age',
      soils: guessSoils(blocks, namespace),
      _inferred: true,
      _source: 'blockstate',
    };
    notes.push(`${short}: age 0..${ages.max}，种子 ${seed}`);
  }

  // ---- 另一种作物写法：每个生长阶段是一个独立方块（`x_stage_0`..`x_stage_7`） ----
  // 老 mod 常见（1.13 之前的主流写法）。它没有 age 属性，整块换名，所以和上面的推断
  // 完全平行。识别出来后在 crops 里标 `kind: 'stage-blocks'`，宿主按另一条路处理。
  const stageGroups = new Map();
  for (const full of Object.keys(blocks)) {
    const short = full.slice(namespace.length + 1);
    const m = /^(.+?)_stage_(\d+)$/.exec(short);
    if (!m) continue;
    const base = m[1];
    const n = Number(m[2]);
    const g = stageGroups.get(base) ?? { max: -1, stages: {} };
    g.max = Math.max(g.max, n);
    g.stages[n] = short;
    stageGroups.set(base, g);
  }
  for (const [base, g] of stageGroups) {
    if (crops[base]) continue;
    if (g.max < 1) continue;                 // 只有 stage_0 说明不是分阶段作物
    const canonical = base.replace(/_(plant|bush|crop)$/, '');
    // 分阶段方块这类老写法常常没有单独的种子物品：种下去的就是 stage_0 那一块本身
    const stage0 = g.stages[0] ?? `${base}_stage_0`;
    const seed = pickExistingSeed(
      [`${namespace}:${canonical}_seeds`, `${namespace}:${base}_seeds`, `${namespace}:${stage0}`],
      items,
    );
    crops[base] = {
      seed,
      max_age: g.max,
      age_prop: 'stage',
      kind: 'stage-blocks',
      stages: g.stages,
      soils: guessSoils(blocks, namespace),
      _inferred: true,
      _source: 'stage-blocks',
    };
    notes.push(`${base}: 分阶段方块 0..${g.max}，种子 ${seed}`);
    for (const st of Object.values(g.stages)) {
      if (crops[st]) continue;
      // 每一阶段方块也算这个作物的形态，但**不独立成作物**
      crops[base].aliases = [...(crops[base].aliases ?? []), st];
    }
  }

  // ---- 第二遍：把上一轮没赶上（因为正主还没出现）的别名归位 ----
  for (const [full, spec] of Object.entries(blocks)) {
    const short = full.slice(namespace.length + 1);
    if (crops[short] || dropped.has(short)) continue;
    if (NOT_CROP.test(short)) continue;
    if (agesOf(spec.states) === null) continue;
    const owner = Object.keys(crops).find((c) => {
      const base = stripPlural(c);
      return base.length >= 3 && short.includes(base) && c !== short;
    });
    if (!owner) continue;
    const list = crops[owner].aliases ?? [];
    if (!list.includes(short)) {
      crops[owner].aliases = [...list, short];
      notes.push(`${short}: 当 ${owner} 的别名`);
    }
  }

  return { crops, cropNotes: notes };
}

/** 从状态表里取 age 的最小/最大值；没有 age 属性给 null。 */
function agesOf(states) {
  const values = states
    .map((s) => s.age)
    .filter((v) => v !== undefined)
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 从候选里挑第一个真实存在的物品名；都不存在就给第一个（留给 learn 阶段纠正）。 */
function pickExistingSeed(candidates, items) {
  for (const c of candidates) {
    if (c in items) return c;
  }
  return candidates[0];
}

/** 去复数：tomatoes → tomato、cabbages → cabbage、onions → onion。 */
function stripPlural(name) {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('es') && /(sh|ch|x|s)es$/.test(name)) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

/**
 * 猜种子物品名。三档：
 *   1. 配方里"这个方块 ← 某种子"的种植配方（部分 mod 有）
 *   2. `<作物名>_seeds`
 *   3. 作物名的单数形式本身（FD 的洋葱/水稻就是直接种 onion / rice）
 */
function guessSeed(short, blocks, recipes, namespace) {
  const single = stripPlural(short);
  const candidates = [`${namespace}:${short}_seeds`, `${namespace}:${single}_seeds`,
    `${namespace}:${single}`, `${namespace}:${short}`];
  // 优先级 1：种植配方里 result 是这个方块、原料里有种子
  for (const c of candidates) {
    if (hasPlantingRecipe(recipes, namespace, short, c)) return c;
  }
  return pickExistingSeed(candidates, blocks);
}

function hasPlantingRecipe(recipes, namespace, cropBlock, seed) {
  const full = `${namespace}:${cropBlock}`;
  for (const r of recipes) {
    const res = r.result;
    const resId = Array.isArray(res) ? res[0]?.id : res?.id;
    if (resId !== full) continue;
    const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
    for (const ing of ings) {
      const id = Array.isArray(ing) ? ing[0]?.item : ing?.item;
      if (id === seed) return true;
    }
  }
  return false;
}

/** 能种在哪些方块上：优先找名字像土的，否则给原版农田。 */
function guessSoils(blocks, namespace) {
  const soils = Object.keys(blocks).filter((b) => /(farmland|rich_soil$|_soil$)/.test(b));
  return soils.length > 0 ? soils : ['minecraft:farmland'];
}
