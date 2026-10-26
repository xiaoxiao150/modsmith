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
import { parseDeclareRecipes, readVarint, readString, readSlot, readIngredient, readOne, VANILLA_SERIALIZERS } from './recipes.mjs';

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
  // 带代价的"拆解/形状配方"：i32 代价 + 输入 + i32 数量 + 1.20.5 的三字段 pattern
  // （宽、高、grid）。网格字段必须跟 shape 一起给——盲搜的字段名对不上 gridWidth/gridHeight。
  { shape: 'cost+pattern', fields: [{ name: 'cost', kind: 'i32' }, ING('input'), { name: 'count', kind: 'i32' }, V('gridWidth'), V('gridHeight'), { name: 'grid', kind: 'grid' }] },
];

/** 盲搜的字段序列按这个顺序枚举（先高频后低频；f32/bool 容易对齐出假阳性，放后面）。 */
const BLIND_KINDS = ['string', 'varint', 'ingredient', 'slot', 'f32', 'i32', 'ingredients', 'optional-identifier', 'optional-ingredient', 'bool', 'varints'];

const printName = (s) => /^[\x09\x0a\x0d\x20-\x7e]{0,65535}$/.test(s);

/**
 * 配方名必须是资源名（`namespace:path`）。这是整包对齐最有力的一个判据：
 * 错位后从 payload 里读出来的"名字"几乎总有引号/花括号/非 ASCII，形状上一眼就否掉。
 * 只放宽到 200 字符（真实配方名远短于此）。
 */
const RECIPE_NAME = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const isRecipeName = (s) => s.length >= 3 && s.length <= 200 && RECIPE_NAME.test(s);

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
  if (f.kind === 'i32' || f.kind === 'varint' || f.kind === 'varints') return true;
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

