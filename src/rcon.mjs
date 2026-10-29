/**
 * 最小 RCON 客户端（认证 + 串行命令）。calibrate / probe / verify 共用这一份——
 * 之前三处各贴了一份拷贝，改一处漏两处。协议很简单，但 socket 分包、等待队列这些
 * 细节错一点就"偶发卡住"，不值得三份各自演化。
 */
import net from 'node:net';

/** 编一条 RCON 帧（length + requestId + type + body + 填充）。导出是为了纯测试。 */
export function frameOf(id, type, body) {
  const h = Buffer.alloc(8);
  h.writeInt32LE(id, 0);
  h.writeInt32LE(type, 4);
  const payload = Buffer.concat([h, Buffer.from(body, 'utf8'), Buffer.alloc(2)]);
  const len = Buffer.alloc(4);
  len.writeInt32LE(payload.length, 0);
  return Buffer.concat([len, payload]);
}

/**
 * 连上一台 RCON，返回 `cmd(body) -> Promise<响应文本>`。
 * 命令必须串行发（等待队列按序应答），并发会拿到错位的响应。
 */
export function makeRcon(host, port, password) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(port, host);
    let buf = Buffer.alloc(0);
    let id = 0;
    const waiters = [];
    const fail = (err) => {
      // resolve 之后的 reject 是空操作；真正的清理是把所有挂着的 cmd 等待者全部打断，
      // 否则一个断连就让测量流程无声挂死（TF 实跑踩过）。
      for (const w of waiters.splice(0)) w(null, err);
    };
    const send = (type, body) => {
      id += 1;
      s.write(frameOf(id, type, body));
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
    s.on('error', (err) => fail(err));
    s.on('close', () => fail(new Error('RCON 连接断了')));
    s.on('connect', () => {
      send(3, password);
      waiters.push(() => {
        const api = (cmd) => new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`RCON 命令 15s 无响应：${cmd.slice(0, 60)}`)), 15000);
          send(2, cmd);
          waiters.push((value, err) => {
            clearTimeout(timer);
            if (err) rej(err);
            else res(value);
          });
        });
        // CLI 一个进程会串好几步（onboard）：socket 不关，事件循环就一直挂着，
        // 所有步骤完成后进程也不退出（实测）。
        api.close = () => { try { s.end(); } catch { /* 已经断开 */ } };
        resolve(api);
      });
    });
  });
}
