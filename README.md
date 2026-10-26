# modsmith

> 让每个 mineflayer AI 完全学会玩一个 mod / Let every mineflayer AI fully learn to play a mod.

把 Fabric 模组 jar 变成**任何 mineflayer 机器人能用的语义清单**。

Minecraft 机器人是原版协议客户端。它看不见模组方块、拿不到模组配方、也开不出模组界面——
因为 1.21 起方块和物品是**静态注册表**，服务端从不下发，模组追加到哪个数字 id 取决于
加载顺序。`modsmith` 把这一切补齐，并尽量让"接一个新 mod"变成几条命令。

**English in one paragraph:** modsmith turns a Fabric mod jar into a semantic
manifest (blocks, items, recipes, tags, crops) plus measured numeric registry
ids that any mineflayer bot can consume. Minecraft bots speak the vanilla
protocol and 1.21 registries are static — mod blocks and items never get
downloaded, so their numeric ids depend on load order. modsmith recovers them
from a live server you own (OP + RCON required) and keeps the mapping
fingerprinted. Docs are Chinese-first; this README and `AGENTS.md` carry the
full design notes.

## 状态（0.4.1 预览）

- **L1 完成**：单包接入（Farmer's Delight 3.3.6）从 jar 到机器人可用的清单与 ids，生产在用。
- **L2 基本完成**："换一个 mod 只要几条命令 + 审一张表"。暮色森林 4.8.629 实测：
  2134 条配方全解析、17 个自定义序列化器自动发现，不需要 javap；农夫乐事端到端
  `onboard` 通过（发现 → `--accept` → 修订单）。缺口：线上同形的语义拆分
  （`i32`/`f32`、`string`/`varints`）仍需人按备选表拍板——协议本身丢了信息。
- **L3 基本完成**：规则推断工作站（`learn --infer`，可用 `--evidence` 吃实测证据）、
  `verify --stations` 真做一份菜（侧车型 + 多原料两步式都验）、侧车熟成任务可跨断线/
  重启恢复、`probe --scan-blocks` 全量窗口扫描、`onboard` 七步一条龙。
  缺口：单方块多 recipeType（目前一对一）、`learn` 的 LLM 路径未在本轮复验。
- **0.x 期间 manifest / sidesheet 格式可能发生破坏性变更**，会尽量在 README 里标注。

## 前置条件

calibrate / probe / verify 是在**你自己的服务器上动手**：`forceload`、`setblock`、
`give`、`tp`、`clear` 每一条都要 OP，RCON 必须开着。它们没法指向别人的服务器——
没有 OP 就是每条命令静默失败。支持范围也只有 Fabric（Forge/NeoForge 的 FML 握手
是另一套协议，投入产出比差）。

## 四步

```
modsmith inspect  <mod.jar>           静态提取：方块/物品/配方/tag/中文名 + 推断作物
modsmith calibrate <manifest.json>    连服务器量数字 id（/setblock + /give）
modsmith probe    <manifest.json>     实测哪些容器/站点真能用
modsmith verify   <manifest.json>     冒烟：方块认得、物品能拿、配方能合
```

可选一层（要一次 calibrate 捕获）：

```
modsmith recipes <manifest.json>     把服务端真配方翻进清单（KubeJS/数据包改过的，jar 里读不到）
```

可选两层（要 LLM）：

```
modsmith learn    <manifest.json>     LLM 读清单 + wiki，产出站点定义与玩法说明
modsmith sidecar  <manifest.json>     给"服务端不开菜单"的站点生成侧车模组
```

一条龙（六步按序串好，失败即停，`--resume` 断点续跑）：

```
modsmith onboard <mod.jar> --pack <name> \
  --port 25565 --rcon-password yourpw --server-mods ./mods
```

接一个新 mod 时如果 `recipes` 因「未知序列化器编号」失败，那就是包里有自定义配方类型、
wire 文法没写进 sidesheets——不用再拿 javap 人肉逆向了：

```bash
modsmith recipes <manifest.json> --discover            # 用配方名切段，打印待审文法表
modsmith recipes <manifest.json> --discover --write    # 候选落到
                                                       # sidesheets/<pack>.serializers.discovered.json
```

`discover` 的正路是**用配方名切段**：manifest 里的配方 id（inspect 从 jar 扫来的）+
`--server-mods` 目录里所有 jar + 原版 jar 给出整包的名字，每条 payload 的起止就确定了；
再用「候选必须精确落在段尾」筛文法。暮色森林实测：2134 条配方、17 个自定义类型、
40 秒出表——不需要 javap，也不需要逐字节试。

