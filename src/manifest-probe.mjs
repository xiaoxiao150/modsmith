/**
 * probe 的观测结果与 manifest 之间的桥。
 *
 * 分开写成一个纯函数模块，是因为这里有两条硬规矩，且都要能被单测钉住：
 *
 *   1. **容器的唯一权威是实测**。名字像容器（`*_crate`）不等于能开；静态候选只是"要测哪些"，
 *      测完必须回写，否则自动化承诺漏最后一米。
 *   2. **不擅自改 kind**。观测只能说"这个声明可疑"，不能替 LLM 判断它到底是什么机制。
 *      改错了会让机器人用错交互方式，比留着疑问更糟。
 */

/** 原版容器菜单的窗口类型；开出这些说明它是箱子，不是工作站。 */
const VANILLA_CONTAINER_TYPES = new Set([
  'minecraft:generic_9x1', 'minecraft:generic_9x2', 'minecraft:generic_9x3',
  'minecraft:generic_9x4', 'minecraft:generic_9x5', 'minecraft:generic_9x6',
  'minecraft:generic_3x3', 'minecraft:crafting', 'minecraft:furnace',
  'minecraft:blast_furnace', 'minecraft:smoker', 'minecraft:brewing_stand',
  'minecraft:merchant', 'minecraft:anvil', 'minecraft:beacon',
  'minecraft:hopper', 'minecraft:shulker_box', 'minecraft:cartography_table',
  'minecraft:grindstone', 'minecraft:loom', 'minecraft:smithing', 'minecraft:stonecutter',
]);

/**
 * 一次观测是否支持某个 kind 的声明。
 *
 * **这是必要条件，不是充分条件**：不知道"该放什么料"的情况下，唯一可自动化验证的
 * 就是右键开不开窗。它能挡住"把 GUI 站说成无界面站"这类明显错误，但验不出
 * "砧板到底要食材+刀还是食材+斧头"。文档里也这么写，别夸大。
 *
 * @param {string} kind
 * @param {{ opensWindow: boolean, windowType?: string|null, placed: boolean }} obs
 * @returns {{ matches: boolean, why: string }}
 */
export function stationMatches(kind, obs) {
  if (!obs.placed) {
    return { matches: false, why: '方块没放下去（注册表里没有，或服务端不认）' };
  }
  const type = String(obs.windowType ?? '');
  if (obs.opensWindow) {
    if (VANILLA_CONTAINER_TYPES.has(type)) {
      return { matches: false, why: `右键开出了原版容器菜单（${type}），它应该进 containers 而不是 stations` };
    }
    if (kind === 'sidecar-recipe') {
      return { matches: false, why: `右键能开出菜单（${type || '未知类型'}），不需要侧车模组` };
    }
    return { matches: false, why: `右键开出了菜单（${type || '未知类型'}），盲点右键的机制不成立` };
  }
  if (kind === 'sidecar-recipe') {
    return { matches: true, why: '右键不开窗，符合"需要侧车"' };
  }
  return { matches: true, why: '右键不开窗，符合无界面机制' };
}

/**
 * 把 probe 的产物并回 manifest（就地修改并返回）。
 *
 * @param {object} manifest
 * @param {{ containers?: { ok?: string[], failed?: unknown[] }, stations?: Array<Record<string, unknown>>, probedAt?: string }} probeOut
 * @param {{ writeContainers?: boolean }} [opts] writeContainers=false 时只标注不改容器表
 */
export function applyProbe(manifest, probeOut, opts = {}) {
  const writeContainers = opts.writeContainers !== false;
  const notes = [];

  // ---- 容器：实测说了算 ----
  const ok = Array.isArray(probeOut?.containers?.ok) ? probeOut.containers.ok : null;
  if (writeContainers && ok) {
    const before = Array.isArray(manifest.containers) ? manifest.containers : [];
    const removed = before.filter((n) => !ok.includes(n));
    const added = ok.filter((n) => !before.includes(n));
    manifest.containers = [...ok];
    if (removed.length > 0) notes.push(`容器去掉 ${removed.length} 个（名字像但打不开）：${removed.slice(0, 4).join(', ')}`);
    if (added.length > 0) notes.push(`容器补上 ${added.length} 个（静态没猜到但能开）：${added.slice(0, 4).join(', ')}`);
  }

  // ---- 站点：只标注，不改 kind ----
  const observed = new Map();
  for (const r of Array.isArray(probeOut?.stations) ? probeOut.stations : []) {
    if (r && typeof r.id === 'string') observed.set(r.id, r);
  }
  const stations = Array.isArray(manifest.stations) ? manifest.stations : [];
  for (const st of stations) {
    const r = observed.get(st.id);
    if (!r) continue;
    st.opensWindow = r.opensWindow === true;
    if (r.windowType) st.windowType = String(r.windowType);
    const { matches, why } = stationMatches(st.kind, {
      opensWindow: r.opensWindow === true,
      windowType: r.windowType ?? null,
      placed: r.placed !== false,
    });
    if (!matches) {
      st.needsReview = true;
      st.reviewReason = why;
      notes.push(`${st.id}：${why}`);
    } else {
      delete st.needsReview;
      delete st.reviewReason;
    }
  }

  manifest.probe = {
    at: String(probeOut?.probedAt ?? new Date().toISOString()),
    ...(Array.isArray(probeOut?.containers?.failed) && probeOut.containers.failed.length > 0
      ? { containerFailures: probeOut.containers.failed }
      : {}),
  };

  return { manifest, notes };
}
