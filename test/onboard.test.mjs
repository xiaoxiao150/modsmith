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

test('七步排布：无产物、有服务器 → 全部待执行，参数分发正确', () => {
  const plan = onboardPlan({ jar: 'x.jar', pack: 'tiny-mod', server: SRV });
  assert.deepEqual(plan.steps.map((s) => s.id), ['inspect', 'calibrate', 'probe', 'recipes', 'learn', 'verify', 'sidecar']);
  for (const s of plan.steps) {
    assert.equal(s.done, false, `${s.id} 不该标记 done`);
    assert.equal(s.blocked, false, `${s.id} 不该 blocked：${s.reason}`);
  }
  const calibrate = plan.steps[1];
  assert.ok(calibrate.argv.includes('--rcon-password'), '服务器参数要传给 calibrate');
  assert.equal(calibrate.argv[calibrate.argv.indexOf('--ids') + 1], './mods/tiny-mod-ids.json');
  const recipes = plan.steps[3];
  assert.ok(recipes.argv.includes('--write'), 'recipes 默认写回');
  const sidecar = plan.steps[6];
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
  assert.equal(plan.steps[3].done, true);
  assert.equal(plan.steps[2].done, false, 'probe 没产物时不标 done');
});

test('--dry-recipes 与 --no-build 的传参', () => {
  const plan = onboardPlan({ jar: 'x.jar', pack: 'tiny-mod', server: SRV, dryRecipes: true, noBuild: true });
  assert.ok(!plan.steps[3].argv.includes('--write'));
  assert.ok(plan.steps[6].argv.includes('--no-build'));
});

