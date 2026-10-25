/**
 * recipes --discover —— 未知序列化器的文法自动发现。
 *
 * 背景：接一个新 mod，declare_recipes 里自定义类型的 wire 文法目前靠人拿 javap 反汇编
 * fromNetwork 逐字段抄（FD 四个类型就是这么做出来的）。这件事的形状是「枚举候选文法、
 * 用整包对齐 + 物品 id 合理当 oracle」，完全可以让机器搜——FD 当天就是手工搜了 9 组组合。
 *
 * 原理（一个 oracle，两层搜索）：
 *   - 整包对齐：帧是 [varint 包号][varint 条数] + 每条 [string 名, varint typeId, payload]。
 *     已知类型的 payload 可以精确消费；未知类型只有「payload 结束处必须恰好是下一条配方的
 *     名字 + 编号」这一个约束。同类型配方在包里是连续的（服务端按序列化器分组写出），
 *     所以一个候选文法必须把这一**段**的所有出现都无残包地吃完，段尾恰好落到下一段头上。
 *   - 物品合理：解析出的 Slot id 必须 = 0（空）或 ≤ maxPlausibleItemId（已知最大 id + 余量），
 *     f32 必须有限，string 必须可打印。对不上的候选直接毙掉。
 *   - 两层：先试「形状库」（已知序列化器家族的形状，命中即带语义字段名，adopt 后 join 直接能
 *     认 :cooking/:cutting 后缀）；没命中再退到盲搜（DFS 枚举字段序列，预算封顶）。
 *
 * 守门（错名比未知更糟）：发现结果**永不自动生效**——产出
 * `sidesheets/<pack>.serializers.discovered.json`（候选按评分排序、confirmed:false），
 * 人核对后自己抄进 `<pack>.serializers.json` 才算数。多个候选都对齐时全部列出，绝不擅自挑。
 */
import { readVarint, readString, readSlot, readIngredient, readOne, VANILLA_SERIALIZERS } from './recipes.mjs';

const S = (name) => ({ name, kind: 'string' });
const V = (name) => ({ name, kind: 'varint' });
const SL = (name) => ({ name, kind: 'slot' });
const ING = (name) => ({ name, kind: 'ingredient' });
const F32 = (name) => ({ name, kind: 'f32' });
const INGS = (name) => ({ name, kind: 'ingredients' });
const OPTID = (name) => ({ name, kind: 'optional-identifier' });
const LIST = (name, item) => ({ name, kind: 'list', item });

/**
 * 形状库：已知序列化器家族的 payload 形状。命中一个就把它的语义字段名带走——
 * joinRecipes 按 :cooking/:cutting 后缀和字段名取值，盲搜出来的 f0/f1 人得自己改名。
 */
export const SHAPES = [
  { shape: 'category-only', fields: [V('category')] },
  { shape: 'group+category', fields: [S('group'), V('category')] },
  { shape: 'stonecutting-like', fields: [S('group'), ING('ingredient'), SL('result')] },
  { shape: 'group+2ing+result', fields: [S('group'), ING('ingredient'), ING('tool'), SL('result')] },
  { shape: 'smelting-like', fields: [S('group'), V('category'), ING('ingredient'), SL('result'), F32('experience'), V('cookTime')] },
  { shape: 'cooking-like', fields: [S('group'), S('category'), INGS('ingredients'), SL('result'), SL('container'), F32('experience'), V('cookTime')] },
  { shape: 'cooking-nocontainer', fields: [S('group'), S('category'), INGS('ingredients'), SL('result'), F32('experience'), V('cookTime')] },
  { shape: 'cutting-like', fields: [S('group'), ING('ingredient'), ING('tool'), LIST('results', [SL('result'), F32('chance')]), OPTID('sound')] },
  { shape: 'shapeless-like', fields: [S('group'), INGS('ingredients'), SL('result')] },
  { shape: 'shapeless+experience', fields: [S('group'), INGS('ingredients'), SL('result'), F32('experience')] },
  { shape: 'smithing-like', fields: [ING('template'), ING('base'), ING('addition'), SL('result')] },
  { shape: 'group+slot', fields: [S('group'), SL('result')] },
  { shape: 'group+varint+slot', fields: [S('group'), V('count'), SL('result')] },
];

