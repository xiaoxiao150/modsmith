/**
 * `modsmith learn` —— 让 LLM 读懂"这个 mod 怎么玩"，产出站点定义与玩法说明。
 *
 * 关键约束：**LLM 只写数据，不写代码。**
 *
 * 理由（架构决定的，不是偷懒）：Cortico 的技能是封闭 TS 联合类型，新增技能必须改源码
 * 过 tsc，没有运行时注册。所以让模型"生成技能代码"必然失败。而绝大多数 mod 交互其实
 * 都能落到已有的三种站点机制上——LLM 要做的是判断"这个方块属于哪种机制"，这是数据。
 *
 * 输入：manifest 的摘要（不是全文，200+ 方块塞不进提示词）+ 可选的 wiki 文本
 * 输出：stations[] / prompt / unsupported[] / 每条配方的交互序列
 * 验证：产出的站点用真实服务器 dry-run 一遍，失败的带错误重试
 */
import { readManifest, writeManifest } from './manifest-io.mjs';

/** 已知的站点机制。LLM 只能从这里面挑，不许发明新的。 */
export const STATION_KINDS = {
  'two-step-use': {
    summary: '先手持原料右键放上去，再手持工具右键开工，产物直接进包。没有界面。',
    examples: ['农夫乐事砧板（食材+刀）', '大多数"放上去再加工"的台子'],
    required: ['block'],
    optional: ['toolSuffix'],
  },
  'place-and-wait': {
    summary: '手持食材右键放上去，等一段时间熟成，产物弹成掉落物。没有界面。',
    examples: ['营火', '"放着烤"类的架子'],
    required: ['block'],
    optional: ['waitMs', 'slots'],
  },
  'sidecar-recipe': {
    summary: '服务端不给自己开菜单，只能由服务端模组照配方代做。需要侧车模组。',
    examples: ['农夫乐事厨锅', '有私有菜单的加工机'],
    required: ['block', 'command', 'recipeType'],
    optional: [],
  },
};

/** 从 manifest 里压出能塞进提示词的摘要。 */
export function manifestBrief(manifest, budget = { blocks: 120, recipes: 60 }) {
  const blocks = Object.entries(manifest.blocks ?? {});
  const items = Object.keys(manifest.items ?? {});
  const recipes = manifest.recipes ?? [];

  // 配方按 type 分组，每组只列几条——模型要看的是"有哪些加工方式"，不是全部条目
  const byType = new Map();
  for (const r of recipes) {
    const list = byType.get(r.type) ?? [];
    if (list.length < 8) list.push(r.id ?? r.file);
    byType.set(r.type, list);
  }

  const blockLines = blocks.slice(0, budget.blocks).map(([name, spec]) => {
    const zh = manifest.names?.[`block.${name.split(':')[1]}`]?.zh;
    const tags = (spec.tags ?? []).join(',');
    const states = (spec.states ?? []).length;
    return `${name}${zh ? ` (${zh})` : ''}${tags ? ` [${tags}]` : ''}${states > 1 ? ` {${states} 状态}` : ''}`;
  });

  const recipeLines = [...byType].map(([type, ids]) => `${type}: ${ids.join(', ')}`);

  return [
    `mod: ${manifest.mod} 版本 ${manifest.version}，命名空间 ${manifest.namespace}`,
    '',
    `方块（共 ${blocks.length} 个，列前 ${Math.min(budget.blocks, blocks.length)} 个）：`,
    ...blockLines,
    '',
    `物品（共 ${items.length} 个）：${items.slice(0, 40).join(', ')}${items.length > 40 ? ' …' : ''}`,
    '',
    `配方类型（共 ${recipes.length} 条）：`,
    ...recipeLines,
    '',
    `作物：${Object.keys(manifest.crops ?? {}).join(', ') || '（无）'}`,
    `容器候选：${(manifest.containers ?? []).join(', ') || '（无）'}`,
    `可食用：${(manifest.foods ?? []).length} 种`,
  ].join('\n');
}