test('CLI --plan 冒烟：不执行、退出 0、打印步骤', () => {
  const r = spawnSync(process.execPath, [BIN, 'onboard', FIXTURE, '--pack', 'tiny-mod', '--plan'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inspect/);
  assert.match(r.stdout, /sidecar/);
  assert.match(r.stdout, /tiny-mod\.json/);
});

test('onboard：recipes 步骤带上 --server-mods（discover 的配方名清单来源），resume 传给 calibrate', async () => {
  const { onboardPlan } = await import('../src/onboard.mjs');
  const plan = onboardPlan({
    jar: 'SomeMod.jar', pack: 'somemod-1.21.1-1.0.0', modsDir: './mods', resume: true,
    server: { rconPassword: 'x', serverMods: './mods', host: '127.0.0.1', port: 25565 },
    artifacts: {},
  });
  const recipes = plan.steps.find((s) => s.id === 'recipes');
  assert.ok(recipes.argv.includes('--server-mods'), `recipes 要带 --server-mods：${recipes.argv.join(' ')}`);
  assert.ok(recipes.argv.includes('./mods'));
  const calibrate = plan.steps.find((s) => s.id === 'calibrate');
  assert.ok(calibrate.argv.includes('--resume'), `calibrate 要带 --resume：${calibrate.argv.join(' ')}`);
});

test('onboard：L3 步骤接进来了（probe 带 --scan-blocks、learn --infer、verify --stations）', async () => {
  const { onboardPlan } = await import('../src/onboard.mjs');
  const plan = onboardPlan({
    jar: 'SomeMod.jar', pack: 'somemod', modsDir: './mods',
    server: { rconPassword: 'x', serverMods: './mods', port: 25565 },
    artifacts: {},
  });
  const ids = plan.steps.map((s) => s.id);
  assert.deepEqual(ids, ['inspect', 'calibrate', 'probe', 'recipes', 'learn', 'verify', 'sidecar']);

  const probe = plan.steps.find((s) => s.id === 'probe');
  assert.ok(probe.argv.includes('--scan-blocks'), `probe 要扫方块：${probe.argv.join(' ')}`);
  assert.ok(probe.argv.includes('--out'), 'probe 要把证据落盘');

  const learn = plan.steps.find((s) => s.id === 'learn');
  assert.ok(learn.argv.includes('--infer'), `learn 用规则推断：${learn.argv.join(' ')}`);
  assert.ok(learn.argv.includes('--evidence'), 'learn 要吃 probe 的证据');
  // 顺序硬约束：learn 的工具检测和 verify 的站点执行都依赖服务端真配方
  assert.ok(ids.indexOf('recipes') < ids.indexOf('learn'), 'recipes 必须在 learn 之前');
  assert.ok(ids.indexOf('learn') < ids.indexOf('verify'), 'learn 必须在 verify 之前');

  const verify = plan.steps.find((s) => s.id === 'verify');
  assert.ok(verify.argv.includes('--stations'), `verify 要真执行站点：${verify.argv.join(' ')}`);
});

test('onboard：evidence 路径从 probe 输出接到 learn 输入（同一个文件）', async () => {
  const { onboardPlan } = await import('../src/onboard.mjs');
  const plan = onboardPlan({ jar: 'X.jar', pack: 'mypack', modsDir: './mods', server: { rconPassword: 'x' } });
  const probe = plan.steps.find((s) => s.id === 'probe');
  const learn = plan.steps.find((s) => s.id === 'learn');
  const probeOut = probe.argv[probe.argv.indexOf('--out') + 1];
  const learnEv = learn.argv[learn.argv.indexOf('--evidence') + 1];
  assert.equal(probeOut, learnEv, 'probe 写的文件必须就是 learn 读的文件');
  assert.match(probeOut, /mypack-probe\.json$/);
});

test('learn --infer 默认合并：人工站点的命令原样保留，只补字段与追加新站点', async () => {
  const { learnStations } = await import('../src/learn.mjs');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-learn-'));
  try {
    const p = join(dir, 'm.json');
    writeFileSync(p, JSON.stringify({
      mod: 'm', namespace: 'm', containers: [],
      blocks: { 'm:cooking_pot': {}, 'm:cutting_board': {} },
      items: {}, stations: [{
        id: 'cooking_pot', kind: 'sidecar-recipe', block: 'm:cooking_pot',
        command: '/fdchef cook {recipe}', recipeType: 'm:cooking', verified: true,
      }],
      recipes: [
        { id: 'm:cooking/a', type: 'm:cooking', ingredients: [[{ id: 'minecraft:beef' }]] },
        { id: 'm:cutting/b', type: 'm:cutting', ingredients: [[{ id: 'minecraft:beef' }]],
          tool: [{ id: 'm:iron_knife' }, { id: 'm:diamond_knife' }] },
        // 工具家族要至少两条配方才成立（单条可能是偶然同后缀）
        { id: 'm:cutting/c', type: 'm:cutting', ingredients: [[{ id: 'minecraft:porkchop' }]],
          tool: [{ id: 'm:iron_knife' }, { id: 'm:diamond_knife' }] },
      ],
    }));
    const io = { fatal: (m) => { throw new Error(m); } };
    const r = await learnStations(p, {}, io);
    assert.equal(r.ok, true);
    const after = JSON.parse(readFileSync(p, 'utf8'));
    const pot = after.stations.find((x) => x.id === 'cooking_pot');
    assert.equal(pot.command, '/fdchef cook {recipe}', '人工命令必须原样保留');
    assert.equal(pot.verified, true, '人工核实标记不能被推断冲掉');
    const board = after.stations.find((x) => x.block === 'm:cutting_board');
    assert.ok(board, '没被人工占用的工作站要追加进来');
    assert.equal(board.kind, 'two-step-use');
    assert.equal(board.recipeType, 'm:cutting', '新站点要能回连到配方类型');
    assert.equal(board.needsReview, true, '推断出来的必须待审');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('learn --infer 不把新配方类型并进人工站点（命令可能不认那种配方）', async () => {
  const { learnStations } = await import('../src/learn.mjs');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-learn-'));
  try {
    const p = join(dir, 'm.json');
    // m:oven 的词干 oven 也是 cooking_pot 的别名：两种类型落到同一个方块
    writeFileSync(p, JSON.stringify({
      mod: 'm', namespace: 'm', containers: [], blocks: { 'm:cooking_pot': {} }, items: {},
      stations: [{
        id: 'cooking_pot', kind: 'sidecar-recipe', block: 'm:cooking_pot',
        command: '/fdchef cook {recipe}', recipeType: 'm:cooking',
      }],
      recipes: [
        { id: 'm:cooking/a', type: 'm:cooking', ingredients: [[{ id: 'minecraft:beef' }]] },
        { id: 'm:oven/b', type: 'm:oven', ingredients: [[{ id: 'minecraft:bread' }]] },
      ],
    }));
    const io = { fatal: (m) => { throw new Error(m); } };
    const r = await learnStations(p, {}, io);
    assert.equal(r.ok, true);
    const after = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(after.stations.length, 1, '不该为同一方块凭空造第二个站点');
    const pot = after.stations[0];
    assert.equal(pot.command, '/fdchef cook {recipe}');
    assert.equal(pot.recipeType, 'm:cooking', '人工声明的类型不被替换');
    assert.equal(pot.recipeTypes, undefined, '也不许悄悄扩成数组声称支持新类型');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('learn --infer --force 会整段重推（人工命令也覆盖，显式要求才允许）', async () => {
  const { learnStations } = await import('../src/learn.mjs');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-learn-'));
  try {
    const p = join(dir, 'm.json');
    writeFileSync(p, JSON.stringify({
      mod: 'm', namespace: 'm', containers: [], blocks: { 'm:cooking_pot': {} }, items: {},
      stations: [{ id: 'cooking_pot', kind: 'sidecar-recipe', block: 'm:cooking_pot', command: '/fdchef cook {recipe}', recipeType: 'm:cooking' }],
      recipes: [{ id: 'm:cooking/a', type: 'm:cooking', ingredients: [[{ id: 'minecraft:beef' }]] }],
    }));
    const io = { fatal: (m) => { throw new Error(m); } };
    const r = await learnStations(p, { force: true }, io);
    assert.equal(r.ok, true);
    const after = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(after.stations[0].command, '/cooking_pot cook {recipe}', '--force 才允许换成推断命令');
    assert.equal(after.stations[0].inferred, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