/** 读「下一条配方的头」：string 名 + varint 编号。名字必须是资源名形状（错位后几乎不可能碰到）。 */
function tryHeader(buf, off, ctx) {
  try {
    const name = readString(buf, off);
    if (!isRecipeName(name.value)) return null;
    // 有配方名清单时（jar 扫出来的）名字必须真在清单里：错位读到的"名字"可能形状
    // 合法但根本不是配方，这一条把弱判据变成硬判据。
    if (ctx.knownNames && !ctx.knownNames.has(name.value)) return null;
    const typeId = readVarint(buf, name.next);
    if (typeId.value > ctx.maxTypeId) return null;
    return { name: name.value, typeId: typeId.value, payloadStart: typeId.next };
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

/**
 * 候选文法生成器：先形状库，再盲搜（深度 ≤6，至多一个 struct-list）。惰性，预算到了就停。
 *
 * 枚举顺序很关键：每一层**先出纯字段序列，再出带 list 的变体**。混在一起枚举时，
 * 4 字段的 scepter 文法（varint, ingredients, i32, varint）前面会排上十几万个
 * list 变体，30k 上限内根本轮不到（真实 TF 包上实测）。
 */
export function candidateGrammars(ctx) {
  const gen = (function* () {
    for (const s of SHAPES) yield { fields: s.fields, shape: s.shape };
    const listItems = [];
    for (const a of BLIND_KINDS) listItems.push([{ name: 'v0', kind: a }]);
    for (const a of ['slot', 'f32', 'varint', 'string', 'ingredient']) {
      for (const b of BLIND_KINDS) listItems.push([{ name: 'v0', kind: a }, { name: 'v1', kind: b }]);
    }
    /** 纯字段序列（不含 list）。 */
    const plain = function* (n) {
      if (n === 0) { yield []; return; }
      for (const kind of BLIND_KINDS) {
        for (const rest of plain(n - 1)) yield [{ kind }, ...rest];
      }
    };
    /** 恰好一个 list 在 pos 位置，其余是纯字段。 */
    const oneList = function* (n, pos, item) {
      if (n === 0) { yield []; return; }
      if (pos === 0) {
        for (const rest of plain(n - 1)) yield [{ kind: 'list', item }, ...rest];
      } else {
        for (const kind of BLIND_KINDS) {
          for (const rest of oneList(n - 1, pos - 1, item)) yield [{ kind }, ...rest];
        }
      }
    };
    const named = (fields) => fields.map((f, i) => ({ ...f, name: f.name ?? `f${i}` }));
    for (let depth = 1; depth <= 6; depth++) {
      for (const fields of plain(depth)) yield { fields: named(fields), shape: null };
      if (depth >= 3) {
        for (let pos = 0; pos < depth; pos++) {
          for (const item of listItems) {
            for (const fields of oneList(depth, pos, item)) yield { fields: named(fields), shape: null };
          }
        }
      }
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
 *   knownNames?: Set<string>,     // 合法配方名（jar 里 data/<ns>/recipe 目录扫出来的）：错位判据的最后一道
 *   maxItemId?: number,           // 已知最大物品 id（缺省用 knownItemIds 里的最大值）
 *   maxTypeId?: number,           // 序列化器编号上限，默认 4096
 *   budget?: number,              // 解析尝试预算，默认 200000
 *   maxCandidates?: number,       // 每个 typeId 保留几个候选，默认 5
 * }} opts
 * @returns {{ok: boolean, count: number, segments: object[], discovered: object[], candidates: object[], notes: string[]}}
 */
export function discoverSerializers(buf, opts = {}) {
  // 有配方名清单就先走"切段精确求解"：名字给出每条 payload 的起止，问题从盲搜变成
  // 有确定答案的小题（秒级）。切段不成立（清单缺失/重叠）再退回下面的整包 DFS。
  let anchoredFailNotes = null;
  if (opts.knownNames?.size > 0) {
    // 切段求解要扫候选找"所有出现都能精确对齐"的那条，给足预算（默认量大但只为内存里的计数）
    const anchored = solveAnchored(buf, { ...opts, budget: Math.max(opts.budget ?? 0, 12_000_000) });
    if (anchored?.ok) return anchored;
    // 切段失败的原因要带回给回退的盲搜结果：否则人只看到一堆"头读不出"，不知道该补名字清单
    anchoredFailNotes = anchored?.notes ?? null;
    if (opts.trace) for (const n of anchoredFailNotes ?? []) opts.trace('anchored-fail', { note: n });
  }
  const known = opts.serializers ?? {};
  const knownItemIds = opts.knownItemIds ?? new Set();
  const maxKnown = opts.maxItemId ?? Math.max(0, ...knownItemIds);
  const ctx = {
    knownItemIds,
    maxPlausibleItemId: maxKnown + 1024,
    maxTypeId: opts.maxTypeId ?? 4096,
    budget: opts.budget ?? 200000,
    maxCandidates: opts.maxCandidates ?? 5,
    knownNames: opts.knownNames,   // 配方名清单（jar 扫出来的）：头部判据从"像"升级为"是"
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
  const walk = (index, cursor, solved, seen) => {
    const mark = segments.length;
    /** 失败即回滚本层的 segments（segments 只保留当前这条路径，回执里才是"真解析过的段"）。 */
    const fail = (msg) => { if (msg) notes.push(msg); segments.length = mark; return false; };
    ctx.trace?.('walk', { index, cursor, budget: ctx.budget });
    if (ctx.budget <= 0) return fail('解析尝试预算耗尽——文法空间没搜完，结果不完整');
    if (index === count.value) {
      if (cursor === buf.length) return true;
      return fail(`第 ${count.value} 条后还剩 ${buf.length - cursor} 字节——条数或某段文法不对`);
    }
    const header = tryHeader(buf, cursor, ctx);
    if (!header) return fail(`第 ${index} 条配方头读不出（@${cursor}）——前一段文法不对`);
    // 配方名在注册表里唯一：当前路径上重复 = 前一段把游标推进了 payload 里
    if (seen.has(header.name)) return fail(`第 ${index} 条配方名重复（${header.name}）——前一段错位`);
    seen.add(header.name);
    const grammar = VANILLA_SERIALIZERS[header.typeId]
      ?? solved[header.typeId]
      ?? (known[String(header.typeId)]
        ? { shape: 'sidesheet', fields: known[String(header.typeId)].fields ?? known[String(header.typeId)] }
        : null);
    if (grammar) {
      const r = parsePayload(buf, header.payloadStart, grammar.fields, ctx);
      if (!r) { seen.delete(header.name); return fail(`第 ${index} 条（#${header.typeId}）按已知文法对不齐 @${header.payloadStart}`); }
      segments.push({ index, typeId: header.typeId, start: cursor, end: r.next, known: true, occurrences: 1 });
      ctx.trace?.('known', { index, typeId: header.typeId, budget: ctx.budget });
      if (walk(index + 1, r.next, solved, seen)) return true;
      seen.delete(header.name);
      return fail();
    }
    // 未知类型：先把「能吃完这一段」的候选收齐（评分排序），再按序做整包验证——
    // 不能首个成功就收工：纯 varint 的退化文法对任何字节都凑得齐，会抢在真文法前面。
    ctx.trace?.('unknown-run', { index, typeId: header.typeId, budget: ctx.budget });
    const runs = [];
    let shapeHits = 0;
    for (const cand of candidateGrammars(ctx)) {
      if (ctx.budget <= 0) break;
      // 形状库命中就不再盲搜：13 个形状覆盖了已知的序列化器家族，盲搜只该是兜底。
      // 不设这条，一个 1 次出现的类型就要过几十万个字段序列（真实 TF 包上实测 8 分钟）。
      if (cand.shape === null && shapeHits > 0) {
        ctx.trace?.('blind-skip', { typeId: header.typeId, budget: ctx.budget, shapes: shapeHits });
        break;
      }
      // 剪枝必须在 tryRun 之前：失败候选 continue 摸不到后面的 break，
      // 盲搜空间有几百万个，会把预算烧光（真实 FD 包上实测）。
      // 停止条件：候选位已满，或已收到两个「命中已知物品且非退化」的强候选——
      // 留两个是为了把 f32/i32 这类线上同形、语义不同的备选都摆给人看。
      if (cand.shape === null
        && (runs.length >= ctx.maxCandidates
          || runs.filter((x) => x.entry.score > 0 && !x.entry.degenerate).length >= 2)) {
        ctx.trace?.('blind-stop', { typeId: header.typeId, budget: ctx.budget, runs: runs.length });
        break;
      }
      const run = tryRun(buf, header.payloadStart, header.typeId, cand, ctx);
      ctx.budget = Math.max(0, ctx.budget - 1);
      if (!run) continue;
      if (cand.shape !== null) shapeHits += 1;
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
      seen.delete(header.name);
      return fail(`#${header.typeId} 搜不到任何能对齐的文法（预算 ${ctx.budget <= 0 ? '耗尽' : '未耗尽'}）`);
    }
    if (runs.every((x) => x.entry.degenerate)) {
      notes.push(`#${header.typeId} 只有不含物品/字符串字段的退化文法能对齐——多半是巧合，人审时先怀疑`);
    }
    runs.sort((a, b) => b.entry.score - a.entry.score || (a.entry.degenerate ? 1 : 0) - (b.entry.degenerate ? 1 : 0));
    for (const { cand, run } of runs) {
      if (walk(index + run.occurrences, run.end, { ...solved, [header.typeId]: cand }, seen)) {
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
    seen.delete(header.name);
    return fail(`#${header.typeId} 的候选都能吃完这段，但整包走不通——多半是别的未知类型还没解出来`);
  };

  const ok = walk(0, count.next, {}, new Set());
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
    notes: [...(anchoredFailNotes ?? []), ...notes],
    budgetLeft: Math.max(0, ctx.budget),
  };
}

/**
 * 用配方名清单把整包**切段**，逐段精确反推文法。
 *
 * 为什么这是正路：盲搜整包时，单次出现的类型几乎没有约束（任何短文法都能"吃完这段"），
 * 搜索树爆炸；而 jar 里的配方名是确定的——把每个名字（带长度前缀）在包里定位出来，
 * 每条 payload 的起止就都知道了。此时「找一个能把 [start,end) 恰好吃干净的字段序列」
 * 是一道有精确答案的小题，秒级收敛（暮色森林实测：2134 个名字全部唯一命中，零重叠）。
 *
 * 名字清单可以是部分的（只有本 mod 的配方名）：段内会夹着别的 mod / vanilla 的配方，
 * 段内顺序解析、段尾必须精确落到下一个名字上——约束仍然比盲搜强得多。
 *
 * @returns {null|object} 与 discoverSerializers 同形的结果；切段不成立时返回 null
 */
export function solveAnchored(buf, opts = {}) {
  const names = opts.knownNames ?? new Set();
  const known = opts.serializers ?? {};
  if (names.size === 0) return null;
  const knownItemIds = opts.knownItemIds ?? new Set();
  const maxKnown = opts.maxItemId ?? Math.max(0, ...knownItemIds);
  const ctx = {
    knownItemIds,
    maxPlausibleItemId: maxKnown + 1024,
    maxTypeId: opts.maxTypeId ?? 4096,
    budget: opts.budget ?? 200000,
    maxCandidates: opts.maxCandidates ?? 5,
    knownNames: null,   // 段内允许不在清单里的名字（别的 mod / vanilla），段尾才是硬约束
    trace: opts.trace,
  };
  const notes = [];
  let head; let count;
  try {
    head = readVarint(buf, 0);
    count = readVarint(buf, head.next);
  } catch (err) {
    return { ok: false, count: 0, segments: [], discovered: [], candidates: {}, notes: [`帧头读不出：${err.message}`] };
  }

  // ---- 1) 名字定位 ----
  const byLen = new Map();
  for (const n of names) {
    const len = Buffer.byteLength(n, 'utf8');
    if (!byLen.has(len)) byLen.set(len, new Set());
    byLen.get(len).add(n);
  }
  const firstAt = new Map();
  for (let p = 1; p + 3 < buf.length; p++) {
    const len = buf[p];
    const set = byLen.get(len);
    if (!set || p + 1 + len >= buf.length) continue;
    const name = buf.toString('utf8', p + 1, p + 1 + len);
    if (!set.has(name) || firstAt.has(name)) continue;
    firstAt.set(name, p);
  }
  const anchors = [...firstAt.entries()].map(([name, at]) => ({ name, at })).sort((a, b) => a.at - b.at);
  if (anchors.length === 0) return null;

  const spans = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    let s; let t;
    try { s = readString(buf, a.at); t = readVarint(buf, s.next); } catch { continue; }
    const end = i + 1 < anchors.length ? anchors[i + 1].at : buf.length;
    if (end < t.next) { notes.push(`名字锚点重叠：${a.name} @${a.at} 的 payload 越过下一个锚点`); return null; }
    spans.push({ name: a.name, typeId: t.value, start: a.at, payloadStart: t.next, end });
  }
  if (spans[0].start !== count.next) {
    notes.push(`第一个名字锚点不在第一条配方上（@${spans[0].start} ≠ ${count.next}）——名字清单可能不完整`);
  }

  // ---- 2) 按类型求解：候选必须把该类型的**每一次**出现都精确吃干净 ----
  //
  // 名字锚点给出每条 payload 的起止，问题从"盲搜整包"变成"有确定答案的小题"。
  // 前提是名字清单覆盖整包（manifest 里的服务端真值，或所有 jar + 原版 jar）；
  // 数据包挂到别的命名空间的配方不在清单里时，段尾会落在别处，对不齐会明确报错。
  const solved = {};
  const alternativeFits = {};
  const grammarFor = (typeId) => VANILLA_SERIALIZERS[typeId]
    ?? solved[typeId]
    ?? (known[String(typeId)]
      ? { shape: 'sidesheet', fields: known[String(typeId)].fields ?? known[String(typeId)] }
      : null);

  /** 候选解析出来的数据像不像真的：i32/f32 这类线上同形的字段靠这个排序。 */
  const scoreFit = (off, fields) => {
    const r = parsePayload(buf, off, fields, ctx);
    if (!r) return -Infinity;
    let sc = 0;
    for (const f of fields) {
      const v = r.data[f.name];
      if (f.kind === 'slot' && v?.id) sc += ctx.knownItemIds.has(v.id) ? 2 : 0;
      else if (f.kind === 'ingredient' || f.kind === 'optional-ingredient') sc += (v ?? []).filter((id) => ctx.knownItemIds.has(id)).length;
      else if (f.kind === 'i32') sc += v >= 0 && v <= 1e6 ? 1 : -1;
      else if (f.kind === 'f32') sc += v === 0 || (Math.abs(v) >= 1e-6 && Math.abs(v) <= 1e9) ? 0 : -2;
      // 线上同形的 string 读取常常是「长度 0 + 后面 4 字节当 f32/i32」：空串扣分，
      // 让真正的 i32/varint 组合赢（scepter 的耐久 9 + category 3）。
      else if (f.kind === 'string') sc += (v ?? '').length > 0 ? 1 : -1;
      else if (f.kind === 'varint') sc += v >= 0 && v <= 1e6 ? 0 : -1;
    }
    return sc;
  };

  const byType = new Map();
  for (const sp of spans) {
    const header = tryHeader(buf, sp.start, { ...ctx, knownNames: null });
    if (!header) { notes.push(`段 ${sp.name} @${sp.start} 的头读不出`); return { ok: false, count: count.value, segments: [], discovered: [], candidates: {}, notes }; }
    if (grammarFor(header.typeId)) continue;   // 已知类型（vanilla/sidesheet）留给整包验证
    if (!byType.has(header.typeId)) byType.set(header.typeId, []);
    byType.get(header.typeId).push({ header, end: sp.end });
  }

  const MAX_FITS = 16;
  const MAX_TRIES_PER_TYPE = 60000;
  for (const [typeId, occ] of [...byType].sort((a, b) => a[0] - b[0])) {
    const fits = [];
    let tried = 0;
    for (const cand of candidateGrammars(ctx)) {
      if (ctx.budget <= 0 || fits.length >= MAX_FITS || tried >= MAX_TRIES_PER_TYPE) break;
      tried += 1;
      // 候选必须把该类型的**每一次**出现都精确吃干净：段尾是硬边界，错一个字节就死。
      let ok = true;
      for (const o of occ) {
        const r = parsePayload(buf, o.header.payloadStart, cand.fields, ctx);
        if (!r || r.next !== o.end) { ok = false; break; }
      }
      if (ok) fits.push(cand);
    }
    if (fits.length === 0) {
      notes.push(`#${typeId}（${occ[0].header.name} 等 ${occ.length} 条）找不到能精确吃干净所有出现的文法`
        + `（试过 ${tried} 个候选，预算 ${ctx.budget <= 0 ? '耗尽' : '未耗尽'}）`
        + '——名字清单不完整（数据包可能在别的命名空间加了配方）：用 --server-mods 指向服务器 mods 目录（含原版 jar），或先用已有 sidesheet 跑一次 recipes 让清单带上服务端真值');
      return { ok: false, count: count.value, segments: [], discovered: [], candidates: {}, notes };
    }
    // 选中规则：数据合理性优先（i32 的 9 压过 f32 的 2.6e-41），再看形状库命中/非退化。
    fits.sort((a, b) => scoreFit(occ[0].header.payloadStart, b.fields) - scoreFit(occ[0].header.payloadStart, a.fields)
      || Number(b.shape !== null) - Number(a.shape !== null)
      || Number(isDegenerate(a.fields)) - Number(isDegenerate(b.fields)));
    solved[typeId] = { fields: fits[0].fields, shape: fits[0].shape };
    if (fits.length > 1) alternativeFits[typeId] = fits.slice(1);
    ctx.trace?.('anchor-solve', { typeId, shape: fits[0].shape, occ: occ.length, fits: fits.length });
  }

  // ---- 3) 整包验证 + 统计 ----
  const serializers = { ...known };
  for (const [typeId, g] of Object.entries(solved)) {
    serializers[typeId] = { name: known[typeId]?.name ?? `discovered#${typeId}`, fields: g.fields };
  }
  let parsed;
  try {
    parsed = parseDeclareRecipes(buf, { serializers });
  } catch (err) {
    notes.push(`段都对齐了，但整包解析失败：${err.message}`);
    return { ok: false, count: count.value, segments: [], discovered: [], candidates: {}, notes };
  }

  // 统计每个未知类型的出现次数与命中的物品 id（人审时要看"这文法读出来的东西对不对"）
  const stat = {};
  const slotOf = (fields, data, out) => {
    for (const f of fields) {
      const v = data?.[f.name];
      if (f.kind === 'slot' && v?.id) out.push(v.id);
      else if ((f.kind === 'ingredient' || f.kind === 'optional-ingredient') && Array.isArray(v)) out.push(...v);
      else if (f.kind === 'list' && Array.isArray(v)) {
        for (const item of v) for (const sub of f.item ?? []) if (sub.kind === 'slot' && item?.[sub.name]?.id) out.push(item[sub.name].id);
      } else if (f.kind === 'grid' && Array.isArray(v)) for (const row of v) for (const cell of row ?? []) out.push(...cell);
    }
  };
  for (const rec of parsed.recipes) {
    const g = solved[rec.typeId];
    if (!g) continue;
    const s = (stat[rec.typeId] ??= { occurrences: 0, slots: [], sample: null });
    s.occurrences += 1;
    if (s.sample === null) s.sample = rec.data;   // 人审对照配方 JSON 用（字段值是什么）
    slotOf(g.fields, rec.data, s.slots);
  }
  const segments = spans.map((sp) => ({ index: -1, typeId: sp.typeId, start: sp.start, end: sp.end, known: !solved[sp.typeId], occurrences: 1 }));
  const discovered = [];
  const candidates = {};
  for (const [typeId, g] of Object.entries(solved)) {
    const s = stat[typeId];
    if (!s) continue;
    const slotIds = [...new Set(s.slots)].sort((a, b) => a - b);
    const entry = {
      typeId: Number(typeId),
      fields: g.fields,
      shape: g.shape,
      occurrences: s.occurrences,
      slotIds,
      score: slotIds.reduce((n, id) => n + (ctx.knownItemIds.has(id) ? 2 : 0), 0),
      degenerate: isDegenerate(g.fields),
      sample: s.sample,
      packetValidated: true,
    };
    discovered.push({ ...entry, runStart: null, runEnd: null });
    // 线上同形的语义备选一起列出：i32 与 f32 都是 4 字节、ingredient 与 list[slot]
    // 是同一段 wire——只有人对着配方 JSON 才能拍板（sidesheet 里 _confirmed 的由来）。
    const alts = (alternativeFits[typeId] ?? []).map((c) => ({
      typeId: Number(typeId),
      fields: c.fields,
      shape: c.shape,
      occurrences: s.occurrences,
      slotIds,
      score: entry.score,
      degenerate: isDegenerate(c.fields),
      packetValidated: false,
    }));
    candidates[typeId] = [entry, ...alts].slice(0, ctx.maxCandidates);
  }
  discovered.sort((a, b) => a.typeId - b.typeId);
  ctx.trace?.('anchored-done', { types: Object.keys(solved).length, anchors: anchors.length });
  return {
    ok: true,
    count: count.value,
    segments,
    discovered,
    candidates,
    notes: notes.filter((n) => n.includes('不在第一条')),
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
