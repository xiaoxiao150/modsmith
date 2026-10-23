# modsmith

把 Fabric 模组 jar 变成**任何 mineflayer 机器人能用的语义清单**。

Minecraft 机器人是原版协议客户端。它看不见模组方块、拿不到模组配方、也开不出模组界面——
因为 1.21 起方块和物品是**静态注册表**，服务端从不下发，模组追加到哪个数字 id 取决于加载
顺序。`modsmith` 把这一切补齐，并尽量让"接一个新 mod"变成几条命令。

## 四步

```
modsmith inspect  <mod.jar>           静态提取：方块/物品/配方/tag/中文名 + 推断作物
modsmith calibrate <manifest.json>    连服务器量数字 id（/setblock + /give）
modsmith probe    <manifest.json>     实测哪些容器/站点真能用
modsmith verify   <manifest.json>     冒烟：方块认得、物品能拿、配方能合
```

可选两层（要 LLM）：

```
modsmith learn    <manifest.json>     LLM 读清单 + wiki，产出站点定义与玩法说明
modsmith sidecar  <manifest.json>     给"服务端不开菜单"的站点生成侧车模组
```

## 快速开始

```bash
# 1) 看一眼这个 jar 里有什么（不需要服务器，不调 LLM）
modsmith inspect ./mods/SomeMod.jar --out ./out

# 2) 装好这个 mod 的服务器起来之后，量数字 id
modsmith calibrate ./out/somemod-1.0.0.json \
  --port 25565 --rcon-password yourpw

# 3) 实测容器（名字像容器不等于能用——`*_crate` 名字最像，实测打不开）
modsmith probe ./out/somemod-1.0.0.json --pack somemod-1.0.0

# 4) 冒烟
modsmith verify ./out/somemod-1.0.0.json --pack somemod-1.0.0
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

## 为什么有 `learn` 这一步

静态分析能告诉你"有哪些方块、什么配方"，但**不能**告诉你"这个方块是工作站、要放料进去再
取产物"。那属于玩法语义，jar 里没有。

`learn` 让 LLM 读清单（+ 可选 mcmod 页面）判断每个站点属于哪种机制，产出结构化数据。
**LLM 只写数据，不写代码**——机器人的技能是封闭的 TS 联合类型，运行时注册不了新技能，
让模型生成代码必然失败。所以这里的产出永远是 JSON，并且会被校验：

- 机制名必须是那三种之一
- 方块必须真的在 manifest 里
- sidecar 的命令必须带 `{recipe}` 占位符

## 为什么有 `sidecar` 这一步

有些站点的菜单是模组私有的（农夫乐事厨锅实测七种手势都不给原版协议客户端发
`open_window`）。拿不到界面就没法用，只能在服务端替它做。

`modsmith sidecar` 生成一个最小 Fabric 模组：查 RecipeManager → 验料 → 扣料 → 等熟成 →
给成品。它**只做这一件事**，不碰文件、网络、别的方块。

三道安全约束（生成时就写进源码）：

- **权限门**：命令挂 `.requires(hasPermissionLevel(N))`，`--op-level` 默认 2。
  服务器上任意玩家不能替机器人消耗材料。
- **热源检查**：站点声明了 `heatTag` 才生成。锅放泥地上会被拒
  （`is not heated: put a heat source ... under it`）。
- **原料匹配两层**：先按"物品 + 组件"精确比，再退回只比物品 —— 带自定义组件的原料
  不会明明在包里却报"缺料"。

生成后会**真编译一次**（`--no-build` 可跳过），Gradle 从 `MODSMITH_GRADLE` 或 PATH 找。
**生成的模组不会被自动安装**，编译产物留在 `sidecars/<mod>/build/libs/`。

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

校验用 `src/validate.mjs`（和 Cortico 的 `mod-manifest.ts` 同一套规则）。

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