名字清单越全，切段越准；但**不要求覆盖整包**——数据包挂在别的命名空间加的配方
（TF 有 15 条晾干在 `minecraft:` 下）不在任何 jar 里，这时排在它们前面的段尾会偏：
算法先找"能对上每一次出现"的严格文法，没有就退到"对得最多"的候选，再用**整包解析**
裁决（错了就在失败位置换备选）。TF 用只有本 mod 名字的清单实测：2134 条照样全解析。

`onboard` 走到 `recipes` 时如果遇到未知序列化器，会**自动跑一次发现**并打印这张表
（`--write` 时落成待审文件），不再是硬失败。表里的 `name` 已经按清单里该类型配方的
`type` 字段自动填好，不用再从源码找。

看过表之后：

```bash
modsmith recipes <manifest> --discover --server-mods ./mods --accept
# → 写进正式 sidesheet（字段序取发现结果，name 已填）
modsmith recipes <manifest> --write
# → 服务端真配方翻进清单
```

暮色森林实测：`--accept` 产出的 sidesheet 直接可用，2134 条配方 100% 翻译；17 个文法里
15 个与人审结果逐字段一致，另外 2 个是线上同形的等价拆分（scepter 的 i32+varint、
no_template 的 string/varints——字节一样，语义由人按备选表选）。

`onboard` 走到 recipes 遇到新序列化器时会停在这一步、把表打印出来（**不写清单**）：
人跑一次 `recipes --discover --accept` 生成正式 sidesheet，再 `onboard --resume`
继续，recipes 才会写回。这条"停一次、审一次"的节奏是故意的——机器不替人拍板。

表里每条带：出现的次数、命中物品、**首条样例**（对着配方 JSON 核语义用的原始值）和
**线上同形的备选**。i32 与 f32 都是 4 字节、`ingredient` 与 `list[slot]` 是同一段 wire——
这类语义只能由人拍板：挑一个、补上 name，抄进 `<pack>.serializers.json` 才生效。
**候选永不自动生效**；纯 varint 之类"对任何字节都凑得齐"的退化文法会标注可疑。

## 快速开始

```bash
# 1) 看一眼这个 jar 里有什么（不需要服务器，不调 LLM）
#    默认包名 = <mod id>-<MC 版本>-<mod 版本>；要接已有部署就显式 --pack
modsmith inspect ./mods/SomeMod.jar --out ./out

# 2) 装好这个 mod 的服务器起来之后，量数字 id
#    --server-mods 把服务器 mods 目录的指纹记进 ids；日后对不上会拒绝使用
modsmith calibrate ./out/somemod-1.21.1-1.0.0.json \
  --port 25565 --rcon-password yourpw --server-mods ./mods

# 3) 实测容器（名字像容器不等于能用——`*_crate` 名字最像，实测打不开）
modsmith probe ./out/somemod-1.21.1-1.0.0.json --pack somemod-1.21.1-1.0.0 \
  --server-mods ./mods

# 4) 冒烟
modsmith verify ./out/somemod-1.21.1-1.0.0.json --pack somemod-1.21.1-1.0.0 \
  --server-mods ./mods
```

## 输出

`<pack>.json`（语义清单）+ `<pack>-ids.json`（实测数字 id）。这两个文件就是机器人要的全部。

清单里最关键的是 `stations`——**这个 mod 的方块各自怎么用**。只有三种机制，因为机器人
能做的交互就那么几类：

| kind | 什么意思 | 例子 |
|---|---|---|
| `two-step-use` | 先手持原料右键放上去，再手持工具右键开工，产物进包 | 农夫乐事砧板 |
| `place-and-wait` | 手持食材右键放上去，等熟成，产物弹成掉落物 | 营火 |
| `sidecar-recipe` | 服务端不给菜单，只能由侧车模组照配方代做 | 农夫乐事厨锅 |

新 mod 要的是第四种机制（现有三种套不上）时才需要动代码——那属于真正的新玩法。

## 校准为什么要自检

`/setblock` 对一个"放不住"的方块会悄悄失败，客户端读回的是上一格的残留值。实测农夫乐事
有 71 个单状态方块（各色告示牌）全被记成同一个 stateId —— 注入后它们会变成"同一个方块"，
机器人看见米捆其实是橱柜。

所以 `calibrate` 量完会用刚量到的 ids 把注册表注进当前连接，逐个放一遍读名字：

- 名字对不上 → 删掉这个方块的 id（**错了比未知更糟**）
- 作物类对不上 → 只标记 `kind: 'environmental'`，不删（它们要真种，setblock 摆不住）
- 注入后同一个 stateId 被多个方块认领 → 先到先得，后来的丢掉

