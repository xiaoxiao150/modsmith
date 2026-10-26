/**
 * 多包 ids 合并（`recipes --ids-all` 的实现）。
 *
 * 为什么需要：`declare_recipes` 是**整台服务器**的配方——只要服务器装了第二个包，
 * 第二份清单翻译时就会碰到别的包的物品（实测 MD+FD：302/1631 翻不出名字）。
 * 但不加限制地合并更危险：两份 ids 若出自不同的 jar 组合，数字 id 会整体位移，
 * 合出来的表能把每一条都翻译成**错的物品**（错名比未知更糟）。
 *
 * 所以合并有两道闸：
 *   1. 指纹：所有 ids 的 `serverMods.fingerprint` 必须一致（没指纹的老文件单独提示）
 *   2. 同名冲突：同一个名字两份表给不同 id，直接判定不可信
 */

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/**
 * @param {object} primary 主 ids（本包的 <pack>-ids.json）
 * @param {Array<{file: string, ids: object}>} others 其余包的 ids
 * @returns {{items: Record<string, number>, blocks: Record<string, number>,
 *   conflicts: string[], fingerprints: string[], missingFingerprint: string[]}}
 */
export function mergeIdsTables(primary, others = []) {
  const items = { ...(isObj(primary?.items) ? primary.items : {}) };
  const blocks = { ...(isObj(primary?.blocks) ? primary.blocks : {}) };
  const conflicts = [];
  const fingerprints = new Set();
  const missingFingerprint = [];
  const notePrint = (file, ids) => {
    const fp = ids?.serverMods?.fingerprint;
    if (typeof fp === 'string' && fp) fingerprints.add(fp);
    else missingFingerprint.push(file);
  };
  notePrint('<本包>', primary);

  for (const { file, ids } of others) {
    if (!isObj(ids?.items)) continue;
    notePrint(file, ids);
    for (const [name, id] of Object.entries(ids.items)) {
      if (items[name] !== undefined && items[name] !== id) {
        conflicts.push(`${name}: ${items[name]} vs ${id}（${file}）`);
        continue;
      }
      items[name] = id;
    }
    for (const [name, id] of Object.entries(isObj(ids.blocks) ? ids.blocks : {})) {
      if (blocks[name] !== undefined) continue;
      blocks[name] = id;
    }
  }
  return { items, blocks, conflicts, fingerprints: [...fingerprints], missingFingerprint };
}
