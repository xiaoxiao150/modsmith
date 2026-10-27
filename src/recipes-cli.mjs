/**
 * `modsmith recipes <manifest.json>` —— 把服务端真配方翻进清单。
 *
 * 输入三件：`<pack>-recipes.raw.bin`（calibrate 捕获的 declare_recipes 原始包）、
 * `<pack>-ids.json`（数字 id 反查）、`sidesheets/<pack>.serializers.json`（模组自定义
 * 序列化器的文法；vanilla 22 种内置）。
 *
 * 输出：manifest.recipes 替换为服务端真值，每条带 `_source: 'server'` 与游戏内配方 id。
 * 这修掉的是 jar 解析的失真：KubeJS/CraftTweaker/数据包在运行时改过的配方，jar 里读不到。
 *
 * 守门（错名比未知更糟）：解析必须整包对齐（残包拒绝）；物品名翻不回的条目跳过并计数；
 * 成功率 < 阈值（默认 95%）整份不写。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDeclareRecipes } from './recipes.mjs';
import { vanillaItemTable, joinRecipes } from './recipes-join.mjs';
import { discoverSerializers, sidesheetFromDiscovery, mergeAccepted, semanticFieldNames } from './recipes-discover.mjs';
import { readManifest, writeManifest } from './manifest-io.mjs';
import { mergeIdsTables } from './ids-merge.mjs';
import { Zip } from './zip.mjs';

/**
 * 从服务器 mods 目录里所有 jar 扫配方名（`data/<ns>/recipe(s)/<path>.json`）。
 * discover 的切段需要**整包**的名字，只靠本 mod 清单会切不开别的 mod 的未知类型。
 */
function recipeNamesFromJars(dir) {
  const names = new Set();
  const scan = (path) => {
    try {
      const zip = Zip.open(path);
      for (const n of zip.names('data/')) {
        const m = /^data\/([^/]+)\/recipes?\/(.+)\.json$/.exec(n);
        if (m) names.add(`${m[1]}:${m[2]}`);
      }
    } catch { /* 坏 jar 跳过：名字清单少几条只会让切段更保守 */ }
  };
  let jars = [];
  try { jars = readdirSync(dir).filter((f) => f.endsWith('.jar')); } catch { return names; }
  for (const f of jars) scan(join(dir, f));

  // vanilla 配方名：服务器根目录下的原版 jar（versions/<ver>/server-<ver>.jar）。
  // 切段要求"每个名字锚点正好是一条配方"，缺了 vanilla 的名字，段里就会夹着
  // 未知名配方而对不齐——所以这一步不能省。
  const root = dirname(dir);
  try { scan(join(root, 'server.jar')); } catch { /* 没有就算了 */ }
  try {
    for (const v of readdirSync(join(root, 'versions'))) {
      const d = join(root, 'versions', v);
      for (const f of readdirSync(d)) if (f.endsWith('.jar')) scan(join(d, f));
    }
  } catch { /* 没有 versions 目录 */ }
  return names;
}

/**
 * @param {Record<string, any>} args
 * @param {{fatal: (m: string) => never}} io
 */