自检防的是**量错**；还有一扇门是**用错**：id 随 jar 组合整体位移，服务器加一个 mod、
换一套加载顺序，上次量好的 ids 就全体过期，而且没有任何报错。所以 calibrate 会把
服务器 mods 目录的指纹（`--server-mods`）记进 ids，probe/verify 加载时对不上就拒绝；
`--resume` 复用旧数据前也先抽 3 个方块真摆一遍。

## 为什么有 `learn` 这一步

静态分析能告诉你"有哪些方块、什么配方"，但**不能**直接告诉你"这个方块是工作站、要放料
进去再取产物"。那属于玩法语义，jar 里没有原文。

**默认路径是规则推断，不需要模型**（`learn --infer`）：

| 证据 | 结论 |
|---|---|
| 自定义配方类型（`farmersdelight:cooking`） | 一定存在加工行为 |
| 配方里的显式 `tool` 字段有共同后缀（47 条配方都是 `*_knife`） | `two-step-use` |
| 方块名对得上配方类型词干（`cooking`→`cooking_pot`，不是 `stove`） | 站点方块 |
| `probe` 实测到**自定义**界面 | `sidecar-recipe`（私有菜单机器人开不了） |
| `probe` 实测确认不开窗，且类型是被动型（`drying`） | `place-and-wait` |

推断结果一律带 `needsReview: true`——机制判错下游会一直白试，所以让人扫一眼再采信。
农夫乐事实测：`cooking_pot`（侧车）+ `cutting_board`（两步，`_knife`），与手工标注一致。

**证据优先于命名**。`probe --scan-blocks` 把候选方块逐个右键一遍，记下"开不开窗、开的
什么窗"，存进 probe 输出；`learn --infer --evidence <probe.json>` 用这份实测决定机制：

```bash
modsmith probe <manifest> --pack <pack> --scan-blocks --out probe.json --host … --rcon-password …
modsmith learn <manifest> --infer --evidence probe.json
```

实测到**自定义**界面 → 必须走侧车（私有菜单原版客户端开不了）；实测确认不开窗 + 被动型
类型（`drying`）→ `place-and-wait`。没测成的方块不进证据——"未知"不等于"不开窗"。

细节：扫描会优先测**已经声明的站点**。它们的开窗行为正是决定机制的关键，跳过它们会让
扫描结果对站点判断毫无帮助（FD 实测：带不带证据结论完全一样，就是因为两个站点被跳过）。
装饰方块按名字排除（叶/原木/台阶/门…），多状态方块只扫默认态。

`learn`（不带 `--infer`）则是 LLM 路径：读清单（+ 可选 mcmod 页面）判断机制，产出
同一种结构化数据，还要过实测回炉。
**LLM 只写数据，不写代码**——机器人的技能是封闭的 TS 联合类型，运行时注册不了新技能，
让模型生成代码必然失败。所以这里的产出永远是 JSON，并且会被校验：

- 机制名必须是那三种之一
- 方块必须真的在 manifest 里
- sidecar 的命令必须带 `{recipe}` 占位符

## 工作站真的能跑吗（`verify --stations`）

光"知道哪个方块是工作站"不算完。`verify --stations` 会真的执行一遍：放材料 → 发命令
→ 等到产物进背包。农夫乐事实测：

```
✓ [station] cooking_pot：farmersdelight:cooking/pasta_with_meatballs（材料 3 种）
             → farmersdelight:pasta_with_meatballs
```

两步式站点（放料 → 换工具 → 右键）也走真实交互，不是发命令。**每一种原料各右键一次**，
不是只放第一种——FD 有 12 条 cutting 配方要 2 种以上原料，只放一种会"缺料失败"，而机器人
会以为是配方本身不对：

```
✓ [station] cutting_board（两步，4 种料）：leather_helmet + leather_chestplate
             + leather_leggings + leather_boots + shears → leather
```

`onboard` 现在是 **7 步**：inspect → calibrate → probe（含方块扫描）→ recipes →
learn（规则推断）→ verify（含站点实测）→ sidecar。`recipes` 排在 `learn`/`verify` 之前是
硬约束：jar 形状的配方里 `tool` 是对象（读不出刀后缀）、`cooking_time` 为空，先跑会把
两步式误判成侧车、站点执行也会超时。

右键用原生 `block_place` 包发（`bot.activateBlock` 对没有注册交互行为的模组方块会一直
不返回——实测卡过两分钟），带了 3 秒兜底。

