/**
 * 真机参考消费：连一台测试/生产服务器，用真实 mineflayer bot 消费 manifest+ids。
 *
 * 只读：不 setblock、不 summon、不聊天。它验证的是「一个普通 mineflayer bot 在
 * inject_allowed 前注入后，真的能拿到方块/形状/实体」——比离线模拟更接近宿主。
 * 需要写世界的抽样验证（setblock/召唤）留给人工测试服，不在这里做。
 */
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { installModRegistry, installMineflayerFixes } from './cortico-bridge.mjs';
import { checkRegistry } from './conformance.mjs';
import { makeRcon } from './rcon.mjs';

function waitSpawn(bot, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (err) => {
      if (timer) clearTimeout(timer);
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('end', onEnd);
      if (err) reject(err);
      else resolve();
    };
    const onSpawn = () => done(null);
    const onError = (err) => done(err instanceof Error ? err : new Error(String(err)));
    const onEnd = (reason) => done(new Error(`连接在 spawn 前结束：${reason}`));
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('end', onEnd);
    timer = setTimeout(() => done(new Error(`等 spawn 超时（${timeoutMs}ms）`)), timeoutMs);
  });
}

function sampleStates(manifest) {
  const out = [];
  for (const [name, spec] of Object.entries(manifest.blocks ?? {})) {
    const states = spec?.states ?? [];
    if (states.length === 0) continue;
    const short = name.split(':')[1] ?? name;
    if (/_stairs/.test(short)) {
      for (const half of ['bottom', 'top']) {
        const state = states.find((s) => s.half === half);
        if (state) out.push({ name, props: state, why: `stairs ${half}` });
      }
    } else if (/_slab/.test(short)) {
      for (const type of ['bottom', 'top']) {
        const state = states.find((s) => s.type === type);
        if (state) out.push({ name, props: state, why: `slab ${type}` });
      }
    } else if (spec.solid !== false && Array.isArray(spec.box)) {
      out.push({ name, props: states[0], why: 'solid full block' });
    }
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

function blockSpec(name, props) {
  const entries = Object.entries(props ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return name;
  return `${name}[${entries.map(([k, v]) => `${k}=${v}`).join(',')}]`;
}

/**
 * 在固定测试格 setblock + tp，读真实 bot 的 blockAt/shapes。只应在测试服使用。
 * 返回 L2/L3 检查；不碰生产服。
 */
export async function sampleWorld({ bot, manifest, ids, rcon, x = 400, y = 100, z = 400, timeoutMs = 20_000 }) {
  const checks = [];
  const cmd = await makeRcon(rcon.host ?? '127.0.0.1', rcon.port, rcon.password);
  const username = bot.username;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = new Vec3(x, y, z);
  try {
    await cmd(`forceload add ${x - 2} ${z - 2} ${x + 2} ${z + 2}`);
    await cmd(`tp ${username} ${x + 0.5} ${y + 1} ${z + 0.5}`);
    await sleep(600);
    const signatures = new Map();
    for (const sample of sampleStates(manifest)) {
      const spec = blockSpec(sample.name, sample.props);
      const placed = await cmd(`setblock ${x} ${y} ${z} ${spec} replace`);
      // setblock 到客户端区块更新有延迟。只等固定 250ms 时读到的是上一态（名字还一样，
      // 台阶/楼梯的上下两态就会看起来"形状相同"）。先按这一态的**判别属性**等。
      // 只按 half/type 比：楼梯的 shape 会被邻居校正（inner_left→straight），
      // 不能要求完整 props 命中，否则会把服务端正常行为误报成 id 错。
      const key = sample.why.startsWith('stairs ') ? ['half']
        : sample.why.startsWith('slab ') ? ['type'] : [];
      const expected = (ids.blocks?.[sample.name] ?? [])
        .filter((m) => key.every((k) => String(m.props?.[k]) === String(sample.props?.[k])))
        .map((m) => m.stateId);
      await sleep(250);
      let block = bot.blockAt(at);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && block
        && expected.length > 0 && !expected.includes(block.stateId)) {
        await sleep(100);
        block = bot.blockAt(at);
      }
      const okName = block?.name === sample.name;
      const okState = expected.length === 0 || expected.includes(block?.stateId);
      const shape = block?.shapes ?? [];
      signatures.set(`${sample.name}\u0000${sample.why}`, JSON.stringify(shape));
      checks.push({
        id: 'L2', level: okName && okState && shape.length > 0 ? 'pass' : 'fail',
        subject: sample.name,
        message: !okName
          ? `${sample.why}：服务端/客户端名字对不上（${block?.name ?? 'null'}）`
          : !okState
            ? `${sample.why}：stateId ${block?.stateId} 不在 ids 的 ${expected.slice(0, 4).join('/')} 里`
            : `${sample.why}：${placed.includes('Changed') ? '已放置' : placed}，shape ${shape.length}`,
      });
      await cmd(`setblock ${x} ${y} ${z} air replace`);
    }
    // 非空还不够：上下两态若被记成同一个 stateId，玩家看到的是半砖/楼梯永远一个朝向，
    // 而 shape 长度照样 >0。这里把上下两态的形状逐字节比一次（实测 Supplementaries
    // 的台阶/楼梯靠这条才能区分"读对了"和"都读成默认态"）。
    for (const [name, kind] of Object.entries({
      'stairs bottom': 'stairs top',
      'slab bottom': 'slab top',
    })) {
      for (const [key, low] of signatures) {
        const [subject, why] = key.split('\u0000');
        if (why !== name) continue;
        const high = signatures.get(`${subject}\u0000${kind}`);
        if (high === undefined) continue;
        checks.push({
          id: 'L2', level: low !== high ? 'pass' : 'fail', subject,
          message: low !== high
            ? `${name.split(' ')[0]} 的上下两态形状不同`
            : `${name.split(' ')[0]} 的上下两态形状相同（stateId 映射可疑）`,
        });
      }
    }

    const entityName = Object.entries(ids.entities ?? {}).find(([, e]) => !e?.boss)?.[0];
    if (entityName) {
      await cmd(`summon ${entityName} ${x + 3} ${y + 1} ${z}`);
      await sleep(800);
      const seen = Object.values(bot.entities ?? {}).some((e) => e?.name === entityName);
      checks.push({
        id: 'L3', level: seen ? 'pass' : 'fail', subject: entityName,
        message: seen ? '召唤后 bot.entities 认得出名字' : '召唤后 bot.entities 里找不到这个名字',
      });
      await cmd(`kill @e[type=${entityName}]`);
    } else {
      checks.push({ id: 'L3', level: 'warn', subject: 'entities', message: 'ids 里没有非 boss 实体可抽样' });
    }
  } finally {
    await cmd(`setblock ${x} ${y} ${z} air replace`).catch(() => undefined);
    await cmd(`forceload remove ${x - 2} ${z - 2} ${x + 2} ${z + 2}`).catch(() => undefined);
    cmd.close();
  }
  return checks;
}

/**
 * @param {{
 *   manifest: object, ids: object,
 *   host?: string, port?: number, username?: string, version?: string,
 *   timeoutMs?: number,
 *   rcon?: { port: number, password: string, x?: number, y?: number, z?: number } | null,
 * }} opts
 */
export async function liveConformance(opts) {
  const {
    manifest, ids,
    host = '127.0.0.1', port = 25565, username = 'ModConform', version = '1.21.1',
    timeoutMs = 60_000, rcon = null,
  } = opts;
  let bot = null;
  try {
    bot = mineflayer.createBot({
      host, port, username, version, auth: 'offline', viewDistance: 2,
    });
    // 与宿主一样：必须在 inject_allowed 之前注入静态注册表。
    const counts = installModRegistry(bot, { manifest, ids });
    // prismarine-registry 会复用 minecraft-data 缓存；同进程里先跑过离线验收时，
    // 注入器可能认为实体已经在了而返回 0。以真实 registry 里的条目为准。
    counts.entities = Object.keys(ids.entities ?? {})
      .filter((name) => Boolean(bot.registry?.entitiesByName?.[name])).length;
    // 只读验证不依赖命令树/实体元数据；大 mod（TF）这两类包会让 protodef 整包错位。
    installMineflayerFixes(bot, { extraDrop: ['entity_metadata', 'declare_commands'], dropCommands: true });
    await waitSpawn(bot, timeoutMs);
    const checks = checkRegistry(manifest, ids, bot.registry, { installed: true });
    if (rcon?.password) {
      checks.push(...await sampleWorld({ bot, manifest, ids, rcon, x: rcon.x, y: rcon.y, z: rcon.z }));
    }
    return {
      counts,
      checks,
      bot: {
        username: bot.username,
        version: bot.version,
        dimension: String(bot.game?.dimension ?? 'unknown'),
        position: bot.entity?.position
          ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z),
          }
          : null,
      },
    };
  } finally {
    try { bot?.quit('conformance done'); } catch { /* 已经断开 */ }
  }
}