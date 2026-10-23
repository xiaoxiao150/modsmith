/**
 * 版本号清洗。
 *
 * Fabric 的 `fabric.mod.json` version 常见三种写法：
 *   `1.21.1-3.3.6+refabricated`  （MC 版本在前）
 *   `3.3.6+1.21.1`               （mod 版本在前）
 *   纯 `3.3.6`
 * 统一成 `3.3.6` 形式：去掉 `+` 之后的部分，再去掉开头的 MC 版本前缀。
 */
const MC_VERSION = /^(\d+\.\d+(?:\.\d+)?)-/;

export function modVersionOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'unknown';
  const base = s.split('+')[0];
  const m = MC_VERSION.exec(base);
  return m ? base.slice(m[0].length) : base;
}

/** 宽松比较：用于"两个版本哪个新"，只按数字段。 */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