export default async function cmdRecipes(args, io) {
  const manifestPath = args._[1];
  if (!manifestPath) io.fatal('recipes 要给一个 manifest 路径');
  const manifest = readManifest(manifestPath);
  if (!manifest) io.fatal(`读不了 manifest：${manifestPath}`);

  const base = manifestPath.replace(/\.json$/, '');
  const rawPath = String(args.capture ?? `${base}-recipes.raw.bin`);
  const idsPath = String(args.ids ?? `${base}-ids.json`);
  const mcVersion = String(args['mc-version'] ?? '1.21.1');
  const threshold = Number(args.threshold ?? 0.95);

  if (!existsSync(rawPath)) {
    io.fatal(`找不到捕获文件 ${rawPath}：跑一次 modsmith calibrate（登录时自动留存 declare_recipes 原始包）`);
  }
  const ids = readManifest(idsPath);
  if (!ids?.items) io.fatal(`读不了 ids（物品反查表）：${idsPath}`);

  // 同一个服务器装了多个包时，捕获的 declare_recipes 是**整台服务器**的配方：第二份清单
  // 翻译时必然碰到别的包的物品。只拿自己那份 ids 会有一大批"翻不出物品名"（实测
  // MD+FD 时 302/1631）。--ids-all 把目录里所有 *-ids.json 合起来用。
  if (typeof args['ids-all'] === 'string') {
    const dir = String(args['ids-all']);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /-ids\.json$/.test(f)) : [];
    if (files.length === 0) io.fatal(`--ids-all ${dir}：目录里没有 *-ids.json`);
    const others = [];
    for (const f of files.sort()) {
      if (join(dir, f) === resolve(idsPath)) continue;
      const other = readManifest(join(dir, f));
      if (other?.items) others.push({ file: f, ids: other });
    }
    const merged = mergeIdsTables(ids, others);
    // 指纹闸：不同 mod 组合下量出来的数字 id 不能混用（id 随注册顺序整体位移）。
    // 只查"同名冲突"不够——没冲突的两份表照样可能整体错位，那是最难发现的错名。
    if (merged.fingerprints.length > 1) {
      io.fatal(`--ids-all 里的 ids 来自 ${merged.fingerprints.length} 套不同的 mods 组合（指纹不一致）：`
        + '先按当前 mods 目录把每个包都重跑一次 calibrate');
    }
    if (merged.missingFingerprint.length > 0) {
      console.error(`  ! 这些 ids 没记 mods 指纹，无法确认是同一套组合：${merged.missingFingerprint.join(', ')}`);
    }
    if (merged.conflicts.length > 0) {
      for (const c of merged.conflicts.slice(0, 5)) console.error(`  ! id 冲突 ${c}`);
      io.fatal(`ids 冲突 ${merged.conflicts.length} 条：这些 ids 是不同 jar 组合下量的，先按当前 mods 目录重跑 calibrate`);
    }
    ids.items = merged.items;
    ids.blocks = merged.blocks;
    console.error(`  ids 合并了 ${files.length} 份（--ids-all）：物品 ${Object.keys(ids.items).length} 条`);
  }

  // 文法：模组自定义序列化器来自 sidesheets（键是数字编号）
  const sidecarPath = String(args.serializers ?? `./sidesheets/${manifest.mod.replace(/-/g, '_').replace(/_([0-9]+_[0-9]+)$/, '-$1')}.serializers.json`);
  const serializers = existsSync(sidecarPath)
    ? (JSON.parse(readFileSync(sidecarPath, 'utf8')).serializers ?? {})
    : {};
  if (Object.keys(serializers).length === 0) {
    console.error(`  ! 没有模组序列化器文法（找了 ${sidecarPath}）：包里若有自定义类型会解析失败——那就是需要人写文法的信号`);
  }

  const buf = readFileSync(rawPath);

  // --discover：不解清单，改跑未知序列化器的文法发现。产出永远是"待审候选"，
  // 人核对后抄进正式 sidesheet 才生效（错名比未知更糟——机器不替人拍板）。
  // 路径是"配方名切段"：名字来自清单里的配方 id + --server-mods 的 jar + 原版 jar。
  const runDiscover = () => {
    const vanilla = vanillaItemTable(mcVersion);
    const knownItemIds = new Set([...Object.keys(vanilla).map(Number), ...Object.values(ids.items ?? {})]);
    const nameOf = (id) => {
      for (const [n, i] of Object.entries(ids.items ?? {})) if (i === id) return n;
      return vanilla[id] ?? `#${id}`;
    };
    // 配方名清单：清单里已有的配方 id 就是包里的名字（inspect 从 jar 扫来的）。
    // 有了它 discover 走"切段精确求解"：每条 payload 的起止都由名字给出，
    // 不再靠盲搜整包（这是"换一个 mod 不用逐字节逆向"的关键输入）。
    const knownNames = new Set((manifest.recipes ?? []).map((r) => r.id).filter(Boolean));
    if (typeof args['server-mods'] === 'string') {
      // 整包的名字：本 mod 清单 + 服务器上所有 jar（别的 mod 的配方名也要有，否则切不开）
      for (const n of recipeNamesFromJars(args['server-mods'])) knownNames.add(n);
    }
    const budget = Number(args.budget ?? 12_000_000);
    const result = discoverSerializers(buf, {
      serializers,
      knownItemIds,
      maxItemId: Math.max(-1, ...knownItemIds),
      knownNames,
      manifestRecipes: manifest.recipes ?? [],
      budget,
      maxCandidates: Number(args['max-candidates'] ?? 8),
      trace: process.env.MODSMITH_TRACE
        ? (phase, info) => console.error(`  [trace] ${phase} ${JSON.stringify(info).slice(0, 120)}`)
        : undefined,
    });
    if (!result.ok) {
      // 整包没走通不代表颗粒无收：已收集的候选照常落盘供人审（逐类型引导——
      // 人确认一个就把它加进正式 sidesheet 重跑，十几个类型也能一个个啃下来）。
      console.error(`  ! 整包没走通（已解析段 ${result.segments.length}）：`);
      for (const n of result.notes) console.error(`    ! ${n}`);
    } else {
      console.error(`  ✓ 整包走通：${result.count} 条配方全解析（名字 ${knownNames.size} 条）`);
    }
    const kindList = (fields) => fields
      .map((f) => (f.kind === 'list' ? `list<${(f.item ?? []).map((x) => x.kind).join('|')}>` : f.kind)).join(',');
    for (const d of result.discovered) {
      console.error(`  #${d.typeId} ${d.name ?? '(名字待填)'} ${d.shape ?? '(盲搜)'} ×${d.occurrences}: ${kindList(d.fields)}`);
      console.error(`      字段名（形状推断，盲搜为 f0/f1 需人工改名）: ${d.fields.map((f) => f.name).join(', ')}`);
      const names = d.slotIds.slice(0, 5).map((id) => `${id}=${nameOf(id)}`);
      if (d.slotIds.length > 0) console.error(`      命中物品（前 5）: ${names.join(', ')}${d.slotIds.length > 5 ? ' …' : ''}`);
      if (d.sample) console.error(`      首条样例（对着配方 JSON 核语义）: ${JSON.stringify(d.sample).slice(0, 220)}`);
      for (const alt of (result.candidates[String(d.typeId)] ?? []).slice(1)) {
        console.error(`      线上同形的备选（语义不同）: ${kindList(alt.fields)}`);
      }
    }
    const candidateTypes = Object.keys(result.candidates).filter((k) => !result.discovered.some((d) => String(d.typeId) === k));
    for (const k of candidateTypes) {
      console.error(`  ? #${k} 未定（${result.candidates[k].length} 个候选）——见落盘文件的 _candidates 自行核对`);
    }
    // --accept：人看过表之后的采纳动作。写进**正式** sidesheet（name 已从清单的 type
    // 字段推断好），之后 recipes --write 才会用它。——"永不自动生效"仍然成立：
    // 生效的前提是人显式跑了 --accept。
    if (args.accept === true) {
      if (!result.ok) io.fatal('发现没整包走通，不能采纳（先把名字清单/形状补齐）');
      // 合并而不是整表覆盖：重跑 accept 时"没有新发现"是常态（类型已经被现有 sidesheet
      // 解出来），旧实现这时写空表，把人工核对过的文法抹掉（实测）。
      let existing = {};
      try {
        existing = JSON.parse(readFileSync(sidecarPath, 'utf8')).serializers ?? {};
      } catch { /* 还没有正式表 */ }
      const merged = mergeAccepted(existing, result.discovered);
      if (merged.added.length + merged.replaced.length === 0) {
        console.error(`  没有可采纳的条目（现有 ${Object.keys(existing).length} 条形文法保持不变；`
          + `待审里 ${merged.skipped.length} 条没名字）`);
      } else {
        const formal = {
          _comment: `由 modsmith recipes --discover 产出、经人 --accept 采纳（${manifest.mod}）。`
            + ' name 来自清单里该类型配方的 type 字段；字段语义请对照样例值与备选核对。'
            + ' 编号是这台服务器的注册顺序，换 jar 组合会整体位移。',
          serializers: merged.next,
        };
        mkdirSync(dirname(resolve(sidecarPath)), { recursive: true });
        writeFileSync(sidecarPath, JSON.stringify(formal, null, 2) + '\n');
        const bits = [
          merged.added.length ? `新增 ${merged.added.length}` : '',
          merged.replaced.length ? `更新 ${merged.replaced.length}` : '',
          merged.kept.length ? `保留 ${merged.kept.length}` : '',
        ].filter(Boolean).join(' / ');
        console.error(`  ✓ 已采纳（${bits}）到 ${sidecarPath}`);
        if (merged.skipped.length > 0) {
          console.error(`  · #${merged.skipped.join(', #')} 没名字，留在待审文件里——从 mod 源码确认后手填`);
        }
      }
      console.error(`  下一步：modsmith recipes <manifest> --serializers ${sidecarPath} --write`);
    }
    const outPath = String(args.out ?? sidecarPath.replace(/\.serializers\.json$/, '.serializers.discovered.json'));
    if (args.write === true) {
      // 新包第一次跑时 ./sidesheets/ 还不存在：不建目录就是 ENOENT（实测在 onboard
      // 链上直接中断，而且是在"发现成功、只差落盘"之后）。
      mkdirSync(dirname(resolve(outPath)), { recursive: true });
      writeFileSync(outPath, JSON.stringify(sidesheetFromDiscovery(result, { mod: manifest.mod }), null, 2) + '\n');
      console.error(`  ✓ 待审文法已写入 ${outPath}`);
      console.error(`  下一步（人工）：核对每个 #id 的字段序与字段名 → 抄进 ${sidecarPath} 并填 name → 重跑 modsmith recipes --write`);
    } else {
      console.error(`  试运行：不写盘。确认输出后加 --write 落盘到 ${outPath}`);
      console.log(JSON.stringify({ ok: result.ok, discovered: result.discovered.map((d) => ({ typeId: d.typeId, shape: d.shape, occurrences: d.occurrences })), candidateTypes }, null, 2));
    }
    return result;
  };

  if (args.discover) {
    runDiscover();
    return;
  }

  let parsed;
  try {
    parsed = parseDeclareRecipes(buf, { serializers });
  } catch (err) {
    // 未知序列化器 = 新 mod：自动跑一次切段发现，把待审文法写出来让人核对。
    // 这不是"猜"——发现产物永远 _confirmed:false，人不抄进正式 sidesheet 就不生效。
    if (/未知序列化器编号/.test(err.message) && args['no-discover'] !== true) {
      console.error(`  ! ${String(err.message).split('（')[0]}：自动跑一次文法发现（产物待审，不会自动生效）`);
      runDiscover();
      if (args.write === true) {
        // --write 时不能"发现了但没写清单"就返回成功：onboard 会以为这一步过了，
        // 后面拿着 javar 形状的配方去执行站点（熟成时间缺失、多原料形状不同），
        // 得到的是假失败。这里必须停下，等人审 + --accept。
        io.fatal('recipes 没有写回：文法还要人审。核对上表 → modsmith recipes <manifest> --discover --accept → 重跑 onboard --resume');
      }
      console.error('  下一步：核对上面的表，重跑同一条命令并加 --write 落盘，再把确认的条目抄进正式 sidesheet');
      return;
    }
    io.fatal(`捕获包解析失败：${err.message}\n  文法对不上时绝不猜——补 sidesheets 文法或重跑 calibrate 捕获`);
  }
  console.error(`  解析 ${parsed.recipes.length} 条配方（自定义类型 ${parsed.customTypes.length ? parsed.customTypes.join('/') : '无'}）`);

  const vanilla = vanillaItemTable(mcVersion);
  const { entries, unresolved } = joinRecipes(parsed.recipes, ids.items, vanilla);
  const ratio = entries.length / Math.max(1, parsed.recipes.length);
  const unsupported = entries.filter((e) => e.unsupported);
  const reasons = new Map();
  for (const e of unsupported) reasons.set(e.unsupported, (reasons.get(e.unsupported) ?? 0) + 1);
  console.error(`  翻译成功 ${entries.length}/${parsed.recipes.length}（${(ratio * 100).toFixed(1)}%）：可消费 ${entries.length - unsupported.length} 条，unsupported ${unsupported.length} 条`);
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.error(`    ${n} 条：${reason}`);
  }
  for (const name of unresolved.slice(0, 6)) console.error(`    翻不出物品名：${name}`);
  if (ratio < threshold) {
    // 不写清单是对的（半真值比没有更糟），但"缺了哪几条"必须可查——否则 1594 掉成 900
    // 只是一句日志，没人知道丢了什么。
    const reportPath = rawPath.replace(/\.raw\.bin$/, '.unresolved.json');
    writeFileSync(reportPath, JSON.stringify({ parsed: parsed.recipes.length, joined: entries.length, unresolved }, null, 2) + '\n');
    io.fatal(`成功率 ${(ratio * 100).toFixed(1)}% 低于阈值 ${(threshold * 100).toFixed(0)}%：manifest 保持原样（错名比未知更糟）。`
      + `\n  缺的 ${unresolved.length} 条已写到 ${reportPath}（前 10 条：${unresolved.slice(0, 10).join(', ')}）`
      + `\n  多数翻不出 = ids 太旧或 vanilla 表缺这个版本`);
  }

  const old = manifest.recipes ?? [];
  manifest.recipes = entries;
  if (args.write !== true) {
    console.error(`  试运行：不写回。检查输出后加 --write 替换 manifest.recipes（旧值 ${old.length} 条 → 服务端真值 ${entries.length} 条）`);
    console.log(JSON.stringify({ parsed: parsed.recipes.length, joined: entries.length, unresolved: unresolved.length }, null, 2));
    return;
  }
  writeManifest(manifestPath, manifest);
  console.error(`  ✓ manifest.recipes 已替换为服务端真值（${old.length} → ${entries.length} 条），全部带 _source: 'server'`);
  console.log(manifestPath);
}
