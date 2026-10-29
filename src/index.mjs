/**
 * modsmith —— 把一个 Fabric mod jar 变成任何 mineflayer 机器人能用的语义清单。
 *
 * 四步，每步都能单独跑：
 *   inspect   静态提取（无 LLM、无服务器）：方块/物品/配方/tag/中文名/作物推断
 *   calibrate 现场量数字 id（要一台装了 mod 的服务器）
 *   learn     让 LLM 读 jar + wiki，补站点用法与玩法说明，并用真服务器验证
 *   sidecar   给"服务端不开菜单"的站点生成侧车模组
 */
import { inspectJar } from './inspect.mjs';
import { readSidecar, writeSidecar, sidecarTemplateFrom } from './crops-sidecar.mjs';
import { writeManifest } from './manifest-io.mjs';
import { installModRegistry, installMineflayerFixes, loadModPack, setModsDir, listPacks } from './cortico-bridge.mjs';
import { validateManifest, hasErrors, describeIssues, parseManifest, statsOf } from './validate.mjs';
import { checkServerMods, fingerprintDir } from './server-fingerprint.mjs';
import { craftRecipeViews } from './recipes-view.mjs';
import { vanillaItemTable } from './recipes-join.mjs';
import { discoverSerializers, sidesheetFromDiscovery } from './recipes-discover.mjs';
import { buildRecipeGraph, planTarget, outputOf, outputCountOf, canMake } from './plan.mjs';
import { checkManifest, checkIds, checkRegistry, runConformance, summarize } from './conformance.mjs';

export { inspectJar, readSidecar, writeSidecar, sidecarTemplateFrom, writeManifest };

// 宿主消费的窄面：注册表注入、mineflayer 容错、包加载、manifest 校验。
// 这几样在宿主里曾各有一份拷贝，收敛到这里，宿主按包依赖（README「跟宿主项目对接」）。
export {
  installModRegistry, installMineflayerFixes, loadModPack, setModsDir, listPacks,
  validateManifest, hasErrors, describeIssues, parseManifest, statsOf,
  checkServerMods, fingerprintDir, craftRecipeViews, vanillaItemTable,
  discoverSerializers, sidesheetFromDiscovery,
  buildRecipeGraph, planTarget, outputOf, outputCountOf, canMake,
  checkManifest, checkIds, checkRegistry, runConformance, summarize,
};

export const VERSION = '0.7.0';
