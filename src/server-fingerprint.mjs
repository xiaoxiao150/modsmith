/**
 * 服务器 mods 目录指纹 —— 堵「ids 静默过期」那扇门。
 *
 * 1.21 的方块/物品 id 取决于加载顺序：服务器加一个 mod、换一套 jar，**所有 id 整体
 * 位移**。ids 只记 mod/version/measuredAt，看不出"是在哪台服务器的哪套 jar 上量的"，
 * 于是自检防住的「看见米捆其实是橱柜」会从加载这一侧原样进来——自检防的是量错，
 * 防不了用错。
 *
 * 指纹 = mods 目录顶层文件按名排序，逐个 sha256，再对这张清单哈希一次。清单里留下
 * 每个文件的 {file, bytes, sha256}，是为了对不上时能说出**哪个 jar 变了**，而不是
 * 只会报一句"不一致"。大目录全量读文件要几秒——calibrate 本来就是分钟级，不计较。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 对一份文件清单算总指纹。清单元素：{file, bytes, sha256}。 */
export function fingerprintOf(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.file}:${f.bytes}:${f.sha256}\n`);
  return h.digest('hex');
}

/**
 * 不参与指纹的文件：`modsmith-sidecar-*` 是我们自己产出的通用侧车。
 *
 * 它只注册命令、不注册任何方块/物品，**不可能让 id 位移**；把它算进指纹会让
 * "装上侧车 → verify 立刻说 ids 过期"——实测在 onboard 链上直接卡死。
 */
const IGNORED = [/^modsmith-sidecar.*\.jar$/i];

/** 读一个 mods 目录（顶层文件），算出指纹。目录不存在/读不了会抛，由调用方决定怎么报。 */
export function fingerprintDir(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => !IGNORED.some((re) => re.test(name)))
    .sort();
  const files = names.map((file) => {
    const buf = readFileSync(join(dir, file));
    return { file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  });
  return { fingerprint: fingerprintOf(files), files };
}

/** 两份文件清单的差异，供拒绝时说清楚差在哪。 */
export function diffFileLists(storedFiles, currentFiles) {
  const stored = new Map((storedFiles ?? []).map((f) => [f.file, f]));
  const current = new Map((currentFiles ?? []).map((f) => [f.file, f]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [name, f] of current) {
    const o = stored.get(name);
    if (!o) added.push(name);
    else if (o.sha256 !== f.sha256 || o.bytes !== f.bytes) changed.push(name);
  }
  for (const name of stored.keys()) {
    if (!current.has(name)) removed.push(name);
  }
  return {
    changed, added, removed,
    same: changed.length === 0 && added.length === 0 && removed.length === 0,
  };
}

/**
 * 校验 ids 里记录的指纹对不对得上当前 mods 目录。
 *
 * @param {{fingerprint?: string, files?: Array}|undefined} idsServerMods ids.serverMods，老文件没有这个字段
 * @param {string|undefined} dir --server-mods 给的目录；没给就是 undefined
 * @returns {{ok: boolean, fatal: boolean, lines: string[]}}
 *   fatal=true  → ids 不能用（换过服务器/换过 jar）
 *   fatal=false → 可以用；lines 里可能是「没给目录校不了」「老文件没指纹」的降级警告
 */
export function checkServerMods(idsServerMods, dir) {
  if (!dir) {
    if (idsServerMods?.fingerprint) {
      return { ok: true, fatal: false, lines: ['ids 带服务器指纹；没给 --server-mods，跳过校验'] };
    }
    return {
      ok: true, fatal: false,
      lines: ['ids 没有服务器指纹、也没给 --server-mods：无法判断它是不是在别的服务器上量的。下次 calibrate 加 --server-mods <服务器 mods 目录>'],
    };
  }
  let current;
  try {
    current = fingerprintDir(dir);
  } catch (err) {
    return {
      ok: false, fatal: true,
      lines: [`--server-mods ${dir} 读不了（${err.message ?? err}）——路径打错了还是服务器没装好？`],
    };
  }
  if (!idsServerMods?.files) {
    return {
      ok: true, fatal: false,
      lines: [`ids 没有服务器指纹（量它那次没记录）：当前 mods 目录指纹 ${current.fingerprint.slice(0, 12)}…。重跑一次 calibrate --server-mods ${dir} 补上`],
    };
  }
  const diff = diffFileLists(idsServerMods.files, current.files);
  if (diff.same && idsServerMods.fingerprint === current.fingerprint) {
    return { ok: true, fatal: false, lines: [`服务器 mods 指纹对得上（${current.files.length} 个文件）`] };
  }
  const lines = [
    `ids 的服务器指纹对不上（ids 记录 ${String(idsServerMods.fingerprint ?? '(无)').slice(0, 12)}…，当前 ${current.fingerprint.slice(0, 12)}…）：`,
  ];
  for (const f of diff.changed) lines.push(`  变了：${f}`);
  for (const f of diff.added) lines.push(`  多了：${f}`);
  for (const f of diff.removed) lines.push(`  少了：${f}`);
  lines.push('ids 是在另一套 jar 上量的，注入后所有 id 可能整体位移——宁可拒绝，不能错名。');
  lines.push(`重跑：modsmith calibrate <manifest> --port <port> --rcon-password <pw> --place --server-mods ${dir}`);
  return { ok: false, fatal: true, lines };
}
