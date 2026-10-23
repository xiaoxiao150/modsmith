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

export { inspectJar, readSidecar, writeSidecar, sidecarTemplateFrom, writeManifest };

export const VERSION = '0.1.0';
