import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { frameOf, makeRcon } from '../src/rcon.mjs';

/** 一个只做认证 + 回显的最小 RCON 服务端。 */
function fakeServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const len = buf.readInt32LE(0);
          if (buf.length < 4 + len) break;
          const body = buf.subarray(4, 4 + len);
          const id = body.readInt32LE(0);
          const type = body.readInt32LE(4);
          buf = buf.subarray(4 + len);
          sock.write(frameOf(id, type === 3 ? 2 : 0, type === 3 ? '' : 'ok'));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('RCON 客户端能发命令，close() 会真的断开 socket（onboard 不挂住的前提）', async () => {
  const server = await fakeServer();
  const { port } = server.address();
  const closed = new Promise((resolve) => server.once('close', resolve));
  const cmd = await makeRcon('127.0.0.1', port, 'pw');
  assert.equal(await cmd('hello'), 'ok');
  assert.equal(typeof cmd.close, 'function');
  cmd.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => server.close(resolve));
  await closed;
});