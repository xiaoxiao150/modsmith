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
import net from 'node:net';
import { Vec3 } from 'vec3';
import { readManifest } from './manifest-io.mjs';
import { writeIds } from './manifest-io.mjs';
import { computeSuspects, dedupeStateIds, dedupReport } from './calibrate-core.mjs';
import { installMineflayerFixes, installModRegistry, setModsDir } from './cortico-bridge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRcon(host, port, password) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(port, host);
    let buf = Buffer.alloc(0);
    let id = 0;
    const waiters = [];
    const send = (type, body) => {
      id += 1;
      const h = Buffer.alloc(8);
      h.writeInt32LE(id, 0);
      h.writeInt32LE(type, 4);
      const payload = Buffer.concat([h, Buffer.from(body, 'utf8'), Buffer.alloc(2)]);
      const len = Buffer.alloc(4);
      len.writeInt32LE(payload.length, 0);
      s.write(Buffer.concat([len, payload]));
    };
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        waiters.shift()?.(body.subarray(8, body.length - 2).toString('utf8'));
      }
    });
    s.on('error', reject);
    s.on('close', () => reject(new Error('RCON 连接断了')));
    s.on('connect', () => {
      send(3, password);
      waiters.push(() => resolve((cmd) => new Promise((res) => {
        send(2, cmd);
        waiters.push(res);
      })));
    });
  });
}

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
  const bx = Number(args.x ?? 400);
  const by = Number(args.y ?? 200);
  const bz = Number(args.z ?? 400);
  const outPath = String(args.out ?? args.ids ?? manifestPath.replace(/\.json$/, '-ids.json'));
  if (typeof args['mods-dir'] === 'string') setModsDir(args['mods-dir']);

  const cmd = await makeRcon(host, rconPort, rconPassword);
  const bot = mineflayer.createBot({ host, port, username, version: mcVersion, auth: 'offline' });
  installMineflayerFixes(bot);

  // 清理必须无条件执行：中途抛错/Ctrl-C 都要把 forceload 和测试平台收掉，
  // 否则下次进来先撞一堆残留的常加载区块
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await cmd(`setblock ${bx} ${by} ${bz} minecraft:air`); } catch { /* */ }
    try { await cmd(`forceload remove ${bx - 16} ${bz - 16} ${bx + 16} ${bz + 16}`); } catch { /* */ }
    try { bot.quit(); } catch { /* */ }
  };

  try {
  await cmd(`forceload add ${bx - 16} ${bz - 16} ${bx + 16} ${bz + 16}`);
  // 量测位置下面必须有支撑：否则方块放下就掉，"连读两次一致"会一直读到 0。
  // 每次开跑都重铺一次（上一轮的清理会把这里清成空气）。
  await cmd(`fill ${bx - 1} ${by - 1} ${bz - 1} ${bx + 1} ${by - 1} ${bz + 1} minecraft:stone`);
  await cmd(`fill ${bx - 1} ${by} ${bz - 1} ${bx + 1} ${by + 3} ${bz + 1} minecraft:air`);
  await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
  await sleep(1200);
  await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);

  const at = new Vec3(bx, by, bz);
  const read = () => {
    const b = bot.blockAt(at);
    return b && typeof b.stateId === 'number' ? b : null;
  };
  // 等第一列真到客户端，否则整轮全是 null
  await waitFor(read, () => true, 10000);

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
  const prev = readManifest(String(args.ids ?? outPath));
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
  for (const [name, spec] of (itemsOnly ? [] : entries)) {
    n++;
    if (completeBlocks.has(name)) continue;
    const states = spec.states?.length ? spec.states : [{}];
    const list = [];
    for (const st of states) {
      const arg = Object.keys(st).length > 0 ? `[${propsKey(st)}]` : '';
      let got = null;
      // 只有作物需要换支撑（要耕地）。非作物别动这一格 —— 每状态都重设一次会让
      // 方块触发一次更新，实测把整轮测量搞成了同一个残留 id。
      if (cropNames.has(name)) {
        await cmd(`setblock ${bx} ${by - 1} ${bz} minecraft:farmland`);
      }
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        await cmd(`setblock ${bx} ${by} ${bz} minecraft:air`);
        await waitFor(read, (b) => b.stateId === 0, 900);
        const resp = await cmd(`setblock ${bx} ${by} ${bz} ${name}${arg}`);
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
    const physicsWas = bot.physicsEnabled;
    bot.physicsEnabled = false;
    let injected = true;
    try {
      installModRegistry(bot, tempPack);
    } catch (err) {
      injected = false;
      process.stderr.write('  自检跳过（注册表注入失败）：' + err.message + '\n');
    }
    const bad = [];
    for (const name of (injected ? Object.keys(blocks) : [])) {
      // 非作物也要有支撑面，否则方块会掉下去 —— 用石头；作物用耕地
      const soil = cropNames.has(name) ? 'minecraft:farmland' : 'minecraft:stone';
      await cmd('setblock ' + bx + ' ' + (by - 1) + ' ' + bz + ' ' + soil);
      await cmd('setblock ' + bx + ' ' + by + ' ' + bz + ' ' + name);
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
    bot.physicsEnabled = physicsWas;
    if (!injected) {
      process.stderr.write('  自检没做：注册表没注上\n');
    } else if (bad.length > 0) {
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
