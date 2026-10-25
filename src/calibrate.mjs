/**
 * `modsmith calibrate` —— 现场量出每个方块状态与物品的数字 id。
 *
 * 为什么必须量：1.21 的方块/物品是**静态注册表**，服务端从不下发（`registry_data` 只带
 * biome、damage_type 这类动态表）。模组把这些表往后追加，追加到哪个号取决于加载顺序，
 * 写死一份就会随 mod 组合失效。
 *
 * 量法是最笨也最可靠的那一种：RCON 摆一个方块 → 客户端读回 stateId；/give 一件物品 →
 * 客户端读回它的数字 id。
 *
 * 两个已知难点，各有对策：
 *   a) `/setblock` 改不动某些属性（煎锅的 support、锅的 support），所有状态读回同一个
 *      stateId。对策：`--place` 模式用真实放置（give → equip → sneak → placeBlock）。
 *   b) 服务端方块更新常常晚一拍，单次读可能拿到上一格残留。对策：连读两次一致才认。
 */
import mineflayer from 'mineflayer';
import { writeFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { readManifest } from './manifest-io.mjs';
import { writeIds } from './manifest-io.mjs';
import { computeSuspects, dedupeStateIds, dedupReport, sampleOf } from './calibrate-core.mjs';
import { checkServerMods, fingerprintDir } from './server-fingerprint.mjs';
import { MEASURE_DROPS, installMineflayerFixes, installModRegistry, setModsDir } from './cortico-bridge.mjs';
import { makeRcon } from './rcon.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAIL_RE = /failed|unknown|error|invalid|not loaded|no such/i;

/** 等一个读数为真。 */
async function waitFor(read, ok, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = read();
    if (v && ok(v)) return v;
    await sleep(120);
  }
  return null;
}

