/**
 * 工作站推断（规则优先，不调 LLM）。
 *
 * L3 的目标是「机器人能真的执行这个 mod 的加工」，第一步是知道**哪些方块是工作站、
 * 属于哪种机制**。上一版靠 LLM 从清单里猜，有两个问题：没有模型就跑不了，而且猜错
 * 了只能靠实测回炉。这里改成先从清单里能验的**证据**推：
 *
 *   - 自定义配方类型（namespace = 本 mod、不是 vanilla 家族）→ 一定有加工行为
 *   - 配方里的工具字段/工具候选（全部 `*_knife` 之类）→ 两步式站点的硬证据
 *   - 方块名与配方类型词干匹配（cooking→cooking_pot、drying→*_drying_rack）→ 站点方块
 *   - probe 的实测证据（`opensWindow`/`windowType`）→ 有私有界面就必须走侧车
 *
 * 推断结果一律带 `needsReview: true`：机制判断错了下游会白试，人扫一眼再采纳。
 * LLM 仍然可以在这之上补玩法说明，但不再负责"哪个方块是什么"。
 */

const VANILLA_STATION_TYPES = new Set([
  'crafting_shaped', 'crafting_shapeless', 'smelting', 'blasting', 'smoking',
  'campfire_cooking', 'stonecutting', 'smithing_transform', 'smithing_trim',
]);

/** 配方类型 → 可能的方块名词干（类型词干之外再兜一层别名）。 */
const STEM_ALIASES = {
  cooking: ['cooking_pot', 'pot', 'oven', 'stove'],
  cutting: ['cutting_board', 'board', 'chopping'],
  drying: ['drying_rack', 'rack'],
  uncrafting: ['uncrafting_table', 'uncrafting'],
  smoking: ['smoker'],
  // 一个方块服务多种配方时，方块名往往不提任何类型（就是 "machine"、"processor"）。
  // 兜一层通用交互方块名，免得整类配方被丢掉（真实 mod 里不少见）。
  machine: ['machine', 'processor', 'workstation', 'station', 'block'],
};

/** 被动加工：放上去等，不需要手持工具。只有在实测确认"不开窗"时才这么判。 */
const PASSIVE_STEMS = new Set(['drying']);

const shortName = (full) => String(full).split(':').pop();

/** 一组物品的最长公共后缀（要求以 _ 开头且够长，才像是"工具家族"）。 */
export function commonSuffix(ids) {
  const names = ids.map((x) => shortName(typeof x === 'string' ? x : x?.id ?? '')).filter(Boolean);
  if (names.length < 2) return null;
  let suffix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < suffix.length && i < n.length && suffix[suffix.length - 1 - i] === n[n.length - 1 - i]) i += 1;
    suffix = suffix.slice(suffix.length - i);
    if (!suffix) return null;
  }
  return suffix.length >= 4 && suffix.startsWith('_') ? suffix : null;
}

/**
 * 从某类型的配方里找工具家族后缀。**只看显式的 tool 字段**——从 ingredient 里找会把
 * "brown_mushroom/red_mushroom" 这种同族食材误判成工具（FD 实测：cooking 被判成
 * 两步式、后缀 _mushroom）。
 */
export function toolSuffixOf(recipes, items = []) {
  const counts = new Map();
  const bump = (suffix) => counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  for (const r of recipes) {
    // 服务端真值：tool 是候选物品数组，直接看共同后缀。
    if (Array.isArray(r.tool) && r.tool.length >= 2) {
      const s = commonSuffix(r.tool);
      if (s) bump(s);
      continue;
    }
    // jar 形状：tool 是一个对象，可能是
    //   {fabric:type:'fabric:any', ingredients:[{fabric:type:…}, {tag:'c:tools/knife'}]}
    //   或 {fabric:type:'farmersdelight:item_ability', action:'axe_strip'}
    // 标签 `c:tools/knife` 等价于"名字以 _knife 结尾的物品"，能反推后缀。
    const tags = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.tag === 'string') tags.push(obj.tag);
      for (const v of Object.values(obj)) if (v && typeof v === 'object') walk(v);
    };
    walk(r.tool);
    for (const tag of tags) {
      // 标签两种写法：`c:tools/knife`（带路径）和 `minecraft:axes`（只有命名空间）。
      // 先取最后一段路径、再去掉命名空间——只 split('/') 会把 `minecraft:axes`
      // 整串留下，永远匹配不上（实测踩过）。
      const seg = String(tag).split('/').pop().split(':').pop();
      // 常见工具标签直接映射成后缀。**不等 manifest.items 里有对应物品**：
      // `minecraft:axes` 是原版标签，manifest 只收模组物品，等它永远等不到
      // （FD 的拆解配方就全是斧头标签，靠这个判断"两步式"）。
      const KNOWN = { knife: '_knife', knives: '_knife', axe: '_axe', axes: '_axe',
        pickaxe: '_pickaxe', pickaxes: '_pickaxe', shovel: '_shovel', shovels: '_shovel',
        hoe: '_hoe', hoes: '_hoe', shears: '_shears', sword: '_sword', swords: '_sword' };
      const mapped = KNOWN[seg] ?? KNOWN[seg.replace(/s$/, '')] ?? null;
      if (mapped) { bump(mapped); continue; }
      // 自定义标签：退回"manifest 里有没有这个后缀的物品"的弱判断。
      for (const cand of [`_${seg}`, `_${seg.replace(/s$/, '')}`]) {
        if (items.some((it) => String(it).endsWith(cand))) { bump(cand); break; }
      }
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? { suffix: best[0], hits: best[1] } : null;
}

