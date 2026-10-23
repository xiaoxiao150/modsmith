/**
 * 容器候选的静态判定。
 *
 * 名字像容器不等于能当容器用——农夫乐事的 `*_crate` 名字最像，实测却**不发**
 * `open_window`；橱柜和篮子发。所以这里只产出"候选"，真伪由 `probe` 阶段实测确认
 *（需要一个装了 mod 的服务器）。
 *
 * 这个模块只做静态筛选，不假装知道答案。
 */

/** 名字像容器的后缀。**只是候选**，不是结论。 */
const CONTAINER_HINTS = /(_cabinet|_basket|_crate|_barrel|_chest|_box|_case|_drawer|_shelf)$/;

/**
 * 从方块表里挑出可能能当容器用的。
 *
 * 额外要求：有物品形式（能靠 /give 拿到，才测得了）、有碰撞盒（容器是实体方块）。
 *
 * @param {Record<string, {solid?: boolean}>} blocks
 * @param {Record<string, unknown>} items
 * @returns {{ candidates: string[], rejected: Array<{name: string, why: string}> }}
 */
export function containerCandidates(blocks, items) {
  const candidates = [];
  const rejected = [];
  for (const full of Object.keys(blocks)) {
    const short = full.split(':')[1] ?? full;
    if (!CONTAINER_HINTS.test(short)) continue;
    if (!(full in items)) {
      rejected.push({ name: full, why: '没有物品形式，放不下来也测不了' });
      continue;
    }
    candidates.push(full);
  }
  return { candidates: candidates.sort(), rejected };
}