/** 盲搜的字段序列按这个顺序枚举（先高频后低频；f32/bool 容易对齐出假阳性，放后面）。 */
const BLIND_KINDS = ['string', 'varint', 'ingredient', 'slot', 'f32', 'ingredients', 'optional-identifier', 'optional-ingredient', 'bool'];

const printName = (s) => /^[\x20-\x7e]{0,256}$/.test(s);

/** 有锚点的字段 = 能读出物品/文本的（varint/bool/f32 对任何字节都凑得齐，不算）。 */
const isAnchor = (f) => ['slot', 'ingredient', 'ingredients', 'string'].includes(f.kind)
  || (f.kind === 'list' && (f.item ?? []).some((s) => ['slot', 'ingredient', 'string'].includes(s.kind)));
const isDegenerate = (fields) => !fields.some(isAnchor);

/** 字段值的合理性（递归到 list 的子字段——不然 [list(bool),…] 这种垃圾文法靠 bool 吃字节蒙混过关）。 */
function plausibleValue(f, v, ctx) {
  if (f.kind === 'slot') {
    return v.id === 0 || (v.id >= 1 && v.id <= ctx.maxPlausibleItemId);
  }
  if (f.kind === 'f32') return Number.isFinite(v);
  if (f.kind === 'string') return printName(v);
  if (f.kind === 'ingredient' || f.kind === 'optional-ingredient') {
    return (v ?? []).every((id) => id >= 1 && id <= ctx.maxPlausibleItemId);
  }
  if (f.kind === 'list') {
    return (v ?? []).every((item) => f.item.every((sub) => plausibleValue(sub, item[sub.name], ctx)));
  }
  return true;
}

/**
 * 用一个候选文法解析一段 payload。返回 { next, data } 或 null（对不齐/越界/不合理）。
 * 合理性：Slot id = 0 或 ≤ maxPlausibleItemId；f32 有限；string 可打印；list 子字段同规则。
 */
function parsePayload(buf, off, fields, ctx) {
  const data = {};
  let cur = off;
  try {
    for (const f of fields) {
      cur = readOne(buf, cur, f, data);
      ctx.budget -= 1;
      if (ctx.budget < 0) return null;
    }
  } catch {
    return null;
  }
  for (const f of fields) {
    if (!plausibleValue(f, data[f.name], ctx)) return null;
  }
  return { next: cur, data };
}

/** 读「下一条配方的头」：string 名 + varint 编号。名字要像配方 id。 */
function tryHeader(buf, off, ctx) {
  try {
    const name = readString(buf, off);
    if (!printName(name.value) || name.value.length < 3) return null;
    const typeId = readVarint(buf, name.next);
    if (typeId.value > ctx.maxTypeId) return null;
    return { typeId: typeId.value, payloadStart: typeId.next };
  } catch {
    return null;
  }
}

/**
 * 用一个候选文法吃完 typeId 的整段（同类型配方在包里连续）。
 * 返回 { end, occurrences, slots } 或 null。slots 是这段里所有非空槽的 id（给评分与报告）。
 */
function tryRun(buf, payloadStart, typeId, grammar, ctx) {
  let pos = payloadStart;
  let occurrences = 0;
  const slots = [];
  const startBudget = ctx.budget;
  for (;;) {
    const r = parsePayload(buf, pos, grammar.fields, ctx);
    if (!r) return null;
    pos = r.next;
    occurrences += 1;
    for (const f of grammar.fields) {
      const v = r.data[f.name];
      if (f.kind === 'slot' && v.id !== 0) slots.push(v.id);
      else if ((f.kind === 'ingredient' || f.kind === 'optional-ingredient')) slots.push(...(v ?? []));
      else if (f.kind === 'list') for (const item of v ?? []) for (const sub of f.item) {
        if (sub.kind === 'slot' && item[sub.name]?.id) slots.push(item[sub.name].id);
      }
    }
    if (pos === buf.length) { ctx.trace?.('run-eof', { typeId, occ: occurrences, cost: startBudget - ctx.budget }); return { end: pos, occurrences, slots }; }
    const head = tryHeader(buf, pos, ctx);
    if (!head) { ctx.trace?.('run-fail', { typeId, occ: occurrences, cost: startBudget - ctx.budget }); return null; }
    if (head.typeId !== typeId) { ctx.trace?.('run-end', { typeId, occ: occurrences, cost: startBudget - ctx.budget }); return { end: pos, occurrences, slots }; }
    pos = head.payloadStart;
  }
}

