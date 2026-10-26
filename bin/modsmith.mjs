#!/usr/bin/env node
/**
 * modsmith CLI。每个子命令都能单独跑，参数全显式，不读隐藏配置。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { findExistingPack, inspectJar } from '../src/inspect.mjs';
import { readSidecar, writeSidecar, sidecarTemplateFrom } from '../src/crops-sidecar.mjs';
import { writeManifest, manifestPaths } from '../src/manifest-io.mjs';
import { VERSION } from '../src/index.mjs';

const USAGE = `modsmith ${VERSION} — 把 Fabric mod jar 变成机器人能用的语义清单

用法：
  modsmith inspect <mod.jar> [选项]
      静态提取方块/物品/配方/tag/中文名，推断作物。不需要服务器、不调 LLM。

      --out <dir>            写到这个目录（默认 ./mods）
      --sidecar <file>       作物覆盖表（人手纠正推断的地方）
      --write-sidecar <file> 把推断结果写成 sidecar 模板，供人改
      --pack <name>          显式包名（要接已有部署就用它，逐字对上 mods.pack）
      --mc-version <ver>     包名里的 MC 版本，默认 1.21.1
      --namespace <ns>       jar 里读不到 id 时手动指定
      --quiet                只打一行结果

  modsmith probe <manifest.json> [选项]
      实测哪些容器/站点真能用（名字像不等于能用）。要用 --pack 指包名。

      --pack <name>          mods/ 下的文件名（不带 .json）
      --mods-dir <dir>       manifest/ids 目录，默认 ./mods
      --server-mods <dir>    服务器 mods 目录：ids 指纹对不上就拒绝跑
      --timeout <ms>         每次右键等多久，默认 3000
      --write-manifest       把实测结果写回清单（容器表以实测为准）
      其余参数与 calibrate 相同。

  modsmith calibrate <manifest.json> [选项]
      连一台装好 mod 的服务器，用 /setblock + /give 量出每个方块状态与物品的数字 id。

      --ids <file>           输出 ids.json（默认与 manifest 同名加 -ids）
      --host <host>          默认 127.0.0.1
      --port <port>          游戏端口，默认 25565
      --rcon-port <port>     RCON 端口，默认 port+10
      --rcon-password <pw>   RCON 密码
      --mc-version <ver>     协议版本，默认 1.21.1
      --x/--y/--z <n>        测试用的空地中心，默认 400/200/400
      --place               额外做一遍"真实放置"校准（给 setblock 改不动属性的方块）
      --resume               接着上次量：已有结果里量全的方块跳过，适合断点续跑
      --server-mods <dir>    服务器 mods 目录：把指纹记进 ids；加载时对不上就拒绝
                             （不提指纹的那次量无法发现"换过服务器/换过 jar"）
      --blocks-only         只量方块（配合 --ids 复用已有的物品结果）
      --items-only          只量物品（复用 --ids 里已有的方块结果，省时间）
      --no-selfcheck         跳过量完后的自检（不推荐：错 id 会被写进清单）
      --skip-block <n,..>   跳过点名方块：放上去服务端会崩的引信方块（看崩溃报告点名）
      --debug-items         逐件打印槽位与 type，排查物品校准用

  modsmith verify <manifest.json> [选项]
      冒烟：连服务器，检查方块认得、物品能拿、配方能合。只读，不改世界。

      --pack <name>          mods/ 下的文件名
      --ids <file>           ids.json（默认与 manifest 同名加 -ids）
      --server-mods <dir>    服务器 mods 目录：ids 指纹对不上就拒绝跑
      --mods-dir <dir>       manifest/ids 目录，默认 ./mods
      其余参数与 calibrate 相同。

  modsmith recipes <manifest.json> [选项]
      把服务端真配方（calibrate 捕获的 declare_recipes）翻进清单，替换 jar 里读的静态数据。
      解析失败的整包拒绝、翻不出名字的条目跳过、成功率 <95% 不写回（--threshold 调）。

      --capture <file>     原始捕获（默认 <manifest 同名>-recipes.raw.bin）
      --ids <file>         数字 id 反查表（默认 <manifest 同名>-ids.json）
      --serializers <file> 模组自定义序列化器文法（默认 sidesheets/<pack>.serializers.json）
      --write              真写回 manifest（默认试运行）
      --threshold <0..1>   成功率闸门，默认 0.95
      --discover           不解析清单，改跑未知序列化器的文法发现：用配方名切段给出
                           每条 payload 的精确边界，秒级找回自定义类型文法。
                           产出永远是待审候选（confirmed:false）；人核对后抄进正式
                           sidesheet 才生效——机器不替人拍板。
      --accept             人看过表之后采纳：把发现结果写进正式 sidesheet（name 从
                           清单的 type 字段推断）。之后 recipes --write 才会用它。
      --no-discover        解析失败时别自动跑发现（默认会自动跑并打印待审表）
      --budget <n>         文法搜索的解析尝试预算，默认 12000000
      --max-candidates <n> 每个类型保留几个候选
      --out <file>         发现结果的落盘路径（--write 时用）
      --server-mods <dir>  服务器 mods 目录：发现时从所有 jar + 原版 jar 扫配方名，
                           名字清单越全，切段越准（数据包跨命名空间加的配方查不到）

  modsmith onboard <mod.jar> --pack <name> [选项]
      新包接入一条龙：inspect → calibrate → probe → verify → recipes → sidecar。
      前提：jar 已经装进服务器 mods 目录（onboard 绝不自动装）。
      哪步失败就停在哪，修完重跑（配 --resume 跳过已有产物的步骤）。

      --pack <name>          必填：包名（mods/ 下的文件名，不带 .json）
      --out <dir>            manifest/ids 目录，默认 ./mods
      --resume               产物已存在的步骤直接跳过
      --skip <id,id,…>       显式跳过某些步骤（inspect/calibrate/probe/verify/recipes/sidecar）
      --plan                 只打印步骤清单，不执行
      --dry-recipes          recipes 步骤不写回 manifest（默认写，95% 闸门兜底）
      --no-build             sidecar 只出配置不编译（也就不写回命令）
      其余 --host/--port/--rcon-port/--rcon-password/--server-mods/--mc-version/--x/y/z
      与 calibrate 相同，转给需要服务器的步骤。

  modsmith merge <ids1.json> <ids2.json> ... --out <file>
      把分阶段量出来的 ids 合并（后者只覆盖它有数据的部分）。

  modsmith learn <manifest.json> [选项]
      让 LLM 读清单 + 可选 wiki，产出站点定义与玩法说明（只写数据，不写代码）。

      --wiki <url|file>      参考资料（mcmod 页面 / 导出的文本）
      --rounds <n>           最多重试几轮，默认 3
      --port / --rcon-password   给了就上服务器验证站点声明（强烈建议）
      --no-probe             不做实测验证，只做结构校验
      --timeout <ms>         每次右键等多久，默认 3000
      --mods-dir <dir>       注册表注入用，默认 ./mods
      --stations             额外验收工作站：放材料、发命令、断言产物（L3）
      --scan-blocks          把候选方块逐个右键一遍，记录开窗行为（给 learn --infer 当证据）
      --scan-limit <n>       方块扫描上限，默认 400
      模型走环境变量：MODSMITH_BASE_URL / MODSMITH_API_KEY / MODSMITH_MODEL

  modsmith sidecar <manifest.json> [选项]
      产出 sidecar-recipe 型站点的服务端侧车：一份站点配置 JSON（通用模组运行时读它）
      + 编译一次通用模组（templates/sidecar-generic，每个 MC 版本编译一回就够）。
      编译通过后才把命令写回清单。

      --out <dir>            产物目录（默认 ./sidecars）
      --station <id>         只处理某一个站点
      --op-level <n>         命令要求的权限等级，默认 2（0 = 不设门）
      --mc-version <ver>     工具链版本查 GRADLE_VERSIONS 表，默认 1.21.1
      --no-build             不编译；**默认也不写回清单**，因为没验过
      --write-command        强制写回命令（配 --no-build 时表示你自担风险）
      Gradle 从 MODSMITH_GRADLE 或 PATH 找

  modsmith --version
  modsmith --help
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function fatal(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function cmdInspect(args) {
  const jar = args._[1];
  if (!jar) fatal('inspect 要给一个 jar 路径');
  if (!existsSync(jar)) fatal(`找不到 ${jar}`);

  const sidecarPath = typeof args.sidecar === 'string' ? resolve(args.sidecar) : null;
  const { sidecar, drop } = readSidecar(sidecarPath);

  const result = inspectJar(jar, {
    namespace: typeof args.namespace === 'string' ? args.namespace : undefined,
    pack: typeof args.pack === 'string' ? args.pack : undefined,
    mcVersion: typeof args['mc-version'] === 'string' ? args['mc-version'] : undefined,
    sidecar,
    drop,
  });

  const outDir = resolve(typeof args.out === 'string' ? args.out : './mods');
  const paths = manifestPaths(outDir, result.packName);
  writeManifest(paths.manifest, result.manifest);

  // 同目录里已有这个 mod 的清单、但文件名不一样 → 多半是要接已有部署，把 --pack 告诉人
  // 只在没给 --pack 时提示：给了 --pack 说明是有意造第二份，再提示就会把自己刚写的指回去
  const existingPack = typeof args.pack === 'string'
    ? null
    : findExistingPack(outDir, result.manifest.mod, result.packName);
  if (existingPack) {
    console.error(`  ! 这个目录里已有 ${existingPack}（同一个 mod）。`);
    console.error(`    要接它请重跑：modsmith inspect <jar> --out ${outDir} --pack ${existingPack}`);
  }

  if (typeof args['write-sidecar'] === 'string') {
    const target = resolve(args['write-sidecar']);
    writeSidecar(target, sidecarTemplateFrom(result.manifest));
    console.error(`  作物 sidecar 模板：${target}`);
  }

  if (!args.quiet) {
    const s = result.stats;
    console.error(`✓ ${result.manifest.mod} ${result.manifest.version}（namespace ${result.manifest.namespace}）`);
    console.error(`  方块 ${s.blocks}（${s.states} 个状态）  物品 ${s.items}  配方 ${s.recipes}`);
    console.error(`  食物 ${s.foods}  作物 ${s.crops}  候选 tag ${s.candidates}  未解析 tag ${s.unresolvedTags}`);
    if (result.unresolvedTags.length > 0) {
      console.error(`  未解析的 tag（原版或别的 mod 提供，运行时按约定推）：${result.unresolvedTags.slice(0, 8).join(', ')}${result.unresolvedTags.length > 8 ? ' …' : ''}`);
    }
    if (result.cropNotes.length > 0) {
      console.error('  作物推断：');
      for (const n of result.cropNotes.slice(0, 12)) console.error(`    ${n}`);
    }
    console.error(`  写入 ${paths.manifest}`);
    console.error(`  下一步：modsmith learn ${paths.manifest}`);
  }
  console.log(paths.manifest);
}

async function cmdLearn(args) {
  const manifestPath = args._[1];
  if (!manifestPath) fatal('learn 要给一个 manifest 路径');
  if (!existsSync(manifestPath)) fatal(`找不到 ${manifestPath}`);

  const { learn, learnStations } = await import('../src/learn.mjs');

  // --infer：规则优先，不调模型。从清单证据推工作站（L3 的默认路径）。
  if (args.infer === true) {
    const result = await learnStations(manifestPath, {
      evidencePath: typeof args.evidence === 'string' ? args.evidence : undefined,
    }, { fatal });
    if (!result.ok) fatal('规则推断没得到工作站');
    console.log(manifestPath);
    return;
  }

  const { askModel, probeModel } = await import('../src/llm.mjs');

  const probeInfo = await probeModel();
  if (!probeInfo.ok) {
    fatal(`没有可用的模型：${probeInfo.error}
换端点用环境变量 MODSMITH_BASE_URL / MODSMITH_MODEL`);
  }
  console.error(`模型：${probeInfo.model} @ ${probeInfo.base}`);

  let wikiText = '';
  if (typeof args.wiki === 'string') {
    if (existsSync(args.wiki)) wikiText = readFileSync(args.wiki, 'utf8');
    else {
      try {
        const res = await fetch(args.wiki);
        wikiText = await res.text();
      } catch (err) {
        console.error(`  取 wiki 失败（继续，不中断）：${err.message}`);
      }
    }
  }

  // 给了服务器参数就自动上服务器验证；--no-probe 显式关掉
  let probe = null;
  const wantsProbe = args['no-probe'] !== true
    && (args.port !== undefined || args['rcon-password'] !== undefined || args['rcon-port'] !== undefined);
  if (wantsProbe) {
    const { makeStationProbe } = await import('../src/probe.mjs');
    probe = makeStationProbe({
      host: String(args.host ?? '127.0.0.1'),
      port: Number(args.port ?? 25565),
      rconPort: Number(args['rcon-port'] ?? Number(args.port ?? 25565) + 10),
      rconPassword: String(args['rcon-password'] ?? ''),
      mcVersion: String(args['mc-version'] ?? '1.21.1'),
      username: String(args.username ?? 'ModLearn'),
      pack: String(args.pack ?? ''),
      modsDir: typeof args['mods-dir'] === 'string' ? args['mods-dir'] : undefined,
      x: args.x, y: args.y, z: args.z,
      timeout: args.timeout,
    });
    console.error('实测验证：开（站点声明会拿真服务器对一遍）');
  } else {
    console.error('实测验证：关（要验就加 --port 与 --rcon-password）');
  }

  const result = await learn(manifestPath, {
    ask: (p) => askModel(p),
    probe,
    rounds: Number(args.rounds ?? 3),
    wikiText,
  }, { fatal });

  if (!result.ok) fatal('learn 没拿到可用结果');
  console.log(manifestPath);
}

async function cmdOnboard(args) {
  const jar = args._[1];
  if (!jar) fatal('onboard 要给一个 jar 路径');
  if (!existsSync(jar)) fatal(`找不到 ${jar}`);
  if (typeof args.pack !== 'string') fatal('onboard 要 --pack <name>（包名，mods/ 下的文件名，不带 .json）');
  const pack = args.pack;
  const modsDir = resolve(typeof args.out === 'string' ? args.out : './mods');
  const { onboardPlan } = await import('../src/onboard.mjs');

  const manifestPath = join(modsDir, `${pack}.json`);
  const idsPath = join(modsDir, `${pack}-ids.json`);
  let hasServerRecipes = false;
  let hasStations = false;
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      hasServerRecipes = (m.recipes ?? []).some((r) => r?._source === 'server');
      // 有非 inferred 的站点 = 人已经审过（或历史上手写过），--resume 时才算完成。
      // 只有 inferred/needsReview 的站点仍要重跑：证据变了机制可能变。
      hasStations = (m.stations ?? []).some((st) => st && st.inferred !== true);
    } catch { /* 清单坏了就当没有，inspect 会重写 */ }
  }
  const probePath = join(modsDir, `${pack}-probe.json`);
  const plan = onboardPlan({
    jar,
    pack,
    modsDir,
    server: {
      host: args.host, port: args.port, rconPort: args['rcon-port'],
      rconPassword: args['rcon-password'], mcVersion: args['mc-version'],
      serverMods: args['server-mods'], x: args.x, y: args.y, z: args.z,
    },
    skip: typeof args.skip === 'string' ? args.skip.split(',').map((s) => s.trim()).filter(Boolean) : [],
    resume: args.resume === true,
    artifacts: {
      manifest: existsSync(manifestPath),
      ids: existsSync(idsPath),
      probe: existsSync(probePath),
      stations: hasStations,
      serverRecipes: hasServerRecipes,
    },
    dryRecipes: args['dry-recipes'] === true,
    noBuild: args['no-build'] === true,
  });

  if (args.plan === true) {
    for (const s of plan.steps) {
      console.log(`${s.done ? '✓' : s.blocked ? '✗' : '·'} ${s.id.padEnd(9)} ${s.title}${s.reason ? `  (${s.reason})` : ''}`);
    }
    console.log(`manifest: ${plan.manifestPath}\nids:      ${plan.idsPath}`);
    return;
  }

  for (const s of plan.steps) {
    if (s.done) { console.error(`✓ ${s.id}：产物已存在，跳过（--resume）`); continue; }
    if (s.blocked) fatal(`${s.id} 无法执行：${s.reason}`);
    if (s.reason) console.error(`  - ${s.id}：${s.reason}`);
    console.error(`▶ ${s.id}：${s.title}`);
    await runCommand(parseArgs(s.argv));
  }
  console.error('✓ onboard 全部步骤完成。侧车 jar 与站点配置在 sidecars/ 下——装不装进服务器由你决定（绝不自动装）。');
}

/** 命令分发（main 与 onboard 的步骤执行共用；argv[0] 是命令名）。 */
async function runCommand(args) {
  const cmd = args._[0];
  switch (cmd) {
    case 'inspect': return cmdInspect(args);
    case 'recipes': {
      const mod = await import('../src/recipes-cli.mjs');
      return mod.default(args, { fatal });
    }
    case 'probe':
    case 'calibrate':
    case 'verify':
    case 'merge': {
      // 这几个要连服务器，模块在用到时才载入（inspect 不该背这个依赖）
      const mod = await import(`../src/${cmd}.mjs`);
      return mod.default(args, { fatal });
    }
    case 'learn': {
      return cmdLearn(args);
    }
    case 'sidecar': {
      const mod = await import('../src/sidecar.mjs');
      return mod.default(args, { fatal });
    }
    case 'onboard': {
      return cmdOnboard(args);
    }
    default:
      fatal(`不认识的命令：${cmd}（用 --help 看用法）`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-V') {
    console.log(VERSION);
    return;
  }
  return runCommand(parseArgs(argv));
}

void main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