/** 找一个和配方类型词干对得上的方块（排除容器）。 */
export function matchBlock(type, manifest, containers) {
  const stem = String(type).split(':')[1].split('/')[0];
  const words = [stem, ...(STEM_ALIASES[stem] ?? [])].map((w) => w.replace(/_/g, ''));
  const blocks = Object.keys(manifest.blocks ?? {}).filter((b) => !containers.has(b));
  const aliases = words.slice(1);
  const scored = [];
  for (const b of blocks) {
    const s = shortName(b).replace(/_/g, '');
    // 词干（cooking）优先于别名（stove/oven）：前者是配方类型自己的名字，命中更可信。
    let score = 0;
    if (s === words[0]) score = 4;
    else if (s.includes(words[0])) score = 3;
    else for (const a of aliases) {
      if (s === a) score = Math.max(score, 2);
      else if (s.includes(a)) score = Math.max(score, 1);
    }
    if (score > 0) scored.push({ block: b, score });
  }
  scored.sort((a, b) => b.score - a.score || a.block.length - b.block.length || a.block.localeCompare(b.block));
  return { stem, chosen: scored[0]?.block ?? null, alternates: scored.slice(1, 4).map((x) => x.block) };
}

/**
 * @param {object} manifest
 * @param {{evidence?: Record<string, {opensWindow?: boolean, windowType?: string}>}} opts
 *   evidence：probe 实测的方块右键行为（key 是完整方块名）
 * @returns {{stations: object[], notes: string[], skipped: Array<{type: string, why: string}>}}
 */
export function inferStations(manifest, opts = {}) {
  const evidence = opts.evidence ?? {};
  const namespace = manifest.namespace ?? String(manifest.mod ?? '').replace(/-/g, '_');
  const containers = new Set(manifest.containers ?? []);
  const byType = new Map();
  for (const r of manifest.recipes ?? []) {
    const t = String(r.type ?? '');
    if (!t || VANILLA_STATION_TYPES.has(t) || t.startsWith('crafting_special_')) continue;
    if (!t.startsWith(`${namespace}:`)) continue;
    const list = byType.get(t) ?? [];
    list.push(r);
    byType.set(t, list);
  }

  const stations = [];
  const notes = [];
  const skipped = [];
  const usedIds = new Set();

  for (const [type, recipes] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { stem, chosen, alternates } = matchBlock(type, manifest, containers);
    if (!chosen) {
      skipped.push({ type, why: '没有对得上的方块（可能不需要方块，或是纯手持配方）' });
      continue;
    }
    // 同一个方块可以服务多种配方类型（一个机器既是锅又是熏炉）。
    // 以前这里是"已被别的类型占用"就跳过——那等于把第二种类型的配方整类丢掉，
    // 而且报告里看不出来。改成允许复用方块，只在 id 冲突时加类型后缀。
    const tool = toolSuffixOf(recipes, Object.keys(manifest.items ?? {}));
    const ev = evidence[chosen] ?? {};
    const customWindow = ev.opensWindow === true && ev.windowType && !/^minecraft:generic_\d+x\d+$/.test(ev.windowType);
    const baseId = shortName(chosen).replace(/[^a-z0-9_]/g, '_');
    const id = usedIds.has(baseId) ? `${baseId}_${stem.replace(/[^a-z0-9_]/g, '_')}` : baseId;
    usedIds.add(id);

    let kind;
    if (customWindow) kind = 'sidecar-recipe';
    else if (tool) kind = 'two-step-use';
    else if (PASSIVE_STEMS.has(stem) && ev.opensWindow === false) kind = 'place-and-wait';
    else kind = 'sidecar-recipe';

    const st = {
      id,
      kind,
      block: chosen,
      inferred: true,
      needsReview: true,
      _type: type,
      _recipes: recipes.length,
    };
    if (kind === 'two-step-use') {
      st.toolSuffix = tool.suffix;
      // 两步式也要能查出"这个站点对应哪些配方"：verify 要挑一条真的做一遍。
      // 类型名不在 wire 上就靠这个字段回连到 manifest.recipes。
      st.recipeType = type;
    }
    if (kind === 'place-and-wait') {
      // 被动站点也要能回连到配方：verify 要靠 recipeType 挑一条真做一遍。
      st.slots = 1;
      st.recipeType = type;
    }
    if (kind === 'sidecar-recipe') {
      st.command = `/${id} cook {recipe}`;
      st.recipeType = type;
    }
    stations.push(st);
    notes.push(`${type}（${recipes.length} 条）→ ${chosen} [${kind}${tool ? ` ${tool.suffix}×${tool.hits}` : ''}${customWindow ? ` 界面 ${ev.windowType}` : ''}]`
      + (alternates.length ? `；同类方块另有 ${alternates.length} 个` : ''));
  }

  return { stations, notes, skipped };
}