/** 候选文法生成器：先形状库，再盲搜（DFS，深度 ≤6，至多一个 struct-list）。惰性，预算到了就停。 */
export function candidateGrammars(ctx) {
  const gen = (function* () {
    for (const s of SHAPES) yield { fields: s.fields, shape: s.shape };
    const listItems = [];
    for (const a of BLIND_KINDS) listItems.push([{ name: 'v0', kind: a }]);
    for (const a of ['slot', 'f32', 'varint', 'string', 'ingredient']) {
      for (const b of BLIND_KINDS) listItems.push([{ name: 'v0', kind: a }, { name: 'v1', kind: b }]);
    }
    const walk = function* (depth, used) {
      if (depth === 0) { yield []; return; }
      for (const kind of BLIND_KINDS) {
        for (const rest of walk(depth - 1, used)) yield [{ name: `f${6 - depth}`, kind }, ...rest];
      if (!used.list && depth >= 3) {
        for (const item of listItems) {
          for (const rest of walk(depth - 1, { ...used, list: true })) {
            yield [{ name: `f${6 - depth}`, kind: 'list', item }, ...rest];
          }
        }
      }
      }
    };
    for (let depth = 1; depth <= 6; depth++) {
      for (const fields of walk(depth, {})) yield { fields, shape: null };
    }
  })();
  return {
    [Symbol.iterator]() {
      return {
        next() {
          if (ctx.budget <= 0) return { done: true };
          const r = gen.next();
          return r.done ? r : { value: r.value, done: false };
        },
      };
    },
  };
}

/** 候选评分：命中已知物品 id 的槽多者优先；同分保持生成序（形状库优先）。 */
function scoreOf(run, ctx) {
  let score = 0;
  for (const id of run.slots) score += ctx.knownItemIds.has(id) ? 2 : 0;
  return score;
}

/**
 * 发现未知序列化器的文法。
 *
 * @param {Buffer} buf declare_recipes 原始帧（含 varint 包号前缀）
 * @param {{
 *   serializers?: Record<string, {name?: string, fields: object[]}>,  // 已知模组文法（sidesheets）
 *   knownItemIds?: Set<number>,   // 合法物品 id（vanilla 表 ∪ manifest 实测）
 *   maxItemId?: number,           // 已知最大物品 id（缺省用 knownItemIds 里的最大值）
 *   maxTypeId?: number,           // 序列化器编号上限，默认 4096
 *   budget?: number,              // 解析尝试预算，默认 200000
 *   maxCandidates?: number,       // 每个 typeId 保留几个候选，默认 5
 * }} opts
 * @returns {{ok: boolean, count: number, segments: object[], discovered: object[], candidates: object[], notes: string[]}}
 */
