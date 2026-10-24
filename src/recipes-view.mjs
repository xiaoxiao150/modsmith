/**
 * 清单 → mineflayer 可消费的合成视图（"清单能不能被机器人合"的唯一形状实现）。
 *
 * 清单里的 recipes 有两种形状：jar 提取的（pattern + key）和服务端真值的（grid + 候选数组）。
 * 消费方（宿主）不该为两种形状各写一份解析——这里归一成一种：
 *
 *   { id, type, pattern: string[], key: { [ch]: ItemRef | ItemRef[] }, result: { id, count } }
 *   { id, type, ingredients: Array<ItemRef[]>, result: { id, count } }
 *
 * ItemRef 保持原样（{item}/{id} 或 {tag}）：名字解析（tag → 候选）仍在消费方做，那里有
 * manifest.candidates 和约定的兜底表，视图不重复实现、不改变既有行为。
 *
 * 只输出可合成的两种类型；`unsupported`（SimpleRecipeSerializer 等无原料产物的）跳过。
 */

/** 候选集合 → 稳定签名（同集合复用同一字符，省 key 表条目）。 */
function signatureOf(cands) {
  return JSON.stringify((cands ?? []).map((c) => c.item ?? c.id ?? c.tag ?? ''));
}

const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 服务端形状（grid）→ pattern/key；旧形状原样返回。 */
function shapedView(raw) {
  if (Array.isArray(raw.pattern) && raw.pattern.length > 0) {
    return { pattern: raw.pattern, key: raw.key ?? {} };
  }
  const grid = raw.grid;
  if (!Array.isArray(grid) || grid.length === 0) return null;
  const key = {};
  const bySig = new Map();
  let nextChar = 0;
  const pattern = grid.map((row) => {
    let line = '';
    for (const cell of row ?? []) {
      const cands = Array.isArray(cell) ? cell : (cell ? [cell] : []);
      if (cands.length === 0) { line += ' '; continue; }
      const sig = signatureOf(cands);
      let ch = bySig.get(sig);
      if (!ch) {
        if (nextChar >= KEY_CHARS.length) return null;   // 字符表不够（>62 种格子）：放弃这条
        ch = KEY_CHARS[nextChar++];
        bySig.set(sig, ch);
        key[ch] = cands.length === 1 ? cands[0] : cands;
      }
      line += ch;
    }
    return line;
  });
  if (pattern.some((line) => line === null)) return null;
  if (pattern.every((line) => line.trim() === '')) return null;
  return { pattern, key };
}

/** shapeless：每格统一成候选数组（旧形状的单引用包成单元素数组）。 */
function shapelessView(raw) {
  const ings = raw.ingredients;
  if (!Array.isArray(ings) || ings.length === 0) return null;
  return ings.map((ref) => (Array.isArray(ref) ? ref : [ref]));
}

/**
 * @param {object} manifest
 * @returns {Array<{id?: string, type: string, pattern?: string[], key?: object, ingredients?: Array, result: {id: string, count: number}}>}
 */
export function craftRecipeViews(manifest) {
  const views = [];
  for (const raw of manifest.recipes ?? []) {
    if (!raw || typeof raw !== 'object' || raw.unsupported) continue;
    const type = String(raw.type ?? '');
    const res = raw.result;
    const result = res && typeof res === 'object' && !Array.isArray(res) && typeof res.id === 'string' && res.id
      ? { id: res.id, count: Number.isFinite(Number(res.count)) && Number(res.count) > 0 ? Number(res.count) : 1 }
      : null;
    if (!result) continue;

    if (type === 'crafting_shaped') {
      const shape = shapedView(raw);
      if (shape) views.push({ id: raw.id, type, ...shape, result });
    } else if (type === 'crafting_shapeless') {
      const ings = shapelessView(raw);
      if (ings) views.push({ id: raw.id, type, ingredients: ings, result });
    }
  }
  return views;
}
