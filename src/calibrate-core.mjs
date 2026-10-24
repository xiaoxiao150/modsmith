/**
 * calibrate 的纯函数部分：放置补测的嫌疑判定、stateId 去重（两遍认领）、去重记账。
 *
 * 单独成模块是为了能不连服务器就测——`calibrate` 主体是 CLI 集成测试的活，
 * 这三段判据却是纯数据变换，放进 `test/calibrate-core.test.mjs` 用真实数据的形状钉住。
 */

/**
 * 放置补测的嫌疑判定：**量出来的不同 stateId 比声明的状态数少** —— 那就是服务器
 * `/setblock` 设不动属性的那批（煎锅的 support、砧板朝向、锅的支撑）。
 *
 * 不能写成"多个状态量成同一个号"：去重会先把块内重复收掉，那个条件永远不成立（踩过）。
 * 这个判据在去重前后都成立，而且能抓住"12 个状态只量到 8 个"这种半塌的情况——
 * 前提是它数的是 Set（去重后的不同 id），块内重复条目骗不了它。
 */
export function computeSuspects(idsBlocks, manifestBlocks) {
  const suspects = [];
  for (const [name, list] of Object.entries(idsBlocks ?? {})) {
    const declared = (manifestBlocks?.[name]?.states ?? []).length;
    if (declared <= 1) continue;
    const distinct = new Set(list.map((e) => e.stateId)).size;
    if (distinct < declared) suspects.push({ name, distinct, declared });
  }
  return suspects;
}

/**
 * 一个 stateId 只能属于一个方块。
 *
 * `/setblock` 改不动属性时，几十个方块会被记成同一个残留 id。注入时"先到先得"会把
 * 重复的静默丢掉 —— 但清单里留着它们就是假数据：下游任何按 stateId 反查的地方都会
 * 拿到错的那个方块。这里在文件层面清干净。
 *
 * 认领两遍：**真实放置量到的 id 先挑**（`note: '真实放置校准'`，它是方块的真身，
 * /setblock 读到的残留值不能抢走它，否则一个方块的唯一真 id 会归给别的方块，
 * 自检再把它整个删掉——实测丢过 15 个），再轮到 setblock 量到的。
 * 每一遍都按 `blockOrder`（manifest 的方块顺序）扫，先声明者得。
 *
 * 不改入参，返回新的 blocks 映射（去重后变空的方块整个移除）与丢弃记录供记账。
 */
export function dedupeStateIds(blocks, blockOrder) {
  const claimed = new Map();
  const dupDropped = [];
  const sameBlockDropped = [];
  let current = blocks;

  for (const prefer of [true, false]) {
    const next = {};
    for (const name of blockOrder) {
      const list = current[name];
      if (!Array.isArray(list)) continue;
      const kept = (next[name] = []);
      for (const e of list) {
        const id = e.stateId;
        if (!(id > 0)) continue;
        // prefer=true 时这一遍只认领"真实放置量到的"，其余原样带到下一遍
        const isPlaced = e.note === '真实放置校准';
        if (prefer !== isPlaced) { kept.push(e); continue; }
        const owner = claimed.get(id);
        if (owner === undefined) {
          claimed.set(id, name);
          kept.push(e);
        } else if (owner !== name) {
          dupDropped.push({ block: name, stateId: id, owner });
        } else {
          sameBlockDropped.push({ block: name, stateId: id });
        }
      }
    }
    current = next;
  }

  // 清单顺序之外的键原样保留（正常量测只会产出 manifest 里的名字，这是保底）
  for (const [name, v] of Object.entries(blocks)) {
    if (!Array.isArray(v) && current[name] === undefined) current[name] = v;
  }
  for (const name of Object.keys(current)) {
    if (Array.isArray(current[name]) && current[name].length === 0) delete current[name];
  }
  return { blocks: current, dupDropped, sameBlockDropped };
}

/**
 * 把去重结果翻成给操作者看的行与写进 failed 的记录——报告的数字必须与写进
 * failed 的条目数一致（对账口径）。
 */
export function dedupReport(dupDropped, sameBlockDropped) {
  const lines = [];
  const failed = [];
  if (dupDropped.length > 0) {
    lines.push(`去重：${dupDropped.length} 条重复 stateId 被丢弃（归先声明的方块）`);
    for (const d of dupDropped.slice(0, 6)) lines.push(`${d.block} 的 ${d.stateId} 其实属于 ${d.owner}`);
    for (const d of dupDropped) {
      failed.push({ block: d.block, kind: 'duplicate-state', resp: `stateId ${d.stateId} 已归 ${d.owner}` });
    }
  }
  if (sameBlockDropped.length > 0) {
    lines.push(`去重：块内重复 ${sameBlockDropped.length} 条（同一方块同一 stateId）`);
    for (const d of sameBlockDropped.slice(0, 4)) lines.push(`${d.block} 有 ${d.stateId} 列了不止一次`);
    for (const d of sameBlockDropped) {
      failed.push({ block: d.block, kind: 'duplicate-in-block', resp: `stateId ${d.stateId} 在同一方块内重复` });
    }
  }
  return { lines, failed };
}
