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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDeclareRecipes } from './recipes.mjs';
import { vanillaItemTable, joinRecipes } from './recipes-join.mjs';
import { discoverSerializers, sidesheetFromDiscovery } from './recipes-discover.mjs';
import { readManifest, writeManifest } from './manifest-io.mjs';

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
  if (args.discover) {
    const vanilla = vanillaItemTable(mcVersion);
    const knownItemIds = new Set([...Object.keys(vanilla).map(Number), ...Object.values(ids.items ?? {})]);
    const nameOf = (id) => {
      for (const [n, i] of Object.entries(ids.items ?? {})) if (i === id) return n;
      return vanilla[id] ?? `#${id}`;
    };
    const result = discoverSerializers(buf, {
      serializers,
      knownItemIds,
      maxItemId: Math.max(-1, ...knownItemIds),
      budget: Number(args.budget ?? 600000),
      maxCandidates: Number(args['max-candidates'] ?? 5),
    });
    if (!result.ok) {
      io.fatal(`文法发现没走通整包（已解析段 ${result.segments.length}）：\n  ${result.notes.join('\n  ')}\n  候选文件不写——对不齐的发现比没有更危险。可加 --budget 放大搜索。`);
    }
    console.error(`  ✓ 整包走通：${result.count} 条配方全解析（耗时预算 ${600000 - result.budgetLeft}）`);
    for (const d of result.discovered) {
      console.error(`  #${d.typeId} ${d.shape ?? '(盲搜)'} ×${d.occurrences}: ${d.fields.map((f) => f.kind).join(',')}`);
      console.error(`      字段名（形状推断，盲搜为 f0/f1 需人工改名）: ${d.fields.map((f) => f.name).join(', ')}`);
      const names = d.slotIds.slice(0, 5).map((id) => `${id}=${nameOf(id)}`);
      if (d.slotIds.length > 0) console.error(`      命中物品（前 5）: ${names.join(', ')}${d.slotIds.length > 5 ? ' …' : ''}`);
    }
    for (const n of result.notes) console.error(`  ! ${n}`);
    const outPath = String(args.out ?? sidecarPath.replace(/\.serializers\.json$/, '.serializers.discovered.json'));
    if (args.write === true) {
      writeFileSync(outPath, JSON.stringify(sidesheetFromDiscovery(result, { mod: manifest.mod }), null, 2) + '\n');
      console.error(`  ✓ 待审文法已写入 ${outPath}`);
      console.error(`  下一步（人工）：核对每个 #id 的字段序与字段名 → 抄进 ${sidecarPath} 并填 name → 重跑 modsmith recipes --write`);
    } else {
      console.error(`  试运行：不写盘。确认输出后加 --write 落盘到 ${outPath}`);
      console.log(JSON.stringify({ discovered: result.discovered.map((d) => ({ typeId: d.typeId, shape: d.shape, occurrences: d.occurrences })) }, null, 2));
    }
    return;
  }

  let parsed;
  try {
    parsed = parseDeclareRecipes(buf, { serializers });
  } catch (err) {
    io.fatal(`捕获包解析失败：${err.message}\n  文法对不上时绝不猜——补 sidesheets 文法或重跑 calibrate 捕获`);
  }
  console.error(`  解析 ${parsed.recipes.length} 条配方（自定义类型 ${parsed.customTypes.length ? parsed.customTypes.join('/') : '无'}）`);

  const vanilla = vanillaItemTable(mcVersion);
  const { entries, unresolved } = joinRecipes(parsed.recipes, ids.items, vanilla);
  const ratio = entries.length / Math.max(1, parsed.recipes.length);
  const unsupported = entries.filter((e) => e.unsupported).length;
  console.error(`  翻译成功 ${entries.length}/${parsed.recipes.length}（${(ratio * 100).toFixed(1)}%）：可消费 ${entries.length - unsupported} 条，unsupported ${unsupported} 条（SimpleRecipeSerializer，协议里就没有原料）`);
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
