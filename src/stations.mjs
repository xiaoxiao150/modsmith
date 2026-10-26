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
export function toolSuffixOf(recipes) {
  const counts = new Map();
  for (const r of recipes) {
    const list = Array.isArray(r.tool) ? r.tool : null;
    if (!list || list.length < 2) continue;
    const s = commonSuffix(list);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
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
  const usedBlocks = new Set();

  for (const [type, recipes] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { stem, chosen, alternates } = matchBlock(type, manifest, containers);
    if (!chosen) {
      skipped.push({ type, why: '没有对得上的方块（可能不需要方块，或是纯手持配方）' });
      continue;
    }
    if (usedBlocks.has(chosen)) {
      skipped.push({ type, why: `${chosen} 已被别的类型占用` });
      continue;
    }
    const tool = toolSuffixOf(recipes);
    const ev = evidence[chosen] ?? {};
    const customWindow = ev.opensWindow === true && ev.windowType && !/^minecraft:generic_\d+x\d+$/.test(ev.windowType);
    const id = shortName(chosen).replace(/[^a-z0-9_]/g, '_');

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
    if (kind === 'place-and-wait') st.slots = 1;
    if (kind === 'sidecar-recipe') {
      st.command = `/${id} cook {recipe}`;
      st.recipeType = type;
    }
    stations.push(st);
    usedBlocks.add(chosen);
    notes.push(`${type}（${recipes.length} 条）→ ${chosen} [${kind}${tool ? ` ${tool.suffix}×${tool.hits}` : ''}${customWindow ? ` 界面 ${ev.windowType}` : ''}]`
      + (alternates.length ? `；同类方块另有 ${alternates.length} 个` : ''));
  }

  return { stations, notes, skipped };
}
