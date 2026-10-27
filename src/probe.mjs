/**
 * `modsmith probe` —— 实测哪些站点/容器真的能用。
 *
 * 静态分析只能给出**候选**：名字像容器的 `*_crate` 实测打不开，而名字普通的橱柜能开。
 * 所以凡是"这个方块右键会发生什么"的问题，都必须上真服务器问一次。
 *
 * 做的事（都在一块临时搭的平台上，测完清掉）：
 *   1. 容器候选逐个右键：记下开没开、开的是哪种菜单、多少槽
 *   2. 站点候选逐个右键：GUI 类站点记 inventoryType；不开窗的标出来（那类要走侧车）
 *
 * 依赖：服务器已装好该 mod、开了 RCON、bot 能离线登录且有 OP（要 forceload/setblock/tp）。
 */
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { readManifest } from './manifest-io.mjs';
import { installModRegistry, MEASURE_DROPS, installMineflayerFixes, loadModPack, setModsDir } from './cortico-bridge.mjs';
import { applyProbe, stationMatches } from './manifest-probe.mjs';
import { checkServerMods } from './server-fingerprint.mjs';
import { makeRcon } from './rcon.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 右键一个方块，看它开不开窗。
 * @returns {{ opened: boolean, type?: string, slots?: number, error?: string }}
 */
async function tryOpen(bot, block, ms) {
  let win = null;
  // 自定义窗口类型会被 installMineflayerFixes 的 emit 守卫记在这里：prismarine-windows
  // 不认识 → createWindow 返回 null → 窗口事件不会来。这种"开了但界面未知"必须算开窗。
  bot._modsmithUnknownWindow = null;
  const onWin = (w) => { win = w; };
  bot.once('windowOpen', onWin);
  const open = block.name.includes(':') ? bot.openBlock(block) : bot.openContainer(block);
  let timedOut = false;
  try {
    await Promise.race([
      open.catch((e) => { throw e; }),
      sleep(ms).then(() => { timedOut = true; }),
    ]);
  } catch (err) {
    bot.removeListener('windowOpen', onWin);
    await sleep(150);
    if (bot._modsmithUnknownWindow) {
      return { opened: true, type: bot._modsmithUnknownWindow, slots: null, error: '自定义窗口（界面未知）' };
    }
    const got = win ?? bot.currentWindow ?? null;
    if (got) {
      const info = { opened: true, type: got.type, slots: got.slots?.length };
      try { got.close(); } catch { /* */ }
      return info;
    }
    return { opened: false, error: String(err.message ?? err).slice(0, 120) };
  }
  bot.removeListener('windowOpen', onWin);
  if (bot._modsmithUnknownWindow) {
    return { opened: true, type: bot._modsmithUnknownWindow, slots: null, error: '自定义窗口（界面未知）' };
  }
  const got = win ?? bot.currentWindow ?? null;
  if (got) {
    const info = { opened: true, type: got.type, slots: got.slots?.length };
    try { got.close(); } catch { /* */ }
    await sleep(300);
    return info;
  }
  return { opened: false, error: timedOut ? '超时没开出界面' : '没有窗口' };
}

/**
 * 开一次探测会话：连服务器、搭平台、给一个 `probeOne(blockName)`，用完 `close()`。
 *
 * 抽出来是因为 `learn` 也要验站点。共用一个会话比每次重连省事，也保证两边
 * 用的是同一套"怎么算开窗"的口径。
 */
