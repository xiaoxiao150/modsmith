/**
 * `modsmith sidecar` —— 给 `sidecar-recipe` 型站点产出服务端侧车。
 *
 * 为什么需要它：有些站点的菜单是模组私有的，服务端不给原版协议客户端发 `open_window`
 * （农夫乐事厨锅实测七种手势都不发）。机器人拿不到界面就没法用，只能在服务端替它做。
 *
 * **形态（0.3 起收敛为通用模组）**：不再是每站点 codegen 一个模组——那会生成一堆只差
 * 常量的 Java。`templates/sidecar-generic/` 是真源码：一个 Fabric 模组，启动时读
 * `config/modsmith-sidecar/<pack>.json`（本命令产出它），逐站点注册命令。每个 MC 版本
 * 编译一次，永久复用；接新 mod 只是多一份配置，不再产出代码。
 *
 * **安全边界（生成的东西要进别人的服务器，必须守住）：**
 *   1. 只做一件事：查 RecipeManager → 验料 → 扣料 → 等熟成 → 给成品。不碰文件（配置除外）、
 *      网络、反射（只反射读 mod 自己的 cookTime，读不到用配置值）。
 *   2. 绝不自动安装：jar 留在 build 目录、配置留在 sidecars/，装不装由人决定。CLI 会明说。
 *   3. 源码留在工程里（templates/），可读可审。
 *
 * 运行时逻辑与手写的 fdchef 同源（已实机验证）。
 */
import { cpSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, delimiter, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './manifest-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(HERE, '..', 'templates', 'sidecar-generic');

/** gradle 工具链按 MC 版本查：换版本在这里加一条，别改模板。 */
const GRADLE_VERSIONS = {
  '1.21.1': { loom: '1.9-SNAPSHOT', yarnBuild: '3', loader: '0.16.9', fabricApi: '0.115.6+1.21.1' },
};

/** 通用侧车模组自己的版本号（跟 modsmith 的版本无关，别混）。 */
const SIDECAR_MOD_VERSION = '0.1.0';

/** 找 gradle：环境变量 → PATH。找不到给 null（调用方只提示，不报错）。 */
function resolveGradle() {
  const env = process.env.MODSMITH_GRADLE;
  if (env) return env;
  // Windows 上通常是 gradle.bat / gradle.cmd
  for (const name of ['gradle', 'gradle.bat', 'gradle.cmd']) {
    if (whichSync(name)) return name;
  }
  return null;
}

function whichSync(name) {
  const dirs = String(process.env.PATH ?? '').split(delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      if (existsSync(join(d, name + ext))) return true;
    }
  }
  return false;
}

/** 跑一次 gradle build，返回 {ok, tail}。 */
async function runGradle(gradle, cwd) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(gradle, ['build', '--console=plain', '-q'], {
      cwd,
      shell: process.platform === 'win32',
      env: { ...process.env, GRADLE_OPTS: process.env.GRADLE_OPTS ?? '-Dorg.gradle.jvmargs=-Xmx2G' },
    });
    let out = '';
    const cap = (buf) => { out += buf.toString(); if (out.length > 20000) out = out.slice(-20000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (err) => resolve({ ok: false, tail: String(err.message ?? err) }));
    child.on('close', (code) => resolve({ ok: code === 0, tail: out }));
  });
}

function listJars(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jar') && !f.includes('sources'));
  } catch {
    return [];
  }
}

/** 把任意 id 变成合法的命令名片段。 */
function ident(s) {
  const cleaned = String(s).replace(/[^A-Za-z0-9_]/g, '_');
  const head = /^[0-9]/.test(cleaned) ? `m_${cleaned}` : cleaned;
  return head || 'mod';
}

/** 站点 id → 命令名（小写、字母数字）。 */
function commandName(station) {
  return ident(station.id).toLowerCase();
}

/**
 * 通用侧车读的站点配置（templates/sidecar-generic 启动时扫 config/modsmith-sidecar/*.json）。
 * 纯函数：manifest 站点 → 配置对象。
 */
export function stationConfigOf(manifest, stations, opLevel) {
  const ns = manifest.namespace ?? String(manifest.mod ?? '').replace(/-/g, '_');
  return stations.map((st) => ({
    id: st.id,
    label: manifest.names?.[`block.${String(st.block).split(':')[1]}`]?.zh ?? String(st.block).split(':')[1],
    command: commandName(st),
    block: st.block,
    recipeType: st.recipeType ?? `${ns}:cooking`,
    cookTime: Number.isFinite(Number(st.cookTime)) ? Number(st.cookTime) : 200,
    opLevel,
    ...(typeof st.heatTag === 'string' && st.heatTag ? { heatTag: st.heatTag } : {}),
  }));
}

/**
 * @param {Record<string, any>} args
 * @param {{fatal: (m: string) => never}} io
 */