/**
 * 挑"值得右键一次"的方块。全量扫 500 个方块太慢，而绝大多数方块右键什么都不会发生。
 *
 * 取舍：
 *   - 已在 containers 里的不用扫（probe 的容器流程已经测过）
 *   - 多状态方块（楼梯/栅栏/门）跳过：交互行为与状态无关，扫默认态就够，但它们
 *     数量最多，且几乎都是纯装饰
 *   - 明摆着不是交互方块的按名字排除（叶/原木/矿石/台阶/墙/地毯/作物）
 *
 * @returns {{candidates: string[], skipped: {decorative: number, container: number, multiState: number}}}
 */
export function scanCandidates(manifest, { limit = 400 } = {}) {
  const containers = new Set(manifest.containers ?? []);
  const stationBlocks = new Set((manifest.stations ?? []).map((s) => s.block));
  // 第一次接入时 manifest 还没有 stations：用"自定义配方类型 → 词干匹配方块"先把
  // 最可能的工作站挑出来（cooking→cooking_pot）。不这么做，第一次跑只会扫一堆
  // 装饰方块，证据里没有真正决定机制的那几个（实测：链上两个站点都没被扫到）。
  const namespace = manifest.namespace ?? String(manifest.mod ?? '').replace(/-/g, '_');
  const typeStems = new Set();
  for (const r of manifest.recipes ?? []) {
    const t = String(r.type ?? '');
    if (!t.startsWith(`${namespace}:`) || VANILLA_STATION_TYPES.has(t)) continue;
    typeStems.add(t);
  }
  const stemMatches = new Set();
  for (const t of typeStems) {
    const { chosen } = matchBlock(t, manifest, containers);
    if (chosen) stemMatches.add(chosen);
  }
  const DECOR = /_(leaves|log|wood|planks|slab|stairs|wall|fence|fence_gate|carpet|door|trapdoor|button|pressure_plate|sign|banner|torch|lantern|ore|crop|seed|sapling|flower|grass|fern|vine|roots|mushroom_block|bud|petals|dripleaf|kelp|coral)$/;
  const candidates = [];
  const stationCandidate = [];
  let container = 0;
  let multiState = 0;
  let decorative = 0;
  for (const [name, spec] of Object.entries(manifest.blocks ?? {})) {
    if (containers.has(name)) { container += 1; continue; }
    // 已经是站点的方块**也要扫**：`inferStations` 的核心就是用实测开窗行为决定
    // 机制（有私有 GUI 就必须走侧车）。probe 的站点流程只验"声明 vs 实测"，不给
    // 推断提供证据。不扫它们，扫描结果对站点判断毫无帮助（FD 实测：两个站点都被跳过，
    // 带不带证据结果完全一样）。
    if (stationBlocks.has(name) || stemMatches.has(name)) { stationCandidate.push(name); continue; }
    const states = spec?.states ?? [];
    if (states.length > 2) { multiState += 1; continue; }
    if (DECOR.test(shortName(name))) { decorative += 1; continue; }
    candidates.push(name);
    if (candidates.length >= limit) break;
  }
  // 站点优先测：数量少、信息量大（决定机制），放最前面。
  return { candidates: [...new Set([...stationCandidate, ...candidates])], skipped: { container, multiState, decorative } };
}

/**
 * 从 probe 的 `--scan-blocks` 结果里取出 `inferStations` 要的证据格式。
 *
 * probe 的输出把每个方块的观测记在 `blockScan.evidence[方块名]`；
 * `inferStations(manifest, {evidence})` 只关心 `opensWindow` 与 `windowType`。
 * 没测成（放不下去）的方块不出现在证据里——那属于"未知"，不能当成"不开窗"。
 */
export function evidenceFromProbe(probeOut) {
  const evidence = {};
  for (const [name, ev] of Object.entries(probeOut?.blockScan?.evidence ?? {})) {
    if (!ev || ev.placed === false) continue;
    evidence[name] = {
      opensWindow: ev.opensWindow === true,
      ...(ev.windowType ? { windowType: ev.windowType } : {}),
    };
  }
  return evidence;
}