侧车的熟成任务会存到 `<world>/modsmith-sidecar-jobs.json`，三种情况都验过：

- 正常熟成：产物到手
- 玩家中途断线：任务退回挂起（材料已扣，不能白吞），重连后接着计时
- 服务器重启：启动时恢复为挂起，玩家一进来就绑定继续

## 为什么有 `sidecar` 这一步

有些站点的菜单是模组私有的（农夫乐事厨锅实测七种手势都不给原版协议客户端发
`open_window`）。拿不到界面就没法用，只能在服务端替它做。

`modsmith sidecar` 产出**一个通用 Fabric 模组**（`templates/sidecar-generic` 真源码，
每个 MC 版本编译一次永久复用）加**一份站点配置 JSON**：
`config/modsmith-sidecar/<pack>.json`，模组启动时读它逐站点注册命令。
接一个新 mod 只是多一份配置，不再生成任何代码。

命令做的事只有一件：查 RecipeManager → 验料 → 扣料 → 等熟成 → 给成品。
三道安全约束：

- **权限门**：每条命令挂 `.requires(hasPermissionLevel(opLevel))`（配置项，默认 2）。
  服务器上任意玩家不能替机器人消耗材料。
- **热源检查**：站点配置声明了 `heatTag` 才启用。锅放泥地上会被拒
  （`is not heated: put a heat source ... under it`）。
- **原料匹配两层**：先按「物品 + 组件」精确比，再退回只比物品 —— 带自定义组件的原料
  不会明明在包里却报「缺料」。

`--build`（默认）会真编译一次，Gradle 从 `MODSMITH_GRADLE` 或 PATH 找。
**产物不会被自动安装**：jar 留在 `sidecars/.build/build/libs/`，配置留在
`sidecars/<pack>/config/`，装不装、装到哪台服，由人决定。

**命令只在编译成功后才写回清单。** 没编译成功的站点，清单保持原样——否则机器人会去调
一个根本不存在的命令，表现为「发出去没人应答」，几秒后才超时，比报错难查得多。
`--no-build` 默认不写回；确实要写就加 `--write-command`，它会在输出里明确警告「没验过」。

## 作物推断的边界

jar 里没有"这个方块是作物、成熟时 age 是 3"。所以走三档：

1. sidecar 覆盖（人手写的 JSON）—— 最可信
2. blockstate 的 age 值域 —— 常见情况够用
3. 名字启发式 —— 只在没有 age 属性时用

推断出来的每条都带 `_inferred` 标记。命名不规则时（`tomatoes` 的种子叫 `tomato_seeds`
不是 `tomatoes_seeds`）需要人写 sidecar。`inspect --write-sidecar` 会生成一份模板。

## LLM 配置

`learn` 走 OpenAI 兼容端点，用环境变量指定：

```
MODSMITH_BASE_URL   默认 http://127.0.0.1:8080/v1
MODSMITH_API_KEY    没设就不发 Authorization（本机服务通常不要）
MODSMITH_MODEL      默认读 /v1/models 的第一条
```

## 跟宿主项目对接

`modsmith` 只产出两个文件，任何 mineflayer 项目都能消费：

```
<pack>.json       语义清单（schema/manifest.schema.json）
<pack>-ids.json   实测数字 id
```

包名要和宿主的"当前装载的 mod"配置逐字一致。默认名是 `<mod id>-<MC 版本>-<mod 版本>`；
如果目标目录里已经有同一个 mod 的清单但名字不同，`inspect` 会直接把该用的 `--pack` 打出来。

校验用 `src/validate.mjs`（和宿主侧 `mod-manifest.ts` 同一套规则）。

## 已知局限

- **只支持 Fabric**。Forge/NeoForge 的 FML 握手是另一套协议，投入产出比差。
- 物品 id 校准靠"背包里新出现的槽位"，因为模组物品在未注入注册表时客户端眼里名字是
  `unknown`，只有数字 id 是真的。`--debug-items` 会把每一步的槽位摆出来。
  注意快照必须在 `give` **之前**取（给完再取，"新出现的槽"永远是空的——这个坑踩过一次）。
- 需要客户端渲染才能感知的机制（自定义粒子、纯视觉反馈）做不到，只能写进 `unsupported`。
- `learn` 的实测验证只能确认**右键开不开窗**这一条硬约束；它验不出"砧板到底要食材+刀
  还是食材+斧头"。这是必要条件，不是充分条件。
- 作物必须真种才能验，`setblock` 摆不住，所以它们的自检结论是"未验证"而非"通过"。

## 开发

```
npm test        # 纯函数冒烟，不连服务器
```