/** 拼给模型的提示词。要求它只输出 JSON。 */
export function learnPrompt(manifest, wikiText = '') {
  const kinds = Object.entries(STATION_KINDS).map(([name, spec]) =>
    `- ${name}: ${spec.summary}\n    required: ${spec.required.join(', ')}${spec.optional.length ? `; optional: ${spec.optional.join(', ')}` : ''}\n    例：${spec.examples.join('、')}`,
  ).join('\n');

  return [
    '你在给一个 Minecraft 机器人做「模组语义标注」。机器人是原版协议客户端，只能通过右键/放置/走动这些动作与世界交互。',
    '',
    '## 你的任务',
    '读下面的 mod 清单，判断：',
    '1. 哪些方块是「工作站」（要放材料进去、加工、出产物），各自属于哪种已有机制',
    '2. 这段 mod 怎么玩，写成 300 字以内的中文说明（机器人会读这段来决定做什么）',
    '3. 哪些事这个客户端做不到（写清楚，免得它白试）',
    '',
    '## 可用的机制（只能从这三个里选，不许发明新的）',
    kinds,
    '',
    '## 判断要点',
    '- 名字/配方里出现 knife、board、cut、chop → 多半是 two-step-use',
    '- 配方类型是 campfire_cooking/smoking 且没有专门方块 → 用原版营火，不用新增站点',
    '- 有 recipeType 但方块有私有菜单（机器类）→ sidecar-recipe',
    '- 纯粹是装饰方块、储物箱、作物 → 不是工作站',
    '',
    '## 输出格式（只输出 JSON，不要解释、不要 markdown 代码块）',
    '{"stations":[{"id":"英文短名","kind":"机制名","block":"命名空间:方块名",',
    '  "toolSuffix":"_knife（two-step-use 用）","waitMs":30500,"slots":4,',
    '  "command":"/xxx cook {recipe}（sidecar 用）","recipeType":"ns:cooking（sidecar 用）"}],',
    ' "prompt":"中文玩法说明","unsupported":["做不到的事1","做不到的事2"]}',
    '',
    '## mod 清单',
    manifestBrief(manifest),
    wikiText ? `\n## 参考资料\n${wikiText.slice(0, 6000)}` : '',
  ].join('\n');
}

/** 从模型回复里抠出 JSON（模型常常裹一层 ```json）。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 校验模型给的结果：只接受已知机制、方块必须在 manifest 里。
 * @returns {{ ok: boolean, errors: string[], cleaned: object }}
 */
export function validateLearned(raw, manifest) {
  const errors = [];
  const cleaned = { stations: [], prompt: '', unsupported: [] };
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['输出不是对象'], cleaned };

  const blocks = manifest.blocks ?? {};
  const seen = new Set();
  for (const st of Array.isArray(raw.stations) ? raw.stations : []) {
    const kind = String(st?.kind ?? '');
    if (!(kind in STATION_KINDS)) { errors.push(`未知机制 ${kind}`); continue; }
    const block = String(st?.block ?? '');
    if (!(block in blocks)) { errors.push(`manifest 里没有方块 ${block}`); continue; }
    const id = String(st?.id ?? '').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    if (!id) { errors.push(`${block}：站点缺 id`); continue; }
    if (seen.has(id)) { errors.push(`站点 id 重复：${id}`); continue; }
    seen.add(id);

    const spec = { id, kind, block };
    if (kind === 'two-step-use' && st.toolSuffix) spec.toolSuffix = String(st.toolSuffix);
    if (kind === 'place-and-wait') {
      if (Number.isFinite(Number(st.waitMs))) spec.waitMs = Number(st.waitMs);
      if (Number.isFinite(Number(st.slots))) spec.slots = Number(st.slots);
    }
    if (kind === 'sidecar-recipe') {
      const command = String(st.command ?? '');
      if (!command.includes('{recipe}')) { errors.push(`${id}：command 缺 {recipe}`); continue; }
      spec.command = command;
      if (st.recipeType) spec.recipeType = String(st.recipeType);
      if (Number.isFinite(Number(st.cookTime))) spec.cookTime = Number(st.cookTime);
    }
    cleaned.stations.push(spec);
  }

  cleaned.prompt = String(raw.prompt ?? '').trim().slice(0, 1200);
  cleaned.unsupported = (Array.isArray(raw.unsupported) ? raw.unsupported : [])
    .map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 8);

  if (cleaned.stations.length === 0 && cleaned.unsupported.length === 0) {
    errors.push('既没给出站点，也没说明做不到什么');
  }
  return { ok: errors.length === 0, errors, cleaned };
}

