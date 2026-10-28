/**
 * modsmith onboard <jar> —— 把六步串成一条命令：
 *   inspect → calibrate → probe → verify → recipes → sidecar
 *
 * 每步的产物就是下一步的输入；哪步失败就停在哪（子命令自己 fatal 退出），绝不带病前进。
 * 这里的职责只有两件：把步骤排好（纯函数，可测）、把参数分发对（CLI）。
 *
 * 边界（AGENTS 四条约束在这里的落地）：
 *   - 绝不自动装 jar：服务器 mods 目录里有没有这个 jar 是人的事，onboard 只假设"已装"；
 *   - recipes 默认 --write：整条链是全新量出来的（ids 当天、指纹对上），且有 95% 闸门兜底；
 *     不想写就 --dry-recipes，之后单跑；
 *   - sidecar 只产出配置与编译产物，不装。
 */

/**
 * 排出执行计划。
 *
 * @param {{
 *   jar: string,              // mod jar 路径
 *   pack: string,             // 包名（mods/ 下的文件名，不带 .json）
 *   modsDir?: string,         // manifest/ids 目录，默认 ./mods
 *   server?: { host?: string, port?: number, rconPort?: number, rconPassword?: string,
 *              mcVersion?: string, serverMods?: string, x?: number, y?: number, z?: number } | null,
 *   skip?: string[],          // 显式跳过的步骤 id（比如 ids 是昨天量的，calibrate 跳过）
 *   resume?: boolean,         // 产物已存在的步骤标记 done（断点续跑）
 *   artifacts?: { manifest?: boolean, ids?: boolean, serverRecipes?: boolean },
 *   dryRecipes?: boolean,     // recipes 步骤不写回（默认写）
 *   noBuild?: boolean,        // sidecar 不编译
 *   dump?: string | null,     // registry dump JSON：有就替代 calibrate（秒级）
 * }} opts
 * @returns {{ steps: Array<{id, title, argv: string[], done: boolean, blocked: boolean, reason: string}>, manifestPath: string, idsPath: string }}
 */
export function onboardPlan(opts) {
  const {
    jar, pack, modsDir = './mods', server = null, skip = [], resume = false,
    artifacts = {}, dryRecipes = false, noBuild = false, dump = null,
  } = opts;
  const dir = modsDir.replace(/[\\/]+$/, '');
  const manifestPath = `${dir}/${pack}.json`;
  const idsPath = `${dir}/${pack}-ids.json`;
  // probe --scan-blocks 的证据落在这里，learn --infer 直接吃它。
  const probePath = `${dir}/${pack}-probe.json`;
  const srv = server ?? {};
  const serverArgs = [];
  for (const [flag, value] of [
    ['--host', srv.host], ['--port', srv.port], ['--rcon-port', srv.rconPort],
    ['--rcon-password', srv.rconPassword], ['--mc-version', srv.mcVersion],
    ['--server-mods', srv.serverMods], ['--x', srv.x], ['--y', srv.y], ['--z', srv.z],
  ]) {
    if (value !== undefined && value !== null && value !== false) serverArgs.push(flag, String(value));
  }
  const hasServer = Boolean(srv.rconPassword);

  // 显式 --skip 不打断链条（跳过的前提是人已有那份产物）；blocked 才级联。
  let chainBroken = false;
  const step = (id, title, argv, done, needsServer) => {
    const skipped = skip.includes(id);
    const missingServer = needsServer && !hasServer;
    const blocked = !skipped && (missingServer || chainBroken);
    if (blocked) chainBroken = true;
    const reason = skipped ? '已用 --skip 显式跳过'
      : missingServer ? '没有 --rcon-password（连不了服务器）'
      : blocked ? '前序步骤无法执行，级联暂停'
      : '';
    return { id, title, argv, done: Boolean(resume && done && !skipped), blocked, reason };
  };

  const idStep = () => (dump
    ? step('ids', '注册表 dump → ids（秒级）', [
      'import-dump', dump, '--manifest', manifestPath, '--ids', idsPath,
      ...(srv.serverMods ? ['--server-mods', String(srv.serverMods)] : []),
      ...(srv.mcVersion ? ['--mc-version', String(srv.mcVersion)] : []),
    ], Boolean(artifacts.ids), false)
    : step('calibrate', '现场量数字 id', ['calibrate', manifestPath, '--ids', idsPath, ...(resume ? ['--resume'] : []), ...serverArgs], Boolean(artifacts.ids), true));

  return {
    manifestPath,
    idsPath,
    probePath,
    steps: [
      step('inspect', '静态提取清单', ['inspect', jar, '--out', modsDir, '--pack', pack], Boolean(artifacts.manifest), false),
      idStep(),
      // --scan-blocks：把候选方块逐个右键一遍，记录开窗行为——这是 learn --infer 的证据。
      step('probe', '实测容器/站点 + 方块扫描', ['probe', manifestPath, '--pack', pack, '--mods-dir', modsDir,
        '--scan-blocks', '--out', probePath, ...serverArgs], Boolean(artifacts.probe), true),
      // recipes 必须排在 learn/verify **之前**：
      //   - learn 的工具检测读 `tool` 数组（jar 形状里是 {fabric:type:…} 对象，
      //     读不出工具 → cutting_board 会被误判成侧车）
      //   - verify 的站点执行要用服务端真配方（cooking_time、多原料、results[] 形状）
      // --server-mods 要给 recipes：discover 从服务器所有 jar + 原版 jar 扫配方名，
      // 名字清单越全，切段越准（缺了它，新 mod 的发现会卡在名字缺口上）。
      // --ids-all：同一台服上第二个包翻译时必然碰到别的包的物品（捕获是整服配方）。
      // 只有一份 ids 时它是空操作；多份时按指纹闸拒绝混用不同 jar 组合的量测。
      step('recipes', '服务端真配方翻进清单', ['recipes', manifestPath, '--ids', idsPath, '--ids-all', modsDir,
        ...(srv.serverMods ? ['--server-mods', String(srv.serverMods)] : []),
        ...(dryRecipes ? [] : ['--write'])], Boolean(artifacts.serverRecipes), false),
      // 推断工作站：规则优先，不需要模型；有 probe 证据就用证据。
      step('learn', '推断工作站与机制', ['learn', manifestPath, '--infer', '--evidence', probePath], Boolean(artifacts.stations), false),
      step('verify', '合成冒烟 + 站点实测', ['verify', manifestPath, '--pack', pack, '--ids', idsPath, '--mods-dir', modsDir,
        '--stations', ...serverArgs], false, true),
      step('sidecar', '站点侧车（配置 + 编译）', ['sidecar', manifestPath, '--out', './sidecars', ...(noBuild ? ['--no-build'] : [])], false, false),
    ],
  };
}
