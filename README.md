# modsmith

[![npm](https://img.shields.io/npm/v/modsmith)](https://www.npmjs.com/package/modsmith)
[![release](https://img.shields.io/github/v/release/xiaoxiao150/modsmith)](https://github.com/xiaoxiao150/modsmith/releases)
[![tests](https://github.com/xiaoxiao150/modsmith/actions/workflows/test.yml/badge.svg)](https://github.com/xiaoxiao150/modsmith/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/xiaoxiao150/modsmith)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**English TL;DR:** turn a Fabric mod jar into a semantic manifest (blocks,
items, recipes, tags, crops) plus **measured registry ids** that any mineflayer
bot can use. It solves Minecraft 1.21's static-registry problem: mod blocks and
items are never downloaded, their numeric ids depend on load order, and recipes
live in serializers the bot doesn't know. modsmith reads the jar, then either
dumps the server registry (seconds, bundled dump mod) or falls back to measuring
on a live server (OP + RCON), and fingerprints the result. It is the data layer
for an AI companion that actually plays modded Minecraft.

**中文一句话：**把 Fabric 模组 jar 变成机器人能读、能用的语义清单和实测数字 id；
让她看得见模组方块、做得出模组配方、放得下模组装饰。

> 它是 **AI 陪伴项目**的语义层：宿主（Cortico）是一个真玩家账号上的 AI，
> modsmith 负责把她面前的任意模组变成可读的配方/站点/id 数据。
> 方向与阶段见 [ROADMAP.md](ROADMAP.md)。

## 接包时间：3 小时 → 几秒

以前接一个大包要逐个 block state 做 `setblock` + 回读：TF 523 方块 / **17255 个状态**
要跑 1.5 小时，Supplementaries 14996 个状态要接近 1 小时。现在：

| | 逐状态 `calibrate` | `registry-dump` |
|---|---|---|
| 时间 | TF 约 1.5h，Supp 约 1h | dump + import，**秒级** |
| 需要 | 服务器 + OP + RCON + 一个裸 bot | 服务端装一个 4KB 只读 mod，重启一次 |
| 覆盖 | 清单声明的状态子集 | 服务端注册表的全部状态 |
| 风险 | 区块失新/残留读数，靠自检兜底 | 注册表真值；只读、不注册内容 |

jar 已经**内置在 modsmith 里**：`templates/registry-dump/modsmith-dump-0.1.2.jar`；
`modsmith dump-jar` 直接打印路径，`onboard` 会自动找 `config/modsmith-dump.json`。
仍然不会自动安装——装/删由人决定，因为那是改用户的服务器，不是改本地文件。

dump 不只量 id：0.1.2 起同时导出实体注册表（名字、数字 id、生成组、碰撞箱）。
没有这张表，暮色森林的 boss 在机器人眼里一律叫 `unknown`——她被娜迦打死了，
战斗日志里连对手的名字都没有。

dump 只替代 **id 测量**：`probe` / `verify` / `recipes` / `learn` 照样要跑。

## 没有它 / 有它

| | 没有 modsmith | 有 modsmith |
|---|---|---|
| 模组方块 | 客户端眼里是 `unknown`，状态 id 对不上 | 完整 id + 每个 state 的实测 id |
| 模组配方 | 服务端自定义序列化器，机器人不认识 | 文法发现 + 清单，`make`/`craft` 能用 |
| 换 jar / 加 mod | id 整体位移，旧数据静默放错方块 | 服务器指纹闸直接拒绝旧 ids |
| 装饰/站点 | 不知道能不能放、怎么贴、开不开窗 | `probe`/`verify` 实测；宿主工具按结果执行 |

## 给谁用

- **mineflayer / JS bot 开发者**：不想再手写模组方块表和 id 偏移；
- **AI agent / LLM 陪伴项目**：需要让 agent 真正调用模组配方和方块，而不是只会聊天；
- **Fabric 整合包 / 服务器维护者**：想给自动化/机器人一条可复现的接包路径。

## 30 秒看到结果

不需要服务器；`inspect` 只读 jar。已发布到 npm：

```bash
npm i -g modsmith          # 或者零安装：npx modsmith ...
modsmith inspect path/to/mod.jar --out ./mods
```

不想装 npm 包也可以直接跑仓库：

```bash
git clone --depth 1 https://github.com/xiaoxiao150/modsmith
node modsmith/bin/modsmith.mjs inspect path/to/mod.jar --out ./mods
```

输出是 `mods/<pack>.json`：方块、物品、配方类型、tag、作物都在里面。要让它变成
机器人真能用的数字 id，再按 [快速开始](#快速开始) 起一台自己的服务器跑 `calibrate`。

## 支持的包（实测，不是“理论上”）

| 包 | MC / 依赖 | 覆盖 | 备注 |
|---|---|---|---|
| Farmer's Delight 3.3.6 | 1.21.1 / Fabric API | 131/131 方块、185/185 物品、1594 条可用配方 | 生产在用；站点 `cutting_board`/`cooking_pot` 已验证 |
| More Delight 26.04.30 | 1.21.1 / FD | 0 方块、37/38 物品、51 条配方 | 农夫乐事扩展；纯物品/配方 |
| Supplementaries 4.0.2 | 1.21.1 / Moonlight 3.7.2 | 237/237 方块、248/248 物品、306 条可用配方 | 装饰验收：两间 5×5 房间、25 件装饰 |
| Twilight Forest 4.8.796 | 1.21.1 / Fabric API | 523/523 方块、660/718 物品、540 条配方、17255 状态 | 生产在用；9 个 boss 与实体名已进清单，维度传送待验 |

缺失的方块/物品不是“漏了”，是服务器没注册的兼容/技术变体；清单按实测裁剪，
不会把装不出来的东西列给机器人。

**预生成参考包（0.6.2，FD + Supplementaries）**：[modsmith-0.6.2-reference-packs.zip](https://github.com/xiaoxiao150/modsmith/releases/download/v0.6.2/modsmith-0.6.2-reference-packs.zip)
（两份 manifest + 对应 ids + 精确 mod 列表）。manifest 可直接复用；`-ids.json`
带服务器指纹，只对压缩包内 `SERVER-MODS.md` 那套完全相同的 mod 组合有效——
换了 jar 请重新 dump/calibrate，不要混用。

## 状态（0.7.1，AI 陪伴：生活 / 装饰 / 冒险）

> 发布说明：npm registry 上的最新包仍是 **0.6.2**；0.7.1 目前以本仓库 / GitHub
> release 为准（npm 发布账号还在安全暂停期）。不想等可以 `git clone` 后直接跑
> `node bin/modsmith.mjs`。

- **0.7.1（live 采样与形状索引修正）**：`conformance --live` 增加 RCON 写世界采样
  （setblock 后等真实 `stateId` 再读 `shapes`，含上下两态对照），dev 服 FD 实测
  40/9/0，报告在 [docs/conformance](docs/conformance/README.md)。采样抓出并修复
  `templateShapeId` 的 P0：状态索引应按**最后一个属性最快**变化，原实现反了，导致
  台阶 top/bottom 形状互换（楼梯同理）；`block-shapes.test.mjs` 已钉住。
  `onboard` 支持 `--serializers` 显式指 sidesheet；RCON socket 现在会 `close()`，
  `onboard` 九步跑完后进程不再挂住。`verify` 对没有写回命令的侧车站点显式报
  “已知但未验”（不再是失败）；推断阶段也不再生成侧车命令，命令只由编译成功的
  `sidecar` 写回。
- **0.7.0（接包验收）**：新增 `modsmith conformance`（manifest/ids/registry 三层离线
  检查）与只读 `--live` 参考消费；`onboard` 9 步里有两道早停。四包实测 0 fail，
  报告在 [docs/conformance](docs/conformance/README.md)。碰撞/作物/实体规则收敛到
  `block-shapes.mjs` 一份；TF 241 个假空气方块、`diggable` 绑 `solid`、番茄长苗
  alias 都有回归。
- **0.6.4（实体与 boss 可读）**：registry-dump 0.1.2 导出 `ENTITY_TYPE`（id/生成组/
  碰撞箱），`import-dump` 写进 `<pack>-ids.json` 的 `entities`；`inspect` 从
  `tags/entity_type/bosses.json` 读 boss 名单并带上实体中英文名。宿主因此能把
  `unknown` 叫成「娜迦（twilightforest:naga）」并按 `monster` 组判敌对。
  战术仍由她现场决定，清单只给事实。
- **registry-dump 快路径（主线，随包内置）**：接包从逐状态数小时降到秒级；
  `onboard` 自动优先用它，`calibrate` 只在没有服务器文件权限时作为退路。
  dump jar 不自动安装，装/删由人决定。

**数据层（本仓库）**

- **已实测接入的包**：Farmer's Delight 3.3.6（131 方块 / 185 物品 / 1594 条可用配方）、
  Supplementaries 4.0.2 + Moonlight 3.7.2（237/271 方块、248/297 物品、306 条可用配方）。
  后者的 34 个缺失方块是服务器未注册的兼容/技术方块（cupric/ender/soul 变体等），
  清单已按实测裁剪，不会把装不出来的东西列给机器人。
- **多包共存**：捕获的配方是整服快照，`recipes --ids-all` 合并各包 ids（指纹闸拒绝
  混用不同 jar 组合的量测）；宿主按配方 id 跨包去重、累积安装。
- **配方发现**：自定义序列化器不用 javap——`recipes --discover` 用配方名切段找文法，
  歧义全部列出、待审文件永不自动生效；暮色森林 4.8.629 实测 2134 条全解析。
- **inspect 契约修复（0.6.2）**：自定义序列化器把 `result` 写成字符串时统一收成
  `{id,count}`；原版 tag 可从服务器 jar 的 `data/minecraft/tags/` 展开并入
  `candidates`（`minecraft:wooden_slabs` 等），原版 tag 配方才装得进配方表。
- **L2/L3 能力保持**：`onboard` 九步（含两道 conformance 早停）、`learn --infer`（默认合并人工站点、整段重推要
  `--force`）、`verify --stations` 三种机制真执行、侧车熟成可跨重启、`probe --scan-blocks`
  全量窗口扫描。

**宿主层（Cortico，不在本仓库）**

- **P1 生活**：`mc_plan`（查步骤/缺料/现在能做的菜）、`mc_chest`（记得的容器）、
  饥饿事实事件（叫醒她，不替她决定）、`command`（真玩家级 OP，含 tp，命令审计）、
  `look`（看人/看坐标/抬头看天）；真机验收通过，她自己查料、决定吃/做/不做。
- **P2 装饰**：`mc_modblocks`（按关键词查包内方块/物品）、`mc_scan`（房间实况：
  方块计数/可站格/门）、`place.face`（壁挂装饰）。真机验收：她在两间不同材质的
  5×5 房间里自己扫房、选材、贴出 **25 件装饰 + 两条横梁 + 两个遮阳篷**，并把
  暖/冷两套风格写进笔记。
- **P3 冒险**：TF 4.8.796 已接入生产服（523 方块 / 540 条配方 / 9 个 boss）。
  实体名与 boss 标记已进清单，`mc_entities` 能报"是谁、多远、是否敌对"；剩下的是
  维度传送与战利品表读取。
- 完整阶段与依赖见 [ROADMAP.md](ROADMAP.md)。

**兼容性说明**

- 0.x 期间 manifest / sidesheet 格式可能发生破坏性变更，会尽量在 README 里标注。

## 前置条件

calibrate / probe / verify 是在**你自己的服务器上动手**：`forceload`、`setblock`、
`give`、`tp`、`clear` 每一条都要 OP，RCON 必须开着。它们没法指向别人的服务器——
没有 OP 就是每条命令静默失败。支持范围也只有 Fabric（Forge/NeoForge 的 FML 握手
是另一套协议，投入产出比差）。

## 最快接包：注册表 dump（秒级，替代逐状态校准）

`templates/registry-dump` 是一个只读的服务端 Fabric mod：启动后把服务端真实注册表写成
`config/modsmith-dump.json`，**不注册任何方块/物品**。jar 已随包内置
（`templates/registry-dump/modsmith-dump-0.1.2.jar`，4.6KB），运行 `modsmith dump-jar`
可直接打印它的绝对路径；也可从
[Release](https://github.com/xiaoxiao150/modsmith/releases/tag/registry-dump-v0.1.2) 下载。

装一次 → 启动 → 拿 dump → 停服删 jar：

```bash
modsmith import-dump config/modsmith-dump.json \
  --manifest mods/<pack>.json --ids mods/<pack>-ids.json \
  --server-mods mods
```

`import-dump` 只保留清单声明的方块/物品，并收下这个命名空间的全部实体；剔除 vanilla
区间（方块 stateId 与原版实体 id 0–129）与重复 stateId。TF 这种 523 方块 / 17255 状态
的大包，从“逐状态 setblock 约 1.5 小时”变成秒级。

## 接包验收（conformance）

接包不再靠“陪玩一晚看崩不崩”。清单和 ids 一落地就跑一次离线验收：

```bash
modsmith conformance mods/<pack>.json \
  --ids mods/<pack>-ids.json --server-mods mods
```

三层检查：

- **manifest**：solid 必须有 box 或可映射形状、作物 alias 必须指向可收获阶段（不会把长苗当熟果）、配方 result/candidate 可解析；
- **ids**：stateId 在原版区间外、无跨方块重复/重叠、item/entity id 在各自原版上限外、服务器指纹对得上；
- **registry**：注入真实 prismarine 注册表后，每个 state 真的有 shape、楼梯上半/下半不同、作物 `diggable:true`、boss 真的进实体表、配方视图能消费。

`onboard` 会自动跑这一步，失败就停在 probe/sidecar 之前；报告落在
`mods/<pack>-conformance.json`。当前四个生产包离线检查都是 **0 fail**（警告是自定义
序列化器/开门状态等已解释项）。

要在一台真实服务器上只读验证一遍，加 `--live`：

```bash
modsmith conformance mods/<pack>.json --ids mods/<pack>-ids.json \
  --server-mods mods --live --host 127.0.0.1 --port 25565
```

它会起一个临时 mineflayer bot（默认 `ModConform`），在 `inject_allowed` 前注入，
检查方块形状/实体/boss 后退出；**不 setblock、不召唤、不聊天**，可以指向生产服。
最小独立示例见 [`templates/reference-bot`](templates/reference-bot/README.md)。

## 四步

先装：`npm i -g modsmith`（或每条命令前加 `npx`）。

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

一条龙（九步按序串好，失败即停，`--resume` 断点续跑）：

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

三种站点都实测过：

| 机制 | 怎么验的 |
|---|---|
| `sidecar-recipe` | 放材料 → 发命令 → 等产物进包（厨锅） |
| `two-step-use` | 放料 → 换工具 → 右键 → 等产物（砧板，多原料逐个放） |
| `place-and-wait` | 放料 → 等 → 产物**掉落物**出现（营火；按数字 id 认实体） |

`verify --stations` **不静默跳过**：缺 `recipeType` 的、机制还没执行器的，都会显式报
“已知但未验”，而不是从报告里消失。

`onboard` 现在是 **9 步**：inspect → conformance-manifest → calibrate/import-dump →
conformance（ids+registry）→ probe（含方块扫描）→ recipes → learn（规则推断）→
verify（含站点实测）→ sidecar。`recipes` 排在 `learn`/`verify` 之前是
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

### 把侧车装到服务器（人来做）

1. `sidecars/.build/build/libs/modsmith-sidecar-<ver>.jar` → 服务器 `mods/`
2. `sidecars/<pack>/config/modsmith-sidecar/<pack>.json` → 服务器 `config/modsmith-sidecar/`
3. 重启服务器；进游戏执行 `/<command> list`，能列出配方就是通了
4. 先在临时服验一遍再上生产——侧车会真的查配方、扣料、出货

侧车**不会**被 `modsmith` 自动安装到任何服务器；装上去等于让服务端执行新代码，必须人拍板。
服务器重启/区块卸载前没熟完的批次会丢（熟成队列在内存里，见
`templates/sidecar-generic/README.md`）。

## 换了 mod / 加了 mod 之后（ids 重跑）

数字 id 是**服务端注册顺序**的产物：随便加一个 jar，已有模组的方块/物品 id 都会整体位移。
所以「换 mod」不是重跑那一个包，而是这台服务器上**每个包**都要重来一遍：

```bash
# 1) 每个包按当前 mods 目录重新量（先停服再起一个干净的开发服）
modsmith calibrate mods/<packA>.json --out mods/<packA>-ids.json --server-mods <server>/mods ...
modsmith calibrate mods/<packB>.json --out mods/<packB>-ids.json --server-mods <server>/mods ...

# 2) 配方翻译要能看到整台服务器的物品（捕获的是整服配方）
modsmith recipes mods/<packA>.json --ids-all mods --write
modsmith recipes mods/<packB>.json --ids-all mods --write

# 3) 站点与验收
modsmith learn mods/<packA>.json --infer --evidence mods/<packA>-probe.json
modsmith verify mods/<packA>.json --stations ...
```

`--ids-all` 自带指纹闸：各份 ids 的 `serverMods.fingerprint` 不一致（= 不是在同一套 jar
组合下量的）会直接拒绝，不会把整体位移的 id 合进去。宿主加载时也会按指纹拒绝过期 ids。

**一个服务器上装多个包时**，每份清单都是对整服配方的快照（会有重叠）。宿主按配方 id
去重、累积多个包，不会重复挂同一配方；但这也意味着**只重跑一个包的 ids 不够**——
指纹对不上，另一个包会被宿主拒绝加载。

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
MODSMITH_MAX_TOKENS 回复上限，默认 8000
MODSMITH_REASONING_EFFORT  可选 low/high/max（端点不认就忽略）
```

**推理模型要把预算留够**：DeepSeek `deepseek-flash` 实测在 `max_tokens=2000` 时把额度
全花在思考上，正文是空的（错误信息会直接这么说）。默认 8000 够用；想省时间可以设
`MODSMITH_REASONING_EFFORT=low`。

模型产出的站点一律标 `inferred: true` / `needsReview: true`：它不是人核对过的。
已有非推断站点（人核对过命令）时，模型对**同一方块**的建议不会被采纳，只能补新方块；
确实要覆盖得加 `--force`。侧车编译成功后可以覆盖推断站点的命令——但人工命令永远保留。

## 跟宿主项目对接

`modsmith` 只产出两个文件，任何 mineflayer 项目都能消费：

```
<pack>.json       语义清单（schema/manifest.schema.json）
<pack>-ids.json   实测数字 id
```

包名要和宿主的"当前装载的 mod"配置逐字一致。默认名是 `<mod id>-<MC 版本>-<mod 版本>`；
如果目标目录里已经有同一个 mod 的清单但名字不同，`inspect` 会直接把该用的 `--pack` 打出来。

校验用 `src/validate.mjs`（和宿主侧 `mod-manifest.ts` 同一套规则）。

契约之外的**动作**由宿主实现：怎么查配方（`mc_plan`）、怎么记箱子（`mc_chest`）、
怎么扫房间（`mc_scan`）、怎么查包内装饰（`mc_modblocks`）、怎么贴墙（`place.face`）、
怎么用 OP 命令（`command`）——都不是 modsmith 的职责；这里只保证数据是真的。

## 已知局限

- **只支持 Fabric**。Forge/NeoForge 的 FML 握手是另一套协议，投入产出比差。
- 物品 id 校准靠"背包里新出现的槽位"，因为模组物品在未注入注册表时客户端眼里名字是
  `unknown`，只有数字 id 是真的。`--debug-items` 会把每一步的槽位摆出来。
  注意快照必须在 `give` **之前**取（给完再取，"新出现的槽"永远是空的——这个坑踩过一次）。
- 需要客户端渲染才能感知的机制（自定义粒子、纯视觉反馈）做不到，只能写进 `unsupported`。
- `learn` 的实测验证只能确认**右键开不开窗**这一条硬约束；它验不出"砧板到底要食材+刀
  还是食材+斧头"。这是必要条件，不是充分条件。
- 作物必须真种才能验，`setblock` 摆不住，所以它们的自检结论是"未验证"而非"通过"。
- **流体 / 能量 / 多槽 GUI 类配方不在支持范围**。例子：Brewin' And Chewin' 的 keg 配方
  用流体栈（`base_fluid`、`result.amount`），文法发现的形状库里没有流体字段，会明确拒绝：
  "名字锚点完整，是某个自定义类型的文法吃不下它的 payload（形状库不支持的字段）"。
  这类站点即使解析出来，机器人也没有执行手段（侧车只做"查配方→验料→扣料→等熟成→给成品"），
  所以不写进清单才是对的。
- 有些方块是为特定上下文注册的（饮料/果冻那类"要放在杯垫/架子上"的方块），
  `setblock` 摆下去会立刻变回空气。`probe`/`calibrate` 会如实记"放不下"，
  不会把它们混进可放置方块或容器表。
- **清单不等于 jar 的静态资源列表**：未在服务器注册的兼容/技术方块（Supplementaries
  的 cupric/ender/soul 变体、mob_jar 模型等 34 个）会被实测裁掉；不在清单里的东西，
  机器人就是当它不存在。
- **壁挂/多部分方块的摆放是宿主能力**：清单告诉你 id 与状态，但"贴在支撑块哪一面"
  要靠宿主的 `place.face` 之类工具；没有这个能力时，装饰只能放地上。

## 开发

```
npm test        # 纯函数冒烟，不连服务器
```