export async function openProbeSession(opts) {
  const host = String(opts.host ?? '127.0.0.1');
  const port = Number(opts.port ?? 25565);
  const rconPort = Number(opts.rconPort ?? port + 10);
  const rconPassword = String(opts.rconPassword ?? '');
  const mcVersion = String(opts.mcVersion ?? '1.21.1');
  const username = String(opts.username ?? 'ModProbe');
  const bx = Number(opts.x ?? 400);
  const by = Number(opts.y ?? 200);
  const bz = Number(opts.z ?? 400);
  const openMs = Number(opts.timeout ?? 3000);

  if (opts.modsDir) setModsDir(opts.modsDir);
  const pack = opts.pack ? loadModPack(opts.pack) : null;

  const cmd = await makeRcon(host, rconPort, rconPassword);
  const bot = mineflayer.createBot({ host, port, username, version: mcVersion, auth: 'offline' });
  if (pack) installModRegistry(bot, pack);
  bot.loadPlugin((b) => installMineflayerFixes(b, { extraDrop: MEASURE_DROPS }));

  await cmd(`forceload add ${bx - 8} ${bz - 8} ${bx + 8} ${bz + 8}`);
  await cmd(`fill ${bx - 6} ${by - 1} ${bz - 6} ${bx + 6} ${by - 1} ${bz + 6} minecraft:stone`);
  await cmd(`fill ${bx - 6} ${by} ${bz - 6} ${bx + 6} ${by + 4} ${bz + 6} minecraft:air`);
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
  await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
  await sleep(2500);

  const target = { x: bx + 1, y: by, z: bz };

  /**
   * 等目标格子读回指定方块名（最多 timeoutMs）。
   * 固定 sleep 450ms 在模组方块上不够：真实事故是一半容器读回空名（客户端区块更新还没到），
   * 被当成"没测成"。按名等待把读滞后和"真的放不下"区分开。
   */
  const waitForBlockName = async (pos, name, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (last?.name === name) return { block: last };
      if (Date.now() > deadline) return { block: last };
      await sleep(150);
    }
  };

  /** 放一个方块并右键，看它开不开窗。 */
  const probeOne = async (name) => {
    await cmd(`setblock ${target.x} ${target.y} ${target.z} ${name}`);
    const { block } = await waitForBlockName(target, name);
    let result;
    if (!block) result = { placed: false, opened: false, error: 'blockAt 读不到（区块没到？）' };
    else if (block.name !== name) result = { placed: false, opened: false, error: `放下去是 ${block.name || '(空名)'}` };
    else result = { placed: true, ...(await tryOpen(bot, block, openMs)) };
    await cmd(`setblock ${target.x} ${target.y} ${target.z} minecraft:air`);
    await sleep(350);
    return result;
  };

  /** 验一组站点声明。 */
  const probeStations = async (stations) => {
    const out = [];
    for (const st of stations ?? []) {
      if (!st?.block) continue;
      const r = await probeOne(st.block);
      const { matches, why } = stationMatches(st.kind, {
        opensWindow: r.opened === true,
        windowType: r.type ?? null,
        placed: r.placed !== false,
      });
      out.push({
        id: st.id, block: st.block, kind: st.kind,
        placed: r.placed !== false,
        opensWindow: r.opened === true,
        windowType: r.type ?? null,
        slots: r.slots ?? null,
        matches,
        why,
        observed: r.opened === true ? `开出菜单（${r.type ?? '未知类型'}）` : (r.placed === false ? '没放下去' : '不开窗'),
        error: r.opened ? null : r.error,
      });
    }
    return out;
  };

  const close = async () => {
    try { await cmd(`fill ${bx - 6} ${by} ${bz - 6} ${bx + 6} ${by + 4} ${bz + 6} minecraft:air`); } catch { /* */ }
    try { await cmd(`forceload remove ${bx - 8} ${bz - 8} ${bx + 8} ${bz + 8}`); } catch { /* */ }
    await sleep(200);
    try { bot.quit(); } catch { /* */ }
  };

  return { probeOne, probeStations, close, bot, cmd };
}

/**
 * 给 `learn` 用的探测器：每次调用独立开一次会话，跑完收尾。
 *
 * 不缓存连接的原因：`learn` 会重试好几轮，用一条长连接就要处理"上一轮是不是把 bot
 * 留在半开状态"；每次重连虽然慢十几秒，但每轮都是干净状态，出错也好定位。
 */
export function makeStationProbe(opts) {
  return async (stations) => {
    if (!Array.isArray(stations) || stations.length === 0) return [];
    let session = null;
    try {
      session = await openProbeSession(opts);
      return await session.probeStations(stations);
    } catch (err) {
      console.error(`  实测验证连不上服务器（这一轮跳过验证）：${err.message ?? err}`);
      return [];
    } finally {
      if (session) {
        try { await session.close(); } catch { /* */ }
      }
    }
  };
}

/**
 * @param {Record<string, any>} args CLI 参数
 * @param {{fatal: (m: string) => never}} io
 */