export default async function cmdSidecar(args, io) {
  const manifestPath = args._[1];
  if (!manifestPath) io.fatal('sidecar 要给一个 manifest 路径');
  const manifest = readManifest(manifestPath);
  if (!manifest) io.fatal(`读不了 manifest：${manifestPath}`);

  const stations = (manifest.stations ?? []).filter((s) => s.kind === 'sidecar-recipe');
  if (stations.length === 0) {
    io.fatal('这份 manifest 里没有 sidecar-recipe 型站点；跑 modsmith learn 先');
  }
  const only = typeof args.station === 'string' ? args.station : null;
  const targets = only ? stations.filter((s) => s.id === only) : stations;
  if (targets.length === 0) io.fatal(`没有叫「${only}」的 sidecar 站点`);

  const outRoot = String(args.out ?? './sidecars');
  const mcVersion = String(args['mc-version'] ?? '1.21.1');
  const pack = basename(manifestPath).replace(/\.json$/, '');
  const opLevel = Number(args['op-level'] ?? 2) || 0;

  const gradleRow = GRADLE_VERSIONS[mcVersion];
  if (!gradleRow) {
    io.fatal(`不认识 MC ${mcVersion} 对应的工具链版本：往 src/sidecar.mjs 的 GRADLE_VERSIONS 加一条（loom/yarn build/loader/fabric-api）`);
  }

  // ---- 1) 站点配置：通用模组运行时读的就是它 ----
  const config = stationConfigOf(manifest, targets, opLevel);
  const configDir = join(outRoot, pack, 'config', 'modsmith-sidecar');
  const configPath = join(configDir, `${pack}.json`);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ pack, stations: config }, null, 2) + '\n', 'utf8');
  console.error(`✓ 站点配置 ${config.length} 个 → ${configPath}`);
  for (const st of config) {
    console.error(`   /${st.command} cook <recipe>  ${st.block}（配方类型 ${st.recipeType}${st.heatTag ? `，热源 ${st.heatTag}` : ''}）`);
  }

  // ---- 2) 编译通用模组（一次；所有站点共享这个 jar）----
  let built = false;
  if (args['no-build'] !== true) {
    const gradle = resolveGradle();
    if (!gradle) {
      console.error('! 找不到 gradle，跳过编译。装好 gradle 后设 MODSMITH_GRADLE 或放进 PATH 再跑一次。');
      console.error('  发行版：https://services.gradle.org/distributions/gradle-8.12-bin.zip（约 130MB）');
    } else {
      const workDir = join(outRoot, '.build');
      cpSync(TEMPLATE_DIR, workDir, { recursive: true, force: true });
      const props = readFileSync(join(workDir, 'gradle.properties'), 'utf8')
        .replace(/minecraft_version=.*/, `minecraft_version=${mcVersion}`)
        .replace(/yarn_build=.*/, `yarn_build=${gradleRow.yarnBuild}`)
        .replace(/loader_version=.*/, `loader_version=${gradleRow.loader}`)
        .replace(/fabric_api_version=.*/, `fabric_api_version=${gradleRow.fabricApi}`)
        .replace(/loom_version=.*/, `loom_version=${gradleRow.loom}`);
      writeFileSync(join(workDir, 'gradle.properties'),
        props + `version=${SIDECAR_MOD_VERSION}\n`, 'utf8');
      console.error(`编译通用侧车（${workDir}）...`);
      const t0 = Date.now();
      const res = await runGradle(gradle, workDir);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (res.ok) {
        built = true;
        const jars = listJars(join(workDir, 'build', 'libs'));
        console.error('  OK ' + secs + 's' + (jars.length > 0 ? ' -> ' + jars.join(', ') : ''));
      } else {
        console.error('  FAILED ' + secs + 's');
        console.error(res.tail.split('\n').slice(-12).map((l) => '    ' + l).join('\n'));
        process.exitCode = 1;
      }
    }
  } else {
    console.error('（--no-build：跳过编译）');
  }

  console.error('\n⚠️  jar 和配置**没有**被安装到任何服务器。要装就手动做三件事：');
  console.error(`   1. ${join(outRoot, '.build', 'build', 'libs')} 里的 jar → 服务器 mods/`);
  console.error(`   2. ${configPath} → 服务器 config/modsmith-sidecar/`);
  console.error('   3. 重启服务器，/<command> list 能列出配方就是通了（先在临时服验）');

  // ---- 3) 命令写回：只有编译通过才算数 ----
  //
  // 清单里的 command 会被机器人直接拿去 `/xxx cook ...`。指向一个没编译成功、更没装上的
  // 命令，表现是"发出去了但没人应答"，几秒后才超时 —— 比直接报错难查得多。
  const pending = config.map((st) => ({ station: targets.find((t) => t.id === st.id), command: `/${st.command} cook {recipe}`, recipeType: st.recipeType }));
  const explicitWrite = args['write-command'] === true;
  if (!built) {
    console.error('\n命令**没有**写回清单：通用模组没有编译成功（或跳过了编译）。');
    console.error('  清单保持原样，机器人不会去调不存在的命令。');
    if (explicitWrite && pending.length > 0) {
      for (const x of pending) { x.station.command = x.command; x.station.recipeType = x.recipeType; }
      const { writeManifest } = await import('./manifest-io.mjs');
      writeManifest(manifestPath, manifest);
      console.error('  ! --write-command：照生成结果写了，**没有经过编译验证**。');
    }
  } else {
    for (const x of pending) {
      x.station.command = x.command;
      x.station.recipeType = x.recipeType;
    }
    const { writeManifest } = await import('./manifest-io.mjs');
    writeManifest(manifestPath, manifest);
    console.error(`\n已把 ${pending.length} 条命令写回 ${manifestPath}`);
    for (const x of pending) console.error(`  ${x.station.id} → ${x.command}`);
  }

  console.log(outRoot);
}