export default async function cmdCalibrate(args, io) {
  const manifestPath = args._[1];
  if (!manifestPath) io.fatal('calibrate 要给一个 manifest 路径');
  const manifest = readManifest(manifestPath);
  if (!manifest) io.fatal(`读不了 manifest：${manifestPath}`);

  const host = String(args.host ?? '127.0.0.1');
  const port = Number(args.port ?? 25565);
  const rconPort = Number(args['rcon-port'] ?? port + 10);
  const rconPassword = String(args['rcon-password'] ?? '');
  const mcVersion = String(args['mc-version'] ?? '1.21.1');
  const username = String(args.username ?? 'Calibrator');
  let bx = Number(args.x ?? 400);
  const by = Number(args.y ?? 200);
  let bz = Number(args.z ?? 400);
  const outPath = String(args.out ?? args.ids ?? manifestPath.replace(/\.json$/, '-ids.json'));
  if (typeof args['mods-dir'] === 'string') setModsDir(args['mods-dir']);

  // ---- ids 过期防呆（连接前，还没动服务器状态）----
  //
  // 1.21 的 id 取决于加载顺序：换了服务器、换了 jar，整套 id 静默位移——自检防的是
  // 量错，防不了拿旧 ids 去量新服务器。两道闸：
  //   a) 指纹：--server-mods 给服务器 mods 目录，与 ids 里记录的比，对不上就拒绝
  //   b) 预检：--resume/--items-only 复用旧方块数据时，抽 3 个真摆一遍（spawn 之后）
  const serverModsDir = typeof args['server-mods'] === 'string' ? args['server-mods'] : undefined;
  const prev = readManifest(outPath);
  if (prev) {
    const verdict = checkServerMods(prev.serverMods, serverModsDir);
    for (const line of verdict.lines) process.stderr.write(`  ${line}\n`);
    if (verdict.fatal) io.fatal('ids 与这台服务器对不上（见上），拒绝续用');
  }
  let serverMods;
  if (serverModsDir) {
    try {
      serverMods = fingerprintDir(serverModsDir);
    } catch (err) {
      io.fatal(`--server-mods ${serverModsDir} 读不了：${err.message ?? err}`);
    }
  } else {
    process.stderr.write('  ! 没给 --server-mods：ids 不带服务器指纹，换服务器/换 jar 后发现不了\n');
  }

  const cmd = await makeRcon(host, rconPort, rconPassword);
  let bot = null;

  // 清理必须无条件执行：中途抛错/Ctrl-C 都要把 forceload 和测试平台收掉，
  // 否则下次进来先撞一堆残留的常加载区块
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await cmd(`setblock ${bx} ${by} ${bz} minecraft:air`); } catch { /* */ }
    try { await cmd(`forceload remove ${bx - 16} ${bz - 16} ${bx + 16} ${bz + 16}`); } catch { /* */ }
    try { bot?.quit(); } catch { /* */ }
  };

  try {
  await cmd(`forceload add ${bx - 16} ${bz - 16} ${bx + 16} ${bz + 16}`);
  // 量测位置下面必须有支撑：否则方块放下就掉，"连读两次一致"会一直读到 0。
  // 每次开跑都重铺一次（上一轮的清理会把这里清成空气）。
  await cmd(`fill ${bx - 1} ${by - 1} ${bz - 1} ${bx + 1} ${by - 1} ${bz + 1} minecraft:stone`);
  await cmd(`fill ${bx - 1} ${by} ${bz - 1} ${bx + 1} ${by + 3} ${bz + 1} minecraft:air`);

  let at = new Vec3(bx, by, bz);

  let blocks = {};
  const items = {};
  const failed = [];

  // 作物类方块必须长在耕地上：测量阶段也得垫，不然 setblock 放下去就掉，
  // 读回来的是上一格的残留 id（实测番茄就是这么被记成绳子的）。
  const cropNames = new Set([
    ...Object.keys(manifest.crops ?? {}).map((c) => (c.includes(':') ? c : `${manifest.namespace ?? ''}:${c}`)),
    ...Object.values(manifest.crops ?? {}).flatMap((c) => (c.aliases ?? [])
      .map((a) => (a.includes(':') ? a : `${manifest.namespace ?? ''}:${a}`))),
  ]);
  const propsKey = (props) => Object.entries(props ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join(',');

  const entries = Object.entries(manifest.blocks ?? {});
  const blocksOnly = args['blocks-only'] === true;
  const itemsOnly = args['items-only'] === true;
  if (prev?.blocks && (itemsOnly || args.resume === true)) {
    Object.assign(blocks, prev.blocks);
    console.error(`  复用上一份 ${Object.keys(prev.blocks).length} 个方块的实测结果（${itemsOnly ? '--items-only' : '--resume'}）`);
  }
  if (prev?.items && args.resume === true) {
    Object.assign(items, prev.items);
    console.error(`  复用上一份 ${Object.keys(prev.items).length} 个物品的实测结果（--resume）`);
  }

  /** 已量全的方块：状态数够了就跳过（--resume 才有意义） */
  const completeBlocks = new Set(
    args.resume === true
      ? Object.entries(blocks)
        .filter(([name, list]) => list.length >= ((manifest.blocks ?? {})[name]?.states?.length ?? 1))
        .map(([name]) => name)
      : [],
  );
  if (completeBlocks.size > 0) {
    console.error(`  ${completeBlocks.size} 个方块已经量全，跳过`);
  }

  // ---- 预检：复用的方块数据是否还认得这台服务器 ----
  //
  // --resume/--items-only 会直接复用上一份方块实测。ids 静默过期（换服务器、换 jar）
  // 时，这批 id 注进注册表就是一套错位映射——把自检防住的错名从"复用"这侧放进来。
  // 用一只**一次性 bot**（先于主 bot）注入旧 ids、抽 3 个真摆一遍：名字对不上就中止。
  // 不注主 bot 是刻意的：注入方块没有物理形状（prismarine-block 的 shapes 只在
  // inject_allowed 时重建），物理一碰就炸——自检能关物理跑完，主 bot 还要跑量测。
  if ((itemsOnly || args.resume === true) && prev?.blocks && Object.keys(prev.blocks).length > 0) {
    process.stderr.write('  预检：复用的方块实测先抽 3 个真摆一遍，对得上才继续\n');
    // physicsEnabled 必须作为 createBot 选项传入：注入完成后才设的属性会被插件
    // 注入时的 `physicsEnabled ?? true` 覆盖（踩过），而注入方块没有物理形状，
    // 物理 tick 一碰到就炸 prismarine-physics 的 block.shapes
    const checkBot = mineflayer.createBot({ host, port, username: `${username}Check`, version: mcVersion, auth: 'offline', physicsEnabled: false });
    installMineflayerFixes(checkBot, { extraDrop: MEASURE_DROPS });
    try {
      await new Promise((res, rej) => { checkBot.once('spawn', res); checkBot.once('error', rej); });
      // bot 只收自己视距内的区块；出生点看不见测试区，blockAt 全是空——先 tp 过去
      await cmd(`tp ${username}Check ${bx + 0.5} ${by} ${bz + 0.5}`);
      await sleep(1500);
      installModRegistry(checkBot, { manifest, ids: { mod: prev.mod, version: prev.version, blocks: prev.blocks, items: prev.items ?? {} } });
      const mismatches = [];
      for (const name of sampleOf(Object.keys(prev.blocks), 3)) {
        const soil = cropNames.has(name) ? 'minecraft:farmland' : 'minecraft:stone';
        await cmd(`setblock ${bx} ${by - 1} ${bz} ${soil}`);
        await cmd(`setblock ${bx} ${by} ${bz} ${name}`);
        await sleep(260);
        const seen = checkBot.blockAt(at)?.name ?? '';
        if (seen !== name) mismatches.push(`${name} 读回来是 ${seen || '(空)'}`);
      }
      if (mismatches.length > 0) {
        // 抛错而不是 io.fatal：让 finally 里的清理跑掉，别把 forceload 留在服务器上
        throw new Error(`复用的 ids 对不上这台服务器：${mismatches.join('；')}。ids 已过期或来自别的 jar 组合，删掉重跑全量 calibrate`);
      }
      // 最后一个样本留在格里会让主 bot 的物理 tick 踩到（vanilla 注册表没有它的形状）
      await cmd(`setblock ${bx} ${by} ${bz} minecraft:air`);
      await cmd(`setblock ${bx} ${by - 1} ${bz} minecraft:stone`);
    } finally {
      try { checkBot.quit(); } catch { /* */ }
    }
  }

  bot = mineflayer.createBot({ host, port, username, version: mcVersion, auth: 'offline' });
  installMineflayerFixes(bot, { extraDrop: MEASURE_DROPS });
  // tp 必须在 spawn 之后：实体还没上服时 RCON 的 tp 会静默失败，bot 留在世界出生点
  // （TF 实跑淹死在那儿），测量对着两百格外空气空转。
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
  await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
  // 创造模式：量测要几十分钟，生存模式的机器人会淹死/摔死/被 mod 怪打死（TF 实跑：淹死）
  await cmd(`gamemode creative ${username}`);
  await sleep(1200);
  await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
  await sleep(800);
  // 验收：bot 必须真在测试点旁。对不上就大声停——对空气空转两小时比失败更糟。
  const spot = new Vec3(bx + 0.5, by + 0.5, bz + 0.5);
  const dist = bot.entity ? bot.entity.position.distanceTo(spot) : Infinity;
  if (dist > 32) {
    throw new Error(`机器人没到测试点（距它还有 ${Math.round(dist)} 格）——tp 没生效，测量会全空转。先检查服务器是否 allow-rcon 与实体生成`);
  }

  const read = () => {
    const b = bot.blockAt(at);
    return b && typeof b.stateId === 'number' ? b : null;
  };
  // 等第一列真到客户端，否则整轮全是 null
  await waitFor(read, () => true, 10000);

  const writePartial = () => {
    try {
      writeIds(outPath, {
        mod: manifest.mod,
        version: manifest.version,
        measuredAt: new Date().toISOString(),
        blocks,
        items,
        failed,
        partial: true,
      });
    } catch { /* 落盘失败不影响继续跑 */ }
  };
  let n = 0;
  const trace = process.env.MODSMITH_TRACE
    ? (...a) => process.stderr.write(`  [trace] ${a.join(' ')}\n`)
    : () => {};
  // 带 BlockEntity 的 mod 方块，setblock 换它时服务端可能抛异常——从此这个格子上的
  // 任何命令都炸（TF 实跑：Antibuilder 一放，格子永久报废，后面 500 个方块全空转）。
  // 检测到就整体搬家：格子换新，floor 重铺，bot 跟过去，当前命令在新格子再试一次。
  let relocations = 0;
  const setblockAt = async (full) => {
    let resp = await cmd(full);
    if (/unexpected error/i.test(String(resp))) {
      relocations += 1;
      bx += 9; bz += 3;
      at = new Vec3(bx, by, bz);
      trace(`cursed cell -> relocate to ${bx},${by},${bz}（第 ${relocations} 次）`);
      await cmd(`setblock ${bx} ${by - 1} ${bz} minecraft:stone`);
      await cmd(`setblock ${bx} ${by} ${bz} minecraft:air`);
      await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
      await sleep(900);
      resp = await cmd(full);
    }
    return resp;
  };
  for (const [name, spec] of (itemsOnly ? [] : entries)) {
    n++;
    if (completeBlocks.has(name)) continue;
    const states = spec.states?.length ? spec.states : [{}];
    const list = [];
    trace(`block ${n} ${name} states=${states.length}`);
    for (const st of states) {
      const arg = Object.keys(st).length > 0 ? `[${propsKey(st)}]` : '';
      let got = null;
      // 只有作物需要换支撑（要耕地）。非作物别动这一格 —— 每状态都重设一次会让
      // 方块触发一次更新，实测把整轮测量搞成了同一个残留 id。
      if (cropNames.has(name)) {
        await setblockAt(`setblock ${bx} ${by - 1} ${bz} minecraft:farmland`);
      }
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        await setblockAt(`setblock ${bx} ${by} ${bz} minecraft:air`);
        await waitFor(read, (b) => b.stateId === 0, 900);
        trace(`  ${n} ${name} attempt=${attempt} air-cleared`);
        const resp = await setblockAt(`setblock ${bx} ${by} ${bz} ${name}${arg}`);
        trace(`  ${n} ${name} set resp=${String(resp).slice(0, 40)}`);
        if (FAIL_RE.test(resp)) {
          if (attempt === 2) failed.push({ block: name, props: st, resp: resp.slice(0, 160) });
          continue;
        }
        const first = await waitFor(read, (b) => b.stateId !== 0, 2500);
        if (!first) continue;
        await sleep(300);
        const second = read();
        if (second && second.stateId === first.stateId && second.stateId !== 0) {
          got = { props: st, stateId: second.stateId };
        }
      }
      if (got) list.push(got);
    }
    if (list.length > 0) blocks[name] = list;
    else failed.push({ block: name, resp: 'no state' });
    if (n % 20 === 0) process.stderr.write(`  方块 ${n}/${entries.length}\n`);
  }
  await cmd(`setblock ${bx} ${by} ${bz} minecraft:air`);

  // ---- 物品 ----
  //
  // 关键（实测出来的）：没注入注册表时，模组物品在客户端眼里名字是 `unknown`，但
  // **`type` 就是它真正的数字 id**。所以不能按名字找，只能按"背包里多出来的那一件"取。
  // 位置也稳：每给一件就落在下一个空槽，槽号递增。
  const itemNames = Object.keys(manifest.items ?? {});
  const usedSlots = () => new Set((bot.inventory?.items?.() ?? []).map((it) => it.slot));

  const debugItems = args['debug-items'] === true;
  let m = 0;
  let targetSlot = -1;   // 下一件会落在哪个槽；-1 = 还没定
  for (const name of (blocksOnly ? [] : itemNames)) {
    m++;
    if (targetSlot < 0 || targetSlot > 35) {
      // 换一轮：清空背包，从头开始
      await cmd(`clear ${username}`);
      const t = Date.now() + 2500;
      while ((bot.inventory?.items?.().length ?? 0) > 0 && Date.now() < t) await sleep(80);
      await sleep(400);
      // 不要预设从 9 开始：服务端给东西落在哪一格由它自己决定。
      // 这里只把"下一件会落哪"交给下面的 before/fresh 兜底去找。
      targetSlot = 0;
      const taken = usedSlots();
      while (taken.has(targetSlot) && targetSlot < 36) targetSlot++;
    }

    // 快照必须在 give **之前**取：给完之后再取，"新出现的槽"永远是空的（踩过）
    const before = new Set((bot.inventory?.items?.() ?? []).map((it) => it.slot));
    const beforeTypes = new Map((bot.inventory?.items?.() ?? []).map((it) => [it.slot, it.type]));

    const resp = await cmd(`give ${username} ${name} 1`);
    if (/unknown item/i.test(resp)) {
      // 区分"物品真的不存在"和"只是没有 item 形式"：后者不是错误
      const isBlock = name in (manifest.blocks ?? {});
      failed.push({
        item: name,
        kind: isBlock ? 'block-only' : 'unknown-item',
        resp: resp.slice(0, 160),
      });
      continue;
    }

    // 等这一件落进背包：只认"give 之后新出现的槽"，不预测服务端往哪格放
    let type = null;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const list = bot.inventory?.items?.() ?? [];
      const fresh = list.filter((it) => !before.has(it.slot) && typeof it.type === 'number' && it.type > 0);
      // 同一槽换了东西也算（堆叠/替换）
      const changed = list.filter((it) => before.has(it.slot) && beforeTypes.get(it.slot) !== it.type);
      const pick = fresh[0] ?? changed[0];
      if (pick) { type = pick.type; break; }
      await sleep(80);
    }
    if (debugItems) {
      const dump = (bot.inventory?.items?.() ?? []).map((x) => `${x.name}#${x.type}@${x.slot}`).join(',');
      console.error(`  [dbg] ${name}: type=${type} before=[${[...before].join(',')}] now=[${dump}]`);
    }
    if (typeof type === 'number' && type > 0) {
      items[name] = type;
      // 下一件会落在下一个空槽
      const taken = usedSlots();
      targetSlot++;
      while (taken.has(targetSlot) && targetSlot < 36) targetSlot++;
    } else {
      const dump = (bot.inventory?.items?.() ?? []).map((x) => `${x.name}#${x.type}@${x.slot}`).join(',');
      failed.push({ item: name, resp: `背包里没出现（give 回：${resp.trim().slice(0, 50)}；背包=${dump || '空'}）` });
    }
    if (m % 40 === 0) process.stderr.write(`  物品 ${m}/${itemNames.length}
`);
  }
  await cmd(`clear ${username}`);

  const ids = {
    mod: manifest.mod,
    version: manifest.version,
    measuredAt: new Date().toISOString(),
    blocks,
    items,
    failed,
    ...(serverMods ? { serverMods } : {}),
  };

  if (args.place) {
    await calibrateByPlacement({ bot, cmd, ids, manifest, username, bx, by, bz });
  }

  // ---- 去重：一个 stateId 只能属于一个方块 ----
  //
  // `/setblock` 改不动属性时，几十个方块会被记成同一个残留 id。清单里留着它们就是
  // 假数据：下游任何按 stateId 反查的地方都会拿到错的那个方块。谁先声明归谁
  // （manifest 的方块顺序），真实放置量到的先认领。
  {
    const deduped = dedupeStateIds(blocks, Object.keys(manifest.blocks ?? {}));
    blocks = deduped.blocks;
    ids.blocks = blocks;
    const report = dedupReport(deduped.dupDropped, deduped.sameBlockDropped);
    for (const line of report.lines) process.stderr.write(`  ${line}\n`);
    failed.push(...report.failed);
  }

  // ---- 自检：量出来的 id 到底对不对 ----
  //
  // 为什么必须验：`/setblock` 对一个"放不住"的方块（告示牌要墙/顶、作物要耕地）会
  // 悄悄失败，客户端读回的是上一格的残留值。实测农夫乐事有 71 个单状态方块全被记成
  // 同一个 stateId —— 注入后它们会变成"同一个方块"，她看见米捆其实是橱柜。
  //
  // 办法：拿刚量到的 ids 直接把注册表注进当前 bot，再逐个放一遍读名字。名字不对的
  // 就把这个方块的 id 全删掉 —— 宁可未知，不能错名。
  if (args['no-selfcheck'] !== true) {
    process.stderr.write('  自检：把量到的 id 注进注册表，逐个核对方块名...\n');
    const tempPack = {
      manifest,
      ids: { mod: manifest.mod, version: manifest.version, blocks, items, failed },
    };
    // 中途注入不会重建 prismarine-block 的 shapes（那一步只在 inject_allowed 时做），
    // 物理引擎下一帧就会炸在 block.shapes 上。验名字用不着物理，先关掉。
    bot.physicsEnabled = false;
    let injected = true;
    try {
      installModRegistry(bot, tempPack);
    } catch (err) {
      injected = false;
      process.stderr.write('  自检跳过（注册表注入失败）：' + err.message + '\n');
    }
    const bad = [];
    const checked = injected ? Object.keys(blocks) : [];
    for (const name of checked) {
      // 每个方块都把 bot 拉回测试格：物理开着放方块会把 bot 挤得漂移，漂出
      // 视距后 blockAt 读的是残留数据 —— 实测从第 81 个方块起全部读到同一个
      // 残影，47 个好方块差点被当成错名删光
      await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
      // 非作物也要有支撑面，否则方块会掉下去 —— 用石头；作物用耕地
      const soil = cropNames.has(name) ? 'minecraft:farmland' : 'minecraft:stone';
      await cmd('setblock ' + bx + ' ' + (by - 1) + ' ' + bz + ' ' + soil);
      const placeResp = await cmd('setblock ' + bx + ' ' + by + ' ' + bz + ' ' + name);
      if (FAIL_RE.test(placeResp)) {
        // 服务端拒绝放置不是 id 错的证据（可能这格摆不住）：不删，记一笔
        failed.push({ block: name, kind: 'place-failed', resp: placeResp.slice(0, 120) });
        continue;
      }
      await sleep(260);
      const b = bot.blockAt(at);
      const seen = b?.name ?? '';
      // 光比名字不够：prismarine 是按 stateId 活查注册表的，记录里只要有一条真 id
      // 落在表上，名字就会对 —— 重复或错的那些条目照样混过去。所以还要核 stateId。
      const recorded = new Set((blocks[name] ?? []).map((e) => e.stateId));
      const seenId = typeof b?.stateId === 'number' ? b.stateId : 0;
      if (seen === name && !recorded.has(seenId)) {
        bad.push({ block: name, seen: 'stateId ' + seenId + ' 不在该方块的实测记录里', kept: false });
        delete blocks[name];
        delete ids.blocks[name];
        continue;
      }
      if (seen !== name) {
        // 作物类自检失败多半是环境原因（要真种、要长在耕地上），不是 id 错。
        // 这类只标注不删 —— 删了她就完全不认识这个方块了，比"没验过"更糟。
        const environmental = cropNames.has(name);
        bad.push({ block: name, seen, kept: environmental });
        if (!environmental) {
          delete blocks[name];
          delete ids.blocks[name];
        }
      }
    }
    await cmd('setblock ' + bx + ' ' + by + ' ' + bz + ' minecraft:air');
    await cmd('setblock ' + bx + ' ' + (by - 1) + ' ' + bz + ' minecraft:stone');
    // 物理保持关到进程结束：注册表还注入着，注入方块没有物理形状（prismarine-block
    // 的 shapes 只在 inject_allowed 时重建），恢复物理后任何一个 tick 都可能踩上去炸。
    // 自检之后 bot 不再需要动，关着没有副作用。
    bot.physicsEnabled = false;
    if (!injected) {
      process.stderr.write('  自检没做：注册表没注上\n');
    } else if (bad.length > 0) {
      const deleted = bad.filter((b) => !b.kept).length;
      if (deleted > Math.max(5, Math.floor(checked.length * 0.1))) {
        // 大面积"错名"几乎总是环境坏了（客户端区块失新、cell 残留），不是数据坏了。
        // 抛错中止：宁可不写盘，也别把好数据削掉 —— 实测一晚差点毁掉生产 ids。
        throw new Error(`自检剔除 ${deleted}/${checked.length} 个方块，远超合理范围：测量环境已坏（区块失新或服务器异常）。中止本次运行，ids 文件保持原样；稍后重跑`);
      }
      process.stderr.write('  自检剔除 ' + bad.length + ' 个量错的方块（名字对不上）：\n');
      for (const b of bad.slice(0, 8)) {
        process.stderr.write('    ' + b.block + ' 读回来是 ' + (b.seen || '(空)') + '\n');
      }
      if (bad.length > 8) process.stderr.write('    ...还有 ' + (bad.length - 8) + ' 个\n');
      for (const b of bad) {
        failed.push({
          block: b.block,
          kind: b.kept ? 'environmental' : 'unverified',
          resp: '读回来是 ' + (b.seen || '(空)'),
        });
      }
    } else {
      process.stderr.write('  自检通过：' + Object.keys(blocks).length + ' 个方块全部对得上\n');
    }
  }

  // 服务端真配方包：mineflayer 没有配方插件、模组改注册表后整包解析不了，被容错层
  // 丢弃，但原始字节是真的 —— 落盘供 `modsmith recipes` 离线解析，省一次上服。
  const captured = bot._modsmithDeclareRecipes;
  if (captured) {
    const rawPath = outPath.replace(/-ids\.json$/, '-recipes.raw.bin');
    writeFileSync(rawPath, captured);
    process.stderr.write(`  服务端配方包 ${captured.length} 字节 → ${rawPath}（modsmith recipes <manifest> 解析）\n`);
  }

  writeIds(outPath, ids);

  const okBlocks = Object.keys(blocks).length;
  const blockOnly = failed.filter((f) => f.item && f.kind === 'block-only').length;
  const unknownItem = failed.filter((f) => f.item && f.kind === 'unknown-item').length;
  console.error(`✓ ${manifest.mod}：方块 ${okBlocks}/${entries.length}，`
    + `物品 可用 ${Object.keys(items).length} / 声明 ${itemNames.length}`);
  if (blockOnly > 0) console.error(`  ${blockOnly} 件只有方块形式（没有 item model），拿不到是正常的`);
  if (unknownItem > 0) console.error(`  ! ${unknownItem} 件判成"服务端不认这个物品"，值得看一眼`);
  console.error(`  写入 ${outPath}`);
  if (failed.length > 0) {
    console.error(`  失败 ${failed.length} 项：${failed.slice(0, 6).map((f) => f.item ?? f.block).join(', ')}${failed.length > 6 ? ' …' : ''}`);
  }
  } finally {
    await cleanup();
  }
  console.log(outPath);
}

