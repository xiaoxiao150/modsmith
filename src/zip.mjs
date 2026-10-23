/**
 * 最小 ZIP 读取器。
 *
 * 为什么不装依赖：整个工具只需要"列出条目 + 读出一项"，而 Node 自带 zlib 就能解
 * deflate。为了这一个功能拉一棵依赖树不划算，何况这工具将来要能被人拿去跑。
 *
 * 支持 stored(0) 与 deflate(8) 两种压缩方式——mod jar 只会有这两种。
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 从尾部找 EOCD（注释最长 65535 字节）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65535 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('不是有效的 zip：找不到中央目录结尾');
}

export class Zip {
  constructor(buf) {
    this.buf = buf;
    const eocd = findEocd(buf);
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    /** @type {Map<string, {offset:number, compressedSize:number, size:number, method:number}>} */
    this.entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`中央目录第 ${i} 项签名不对`);
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const offset = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      this.entries.set(name, { offset, compressedSize, size, method });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  static open(path) {
    return new Zip(readFileSync(path));
  }

  names(prefix = '') {
    return [...this.entries.keys()].filter((n) => n.startsWith(prefix));
  }

  has(name) {
    return this.entries.has(name);
  }

  /** 读出一项；不存在给 null。 */
  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const b = this.buf;
    if (b.readUInt32LE(e.offset) !== SIG_LOCAL) throw new Error(`本地头签名不对：${name}`);
    const nameLen = b.readUInt16LE(e.offset + 26);
    const extraLen = b.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const raw = b.subarray(start, start + e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}：${name}`);
  }

  readText(name) {
    const b = this.read(name);
    return b ? b.toString('utf8') : null;
  }

  readJson(name) {
    const t = this.readText(name);
    if (t === null) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
}
