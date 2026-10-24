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
      模型走环境变量：MODSMITH_BASE_URL / MODSMITH_API_KEY / MODSMITH_MODEL

  modsmith sidecar <manifest.json> [选项]
      给 sidecar-recipe 型站点生成侧车模组源码，编译通过后才把命令写回清单。

      --out <dir>            生成到哪个目录（默认 ./sidecars）
      --station <id>         只生成某一个站点
      --op-level <n>         命令要求的权限等级，默认 2（0 = 不设门）
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

  const { learn } = await import('../src/learn.mjs');
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
  const args = parseArgs(argv);
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
    default:
      fatal(`不认识的命令：${cmd}（用 --help 看用法）`);
  }
}

void main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