/**
 * 真实放置补测：给玩家 → 拿在手 → 潜行 → 放置，读回真实默认态的 stateId。
 * 嫌疑名单由 computeSuspects 挑（/setblock 设不动属性的那批）。
 */
async function calibrateByPlacement({ bot, cmd, ids, manifest, username, bx, by, bz }) {
  // 平台：测完清掉
  await cmd(`fill ${bx - 4} ${by - 1} ${bz - 4} ${bx + 4} ${by - 1} ${bz + 4} minecraft:stone`);
  await cmd(`fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 3} ${bz + 4} minecraft:air`);
  await sleep(500);

  // 判据在 computeSuspects：量出来的不同 stateId 比声明的状态数少。
  const suspects = computeSuspects(ids.blocks, manifest.blocks);
  if (suspects.length === 0) {
    console.error('  没有需要真实放置补测的方块');
    return;
  }
  console.error(`  真实放置补测 ${suspects.length} 个方块`);

  const spot = new Vec3(bx + 1, by, bz);
  const ref = new Vec3(bx + 1, by - 1, bz);
  let done = 0;
  let confirmed = 0;   // 放下去了，id 与已量到的一致
  let added = 0;       // 放下去了，量到新 id
  let failedPlace = 0; // 没放下去
  let skipped = 0;     // give 不出或拿不到（作物方块没有 item 形式），放置够不着
  for (const { name } of suspects) {
    await cmd(`clear ${username}`);
    const resp = await cmd(`give ${username} ${name} 1`);
    if (FAIL_RE.test(resp)) {
      // 跳过也必须计数并入账：结果行的四个数要能对上 suspects 总数，
      // 否则"补测 7 个、结果只有 6"就是对不上的账（实测 tomatoes 没有物品形式）
      skipped++;
      done++;
      process.stderr.write(`    give 不出物品，跳过：${name}（${resp.trim().slice(0, 80)}）\n`);
      continue;
    }
    // **按数字 id 找，不按名字。** 这个 bot 没注入注册表，模组物品在客户端眼里
    // 名字一律是 `unknown`，`i.name === name` 永远不成立 —— 之前就是这里一直
    // `continue`，放置补测跑了个寂寞（踩过）。
    const itemType = ids.items?.[name];
    const pick = () => {
      const list = bot.inventory.items();
      const byId = typeof itemType === 'number' ? list.find((i) => i.type === itemType) : null;
      return byId ?? list.find((i) => i.name === name || i.name === name.split(':')[1]) ?? null;
    };
    // waitFor 是 (read, ok, ms) 三参数：少传一个 `ok` 时 ms 会是 undefined，
    // 循环一次都不跑、立刻返回 null —— 之前"拿了物品却没等到"就是这么来的。
    const item = await waitFor(pick, (v) => v !== null, 2500);
    if (!item) {
      process.stderr.write(`    拿不到物品：${name}（ids.items 里${typeof itemType === 'number' ? `是 ${itemType}` : '没有' }，背包 ${bot.inventory.items().length} 件）
`);
      skipped++;
      done++;
      continue;
    }

    await cmd(`setblock ${spot.x} ${spot.y} ${spot.z} minecraft:air`);
    await sleep(300);
    try {
      await bot.equip(item, 'hand');
      bot.setControlState('sneak', true);
      await sleep(200);
      const below = bot.blockAt(ref);
      if (below) await bot.placeBlock(below, new Vec3(0, 1, 0));
      await sleep(400);
      bot.setControlState('sneak', false);
    } catch {
      try { bot.setControlState('sneak', false); } catch { /* */ }
    }
    await sleep(400);
    const placed = bot.blockAt(spot);
    // **不能比对方块名**：这个 bot 还没注入注册表，模组方块的名字一律是 `unknown`，
    // 名字相等永远不成立（踩过：放置补测跑完了，一条都没记下）。
    // 改成看两件更强的证据：手快里那一件没了（确实放下去了）+ 那一格有了 stateId。
    // 别用"手里那件还在不在"当判据：放置后客户端背包是延迟同步的，经常还看得见，
    // 结果一条都记不下（踩过两次）。只看那一格：清成 air 之后又有了 stateId，
    // 就是放下去了。
    if (placed && placed.stateId > 0) {
      const list = ids.blocks[name] ?? [];
      // 真实放置量到的是默认态；把 props 空着，让 registry 用区间兜底
      if (!list.some((s) => s.stateId === placed.stateId)) {
        list.unshift({ props: {}, stateId: placed.stateId, note: '真实放置校准' });
        ids.blocks[name] = list;
        added++;
      } else {
        confirmed++;   // setblock 量到的就是真身，这里只做确认
      }
    } else {
      failedPlace++;
      if (done < 3) {
        process.stderr.write(`    放置没成：${name}（那一格 stateId ${placed?.stateId ?? 0}）
`);
      }
    }
    await cmd(`setblock ${spot.x} ${spot.y} ${spot.z} minecraft:air`);
    done++;
    if (done % 5 === 0) process.stderr.write(`  放置 ${done}/${suspects.length}\n`);
  }
  await cmd(`fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 3} ${bz + 4} minecraft:air`);
  // 让结果看得见：confirmed 不写文件（setblock 已经量到了那个 id），added 才会出现在 ids 里
  console.error(`  放置补测结果：确认 ${confirmed} / 新增 ${added} / 没放成 ${failedPlace} / 没测成 ${skipped}（嫌疑共 ${suspects.length}）`);
}
