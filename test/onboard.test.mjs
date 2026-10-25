/**
 * onboard 的计划纯函数测试 + CLI --plan 冒烟。
 * 不连服务器：执行是真步骤，计划必须在这里排对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onboardPlan } from '../src/onboard.mjs';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'modsmith.mjs');
const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'tiny-mod.jar');
const SRV = { rconPassword: 'pw', port: 25565, host: '127.0.0.1' };

test('全六步排布：无产物、有服务器 → 全部待执行，参数分发正确', () => {
  const plan = onboardPlan({ jar: 'x.jar', pack: 'tiny-mod', server: SRV });
  assert.deepEqual(plan.steps.map((s) => s.id), ['inspect', 'calibrate', 'probe', 'verify', 'recipes', 'sidecar']);
  for (const s of plan.steps) {
    assert.equal(s.done, false, `${s.id} 不该标记 done`);
    assert.equal(s.blocked, false, `${s.id} 不该 blocked：${s.reason}`);
  }
  const calibrate = plan.steps[1];
  assert.ok(calibrate.argv.includes('--rcon-password'), '服务器参数要传给 calibrate');
  assert.equal(calibrate.argv[calibrate.argv.indexOf('--ids') + 1], './mods/tiny-mod-ids.json');
  const recipes = plan.steps[4];
  assert.ok(recipes.argv.includes('--write'), 'recipes 默认写回');
  const sidecar = plan.steps[5];
  assert.ok(!sidecar.argv.includes('--no-build'), 'sidecar 默认编译');
});

test('缺 rcon-password：需服务器的步骤 blocked 并级联到后续', () => {
  const plan = onboardPlan({ jar: 'x.jar', pack: 'tiny-mod' });
  assert.equal(plan.steps[0].blocked, false, 'inspect 不需要服务器');
  for (const s of plan.steps.slice(1)) {
    assert.equal(s.blocked, true, `${s.id} 应级联 blocked`);
    assert.ok(s.reason.length > 0);
  }
});

test('--skip calibrate 不打断链条（人已有 ids 的场景）', () => {
  const plan = onboardPlan({ jar: 'x.jar', pack: 'tiny-mod', server: SRV, skip: ['calibrate'] });
  const calibrate = plan.steps[1];
  assert.equal(calibrate.blocked, false);
  assert.match(calibrate.reason, /--skip/);
  assert.equal(plan.steps[2].blocked, false, 'probe 不该被显式跳过级联');
});

test('--resume + 产物就位 → 对应步骤标记 done', () => {
  const plan = onboardPlan({
    jar: 'x.jar', pack: 'tiny-mod', server: SRV, resume: true,
    artifacts: { manifest: true, ids: true, serverRecipes: true },
  });
  assert.equal(plan.steps[0].done, true);
  assert.equal(plan.steps[1].done, true);
  assert.equal(plan.steps[4].done, true);
  assert.equal(plan.steps[2].done, false, 'probe 是实测，没有产物概念');
});

test('--dry-recipes 与 --no-build 的传参', () => {
  const plan = onboardPlan({ jar: 'x.jar', pack: 'tiny-mod', server: SRV, dryRecipes: true, noBuild: true });
  assert.ok(!plan.steps[4].argv.includes('--write'));
  assert.ok(plan.steps[5].argv.includes('--no-build'));
});

test('CLI --plan 冒烟：不执行、退出 0、打印步骤', () => {
  const r = spawnSync(process.execPath, [BIN, 'onboard', FIXTURE, '--pack', 'tiny-mod', '--plan'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inspect/);
  assert.match(r.stdout, /sidecar/);
  assert.match(r.stdout, /tiny-mod\.json/);
});