export function discoverSerializers(buf, opts = {}) {
  const known = opts.serializers ?? {};
  const knownItemIds = opts.knownItemIds ?? new Set();
  const maxKnown = opts.maxItemId ?? Math.max(0, ...knownItemIds);
  const ctx = {
    knownItemIds,
    maxPlausibleItemId: maxKnown + 1024,
    maxTypeId: opts.maxTypeId ?? 4096,
    budget: opts.budget ?? 200000,
    maxCandidates: opts.maxCandidates ?? 5,
    trace: opts.trace,
  };
  const notes = [];
  let head;
  let count;
  try {
    head = readVarint(buf, 0);
    count = readVarint(buf, head.next);
  } catch (err) {
    return { ok: false, count: 0, segments: [], discovered: [], candidates: {}, notes: [`帧头读不出：${err.message}`] };
  }

  /** 逐条走包：已知类型精确消费；未知类型起一段，交给候选搜索 + 递归。 */
  const segments = [];
  const discovered = [];
  const candidates = {};
  const pushCandidate = (typeId, entry) => {
    const key = JSON.stringify(entry.fields);
    const list = (candidates[typeId] ??= []);
    const hit = list.find((c) => JSON.stringify(c.fields) === key);
    if (hit) { hit.score = Math.max(hit.score, entry.score); return; }
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    if (list.length > ctx.maxCandidates) list.length = ctx.maxCandidates;
  };
  const walk = (index, cursor, solved) => {
    ctx.trace?.('walk', { index, cursor, budget: ctx.budget });
    if (ctx.budget <= 0) { notes.push('解析尝试预算耗尽——文法空间没搜完，结果不完整'); return false; }
    if (index === count.value) {
      if (cursor === buf.length) return true;
      notes.push(`第 ${count.value} 条后还剩 ${buf.length - cursor} 字节——条数或某段文法不对`);
      return false;
    }
    const header = tryHeader(buf, cursor, ctx);
    if (!header) { notes.push(`第 ${index} 条配方头读不出（@${cursor}）——前一段文法不对`); return false; }
    const grammar = VANILLA_SERIALIZERS[header.typeId]
      ?? solved[header.typeId]
      ?? (known[String(header.typeId)]
        ? { shape: 'sidesheet', fields: known[String(header.typeId)].fields ?? known[String(header.typeId)] }
        : null);
    if (grammar) {
      const r = parsePayload(buf, header.payloadStart, grammar.fields, ctx);
      if (!r) { notes.push(`第 ${index} 条（#${header.typeId}）按已知文法对不齐 @${header.payloadStart}`); return false; }
      segments.push({ index, typeId: header.typeId, start: cursor, end: r.next, known: true, occurrences: 1 });
      ctx.trace?.('known', { index, typeId: header.typeId, budget: ctx.budget });
      return walk(index + 1, r.next, solved);
    }
    // 未知类型：先把「能吃完这一段」的候选收齐（评分排序），再按序做整包验证——
    // 不能首个成功就收工：纯 varint 的退化文法对任何字节都凑得齐，会抢在真文法前面。
    ctx.trace?.('unknown-run', { index, typeId: header.typeId, budget: ctx.budget });
    const runs = [];
    for (const cand of candidateGrammars(ctx)) {
      if (ctx.budget <= 0) break;
      // 剪枝必须在 tryRun 之前：失败候选 continue 摸不到后面的 break，
      // 盲搜空间有几百万个，会把预算烧光（真实 FD 包上实测）。
      // 两个停止条件：已有命中已知物品的候选；或候选位已满（盲搜继续只会是垃圾）。
      if (cand.shape === null
        && (runs.length >= ctx.maxCandidates || runs.some((x) => x.entry.score > 0 && !x.entry.degenerate))) {
        ctx.trace?.('blind-stop', { typeId: header.typeId, budget: ctx.budget, runs: runs.length });
        break;
      }
      const run = tryRun(buf, header.payloadStart, header.typeId, cand, ctx);
      ctx.budget = Math.max(0, ctx.budget - 1);
      if (!run) continue;
      const degenerate = isDegenerate(cand.fields);
      const entry = {
        fields: cand.fields,
        shape: cand.shape,
        occurrences: run.occurrences,
        slotIds: [...new Set(run.slots)].sort((a, b) => a - b),
        score: scoreOf(run, ctx),
        degenerate,
      };
      pushCandidate(header.typeId, entry);
      ctx.trace?.('cand', { typeId: header.typeId, shape: cand.shape, kinds: cand.fields.map((f) => f.kind).join(','), occ: run.occurrences, score: entry.score, budget: ctx.budget });
      if (runs.length < ctx.maxCandidates) runs.push({ cand, run, entry });
    }
    if (runs.length === 0) {
      notes.push(`#${header.typeId} 搜不到任何能对齐的文法（预算 ${ctx.budget <= 0 ? '耗尽' : '未耗尽'}）`);
      return false;
    }
    if (runs.every((x) => x.entry.degenerate)) {
      notes.push(`#${header.typeId} 只有不含物品/字符串字段的退化文法能对齐——多半是巧合，人审时先怀疑`);
    }
    runs.sort((a, b) => b.entry.score - a.entry.score || (a.entry.degenerate ? 1 : 0) - (b.entry.degenerate ? 1 : 0));
    for (const { cand, run } of runs) {
      if (walk(index + run.occurrences, run.end, { ...solved, [header.typeId]: cand })) {
        segments.push({
          index, typeId: header.typeId, start: cursor, end: run.end,
          known: false, occurrences: run.occurrences, runStart: header.payloadStart,
        });
        discovered.push({
          typeId: header.typeId,
          fields: cand.fields,
          shape: cand.shape,
          occurrences: run.occurrences,
          slotIds: runs.find((x) => x.cand === cand).entry.slotIds,
          runStart: header.payloadStart,
          runEnd: run.end,
          packetValidated: true,
        });
        return true;
      }
    }
    notes.push(`#${header.typeId} 的候选都能吃完这段，但整包走不通——多半是别的未知类型还没解出来`);
    return false;
  };

  const ok = walk(0, count.next, {});
  if (!ok) {
    discovered.length = 0;
  } else {
    // 走通之后，探索期留下的失败分支笔记全是噪声；只有「选中的退化文法」这条还对人有用。
    for (let i = notes.length - 1; i >= 0; i--) if (!notes[i].includes('退化')) notes.splice(i, 1);
  }

  // 已发现的类型再收一轮「同样能吃完这段」的替代文法（只验段、不验整包），
  // 人审时能看到「还有哪些文法也对得上」。选中的那条标 packetValidated。
  // 替代收集是锦上添花，单独给预算，不挤占主搜索。
  ctx.budget = Math.min(ctx.budget, opts.alternatesBudget ?? 20000);
  for (const d of discovered) {
    for (const cand of candidateGrammars(ctx)) {
      if (ctx.budget <= 0) break;
      if (JSON.stringify(cand.fields) === JSON.stringify(d.fields)) continue;
      const run = tryRun(buf, d.runStart, d.typeId, cand, ctx);
      ctx.budget -= 1;
      if (!run || run.end !== d.runEnd || run.occurrences !== d.occurrences) continue;
      pushCandidate(d.typeId, {
        fields: cand.fields,
        shape: cand.shape,
        occurrences: run.occurrences,
        slotIds: [...new Set(run.slots)].sort((a, b) => a - b),
        score: scoreOf(run, ctx),
        degenerate: isDegenerate(cand.fields),
      });
    }
    const list = candidates[d.typeId] ?? [];
    const hit = list.find((c) => JSON.stringify(c.fields) === JSON.stringify(d.fields));
    if (hit) hit.packetValidated = true;
    else list.unshift({ fields: d.fields, shape: d.shape, occurrences: d.occurrences, slotIds: d.slotIds, score: Number.MAX_SAFE_INTEGER, packetValidated: true });
    list.sort((a, b) => (b.packetValidated ? 1 : 0) - (a.packetValidated ? 1 : 0) || b.score - a.score);
  }

  return {
    ok,
    count: count.value,
    segments,
    discovered,
    candidates,
    notes,
    budgetLeft: Math.max(0, ctx.budget),
  };
}

/**
 * 把发现结果变成待审的 sidesheet 文件内容。结构与正式 `<pack>.serializers.json` 相同
 * （discover 走通后 `recipes` 可直接吃它做验证），但每条带 `_confirmed: false`——
 * **必须由人核对后抄进正式 sidesheet 才生效**，这是「错名比未知更糟」的落地。
 */
export function sidesheetFromDiscovery(result, { mod = '' } = {}) {
  const serializers = {};
  for (const d of result.discovered) {
    serializers[String(d.typeId)] = {
      name: null,
      fields: d.fields,
      _confirmed: false,
      _shape: d.shape,
      _occurrences: d.occurrences,
    };
  }
  return {
    _comment: `由 modsmith recipes --discover 自动发现（${mod || '未知包'}）。`
      + ' name 为 null：序列化器的名字不在 wire 上，请从 mod 源码确认后填写。'
      + ' 字段名来自形状库推断，盲搜命中的是 f0/f1——核对后把确认的条目抄进 <pack>.serializers.json 才生效。',
    serializers,
    _candidates: result.candidates,
    _notes: result.notes,
  };
}