export default async function cmdProbe(args, io) {
  const manifestPath = args._[1];
  if (!manifestPath) io.fatal('probe 要给一个 manifest 路径');
  const manifest = readManifest(manifestPath);
  if (!manifest) io.fatal(`读不了 manifest：${manifestPath}`);

  const packName = String(args.pack ?? '');
  if (!packName) io.fatal('probe 要给 --pack <包名>（mods/ 下的文件名，不带 .json）');
  if (typeof args['mods-dir'] === 'string') setModsDir(args['mods-dir']);
  const pack = loadModPack(packName);
  if (!pack) io.fatal(`读不到包 ${packName}（需要 ${packName}.json 与 ${packName}-ids.json）`);

  const verdict = checkServerMods(
    pack.ids?.serverMods,
    typeof args['server-mods'] === 'string' ? args['server-mods'] : undefined,
  );
  for (const line of verdict.lines) console.error(`  ${line}`);
  if (verdict.fatal) io.fatal('ids 与这台服务器对不上（见上）——过期的数据测出来的站点结论也是错的');

  const session = await openProbeSession({
    host: args.host, port: args.port, rconPort: args['rcon-port'],
    rconPassword: args['rcon-password'], mcVersion: args['mc-version'],
    username: args.username ?? 'ModProbe', pack: packName,
    modsDir: typeof args['mods-dir'] === 'string' ? args['mods-dir'] : undefined,
    x: args.x, y: args.y, z: args.z, timeout: args.timeout,
  });

  // 1) 容器候选：实测说了算
  const containerOk = [];
  const containerNo = [];     // 测过，确实打不开
  const containerUntested = []; // 没测成（放不下去），保持原判
  const candidates = Array.isArray(manifest.containers) ? manifest.containers : [];
  for (const name of candidates) {
    const r = await session.probeOne(name);
    if (r.opened) {
      containerOk.push({ name, type: r.type, slots: r.slots });
    } else if (r.placed === false) {
      // 没放下去 = 没测成，不是"不能用"。注册表 id 不对时会走到这里。
      // 这种必须保留在容器表里，否则一次没测成就把好好的橱柜删了。
      containerUntested.push({ name, error: r.error });
    } else {
      containerNo.push({ name, error: r.error });
    }
  }

  // 2) 站点：右键开不开窗 —— "声明 vs 实测"唯一能自动化的硬约束
  const stationResult = await session.probeStations(manifest.stations ?? []);

  // 3) --scan-blocks：把候选方块逐个右键一遍，记下"开不开窗、开的什么窗"。
  //    这是 learn --infer 的证据来源：遇到名字与功能不对应的 mod（叫 *_crate 却是
  //    机器、叫 *_machine 却是纯装饰），只有实测能分开。
  let blockScan = null;
  if (args['scan-blocks'] === true) {
    const { scanCandidates } = await import('./stations.mjs');
    const { candidates, skipped } = scanCandidates(manifest, { limit: Number(args['scan-limit'] ?? 400) });
    console.error(`  方块扫描：${candidates.length} 个候选（跳过 容器 ${skipped.container} / 多状态 ${skipped.multiState} / 装饰 ${skipped.decorative}）`);
    const evidence = {};
    let i = 0;
    for (const name of candidates) {
      i += 1;
      const r = await session.probeOne(name);
      if (r.placed === false) { evidence[name] = { placed: false, error: r.error }; continue; }
      evidence[name] = {
        placed: true,
        opensWindow: r.opened === true,
        ...(r.type ? { windowType: r.type } : {}),
        ...(typeof r.slots === 'number' ? { slots: r.slots } : {}),
      };
      if (i % 20 === 0) console.error(`    ${i}/${candidates.length}`);
    }
    const opened = Object.values(evidence).filter((e) => e.opensWindow).length;
    blockScan = { candidates: candidates.length, opened, skipped, evidence };
    console.error(`  方块扫描完成：${opened}/${candidates.length} 个会开窗`);
  }

  await session.close();

  const out = {
    mod: manifest.mod,
    probedAt: new Date().toISOString(),
    containers: {
      // 只留实测能开的——不能开的绝不能进容器表（机器人去取的时候会一直超时）
      ok: containerOk.map((c) => c.name),
      detail: containerOk,
      failed: containerNo,
      untested: containerUntested,
    },
    stations: stationResult,
    ...(blockScan ? { blockScan } : {}),
  };

  if (typeof args.out === 'string') {
    const { writeIds } = await import('./manifest-io.mjs');
    writeIds(args.out, out);
    console.error(`  写入 ${args.out}`);
  }

  // 回写清单：这一步是"自动化"的最后一米，不写回去，probe 就只是个报告生成器
  if (args['write-manifest'] === true) {
    const { writeManifest } = await import('./manifest-io.mjs');
    const { notes } = applyProbe(manifest, out);
    writeManifest(manifestPath, manifest);
    console.error(`  已回写 ${manifestPath}`);
    for (const n of notes) console.error(`    ${n}`);
  }

  console.error(`\n容器：能开 ${containerOk.length} / 候选 ${candidates.length}`);
  for (const c of containerOk) console.error(`  ✓ ${c.name}  ${c.type} ${c.slots} 槽`);
  for (const c of containerNo) console.error(`  ✗ ${c.name}  ${c.error}`);
  for (const c of containerUntested) console.error(`  ? ${c.name}  没测成（保持原判）：${c.error}`);
  if (stationResult.length > 0) {
    console.error('\n站点：');
    for (const s of stationResult) {
      const mark = s.matches ? '✓' : '✗';
      console.error(`  ${mark} ${s.block}  声明 ${s.kind}，${s.opensWindow ? `实测开窗(${s.windowType ?? '?'})` : '实测不开窗'}`);
      if (!s.matches) console.error(`      ${s.why}`);
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