/**
 * 把学到的语义并进 manifest（就地改）。
 * 已有的 stations 会被覆盖——learn 是权威来源。
 */
export function applyLearned(manifest, learned) {
  manifest.stations = learned.stations;
  if (learned.prompt) manifest.prompt = { ...(manifest.prompt ?? {}), zh: learned.prompt };
  if (learned.unsupported.length > 0) manifest.unsupported = learned.unsupported;
  return manifest;
}

/**
 * learn 主流程。
 *
 * @param {object} args CLI 参数
 * @param {object} deps { ask(prompt): Promise<string>, probe(stations, manifest): Promise<object[]> }
 */
export async function learn(manifestPath, { ask, probe, rounds = 3, wikiText = '' }, io) {
  const manifest = readManifest(manifestPath);
  if (!manifest) io.fatal(`读不了 manifest：${manifestPath}`);

  let lastErrors = [];
  let lastProbeResults = [];
  for (let round = 1; round <= rounds; round++) {
    const prompt = learnPrompt(manifest, wikiText)
      + (lastErrors.length > 0
        ? `\n\n## 上一轮的问题（改掉再交一次）\n${lastErrors.map((e) => `- ${e}`).join('\n')}`
        : '');
    const reply = await ask(prompt);
    const parsed = extractJson(reply);
    const { ok, errors, cleaned } = validateLearned(parsed, manifest);

    if (!ok) {
      lastErrors = errors;
      console.error(`  第 ${round} 轮：输出不合格 —— ${errors.slice(0, 4).join('；')}`);
      continue;
    }

    // 有服务器就实测一遍：站点摆下去右键，看行为与声明的机制是否一致
    if (probe) {
      const results = await probe(cleaned.stations, manifest);
      lastProbeResults = results;
      const bad = results.filter((r) => r.matches === false);
      if (bad.length > 0) {
        // 把"为什么不行"原样回给模型：它要据此改 kind，不是只知道"错了"
        lastErrors = bad.map((r) => `${r.id}（声明 ${r.kind}，方块 ${r.block}）：${r.why ?? r.observed ?? '实测不符'}`);
        console.error(`  第 ${round} 轮：实测不符 —— ${lastErrors.slice(0, 3).join('；')}`);
        continue;
      }
      if (results.length > 0) {
        console.error(`  第 ${round} 轮：${results.length} 个站点声明经实测确认`);
      }
    }

    applyLearned(manifest, cleaned);
    // 把实测观测一并记进站点：下游据此知道哪些站点验过、哪些开着窗
    if (lastProbeResults.length > 0) {
      const byId = new Map(lastProbeResults.map((r) => [r.id, r]));
      for (const st of manifest.stations ?? []) {
        const r = byId.get(st.id);
        if (!r) continue;
        st.opensWindow = r.opensWindow === true;
        if (r.windowType) st.windowType = String(r.windowType);
        st.verified = true;
      }
      manifest.probe = { at: new Date().toISOString(), stations: lastProbeResults.length };
    }
    writeManifest(manifestPath, manifest);
    console.error(`✓ 学到 ${cleaned.stations.length} 个站点、${cleaned.unsupported.length} 条限制`);
    for (const s of cleaned.stations) console.error(`    ${s.id} (${s.kind}) → ${s.block}`);
    if (cleaned.prompt) console.error(`  玩法说明 ${cleaned.prompt.length} 字`);
    return { ok: true, manifest, learned: cleaned };
  }

  console.error(`✗ ${rounds} 轮都没拿到可用结果：${lastErrors.slice(0, 5).join('；')}`);
  return { ok: false, manifest, errors: lastErrors };
}
