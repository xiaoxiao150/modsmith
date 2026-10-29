# AGENTS.md —— modsmith

把 Fabric mod jar 转成"任何 mineflayer 机器人能用"的语义清单。
[README.md](README.md) 讲怎么用；这份讲**改代码时要守什么**。

## 四条不能破的约束

1. **LLM 只写数据，不写代码。**
   宿主机器人的技能集合是封闭的 TS 联合类型，运行时注册不了新技能 —— 让模型生成技能代码
   必然失败。`learn` 的产出永远是 JSON，且必须过 `validateLearned`（机制名限定三种、
   方块必须在清单里、sidecar 命令必须带 `{recipe}`）。

2. **清单里的 `command` 只能指向"编译成功过"的模组。**
   `sidecar` 先编译后写回；编译部分失败时一条都不写；`--no-build` 默认不写，
   要写必须显式 `--write-command` 并且会警告。
   违反这条的后果是**静默失败**：机器人发出命令、没人应答、几秒后才超时。
   回归测试：`test/sidecar-cli.test.mjs`。

3. **错名比未知更糟。**
   - `calibrate` 自检对不上就删（作物例外：它们要真种，标 `environmental` 不删）
   - 跨方块重复的 stateId 一律去重：真实放置量到的先认领，其余先声明者得
   - ids 必须带服务器 mods 指纹（`--server-mods`），加载时对不上就拒绝——自检防的是
     量错，指纹防的是"换了服务器/换过 jar 还拿旧 ids 用"（id 随 jar 组合整体位移）
   - 自检剔除超过一成，是**测量环境坏了**（区块失新、cell 残留），不是数据坏了：
     中止不写盘，宁原样保留，别把好数据削掉
   - mod 方块的状态 id **必然大于 vanilla 上限**（注册顺序）。落在 vanilla 区间里的
     stateId 只可能是残留读数，一律剔除、整块只剩这种 id 就整块丢——这条不变量不需要
     连服务器，`--no-selfcheck` 也绕不过（TF 实测：绕过自检落盘的一批 ids 里
     1812/2779 条是 vanilla 方块，`canopy_chest` 记成了苔石楼梯）
   - `probe` 只按实测回写容器表；"没测成"不等于"不能用"，保留原判
   - 站点声明与实测矛盾时只标 `needsReview`，**不改 kind**（那是 learn 的活）
   - `recipes --discover` 的文法发现产物**永不自动生效**：只写
     `sidesheets/<pack>.serializers.discovered.json`（`_confirmed:false`），人核对后抄进
     正式 sidesheet 并补 name 才生效；多个文法都能对齐就全部列出（歧义不擅断），
     纯 varint 的退化文法要标注可疑——它对任何字节都凑得齐
   - discover 走「配方名切段」：名字清单（manifest 的配方 id + `--server-mods` 的 jar +
     原版 jar）给出每条 payload 的精确起止。清单不能覆盖整包时（数据包跨命名空间加
     配方），先找"对上每一次出现"的严格文法，没有就退到"对得最多"的弱候选，再由**整包
     解析**裁决、在失败位置换备选——绝不用长垃圾文法硬跨段。线上同形的备选（i32/f32、
     ingredient/list[slot]）必须一起列出，语义由人对配方 JSON 拍板
   - `recipes` 遇到未知序列化器时自动跑一次 discover 并打印待审表（`onboard` 因此不会
     硬失败）；产物仍只在 `--write` 时落成 `_confirmed:false` 的待审文件
   - 站点推断（`learn --infer`）一律 `needsReview: true`：机制判错机器人会一直白试。
     规则顺序不许反——**配方类型的词干优先于别名**（cooking→cooking_pot，不是 stove），
     **工具只认显式 `tool` 字段**（从 ingredients 里找会把蘑菇家族当工具），
     **实测到自定义界面就必须走侧车**（私有菜单原版客户端开不了）
   - 扫描候选**必须包含已声明的站点**：它们的开窗行为正是决定机制的证据；跳过它们，
     扫描结果对站点判断毫无价值（FD 实测：带不带证据结论一模一样）。没测成的方块
     不进证据——"未知"不等于"不开窗"
   - `verify --stations` 不许静默跳过任何站点：缺 `recipeType`、机制没有执行器的，
     都要显式报"已知但未验"。三种机制都真执行（侧车发命令、两步右键、被动等掉落物）

4. **绝不自动安装生成的模组。**
   通用侧车 jar 留在 `sidecars/.build/build/libs/`、站点配置留在 `sidecars/<pack>/config/`，
   装不装由人决定。`sidecar` 只产出配置与编译产物，**不生成站点专属代码**
   （通用模组读配置，`templates/sidecar-generic`）。

## 改代码时的习惯

- 能写成纯函数的就写成纯函数（`manifest-probe` / `validate` / `crops` / `tag-fallback` /
  `manifest-io` / `calibrate-core` / `server-fingerprint` / `recipes` / `recipes-join` /
  `cortico-bridge` 的注入实现），测试覆盖它们；只有必须连服务器的（`calibrate` /
  `probe` / `verify` / `sidecar --build` / `recipes` 的捕获）才写 CLI 集成测试。
- 清单/ids 改完先跑 `modsmith conformance`；`onboard` 已在 inspect 后和 ids 后自动跑，
  fail 就停在 probe/sidecar 之前。碰撞/作物/实体规则只留在 `block-shapes.mjs` 一份。
- **测试不许依赖本机路径**：用 `test/fixtures/tiny-mod.jar`（2.8KB 合成夹具，覆盖了
  单数/复数资源目录、tag 展开、作物推断、旧版 loot_tables）。
- 每个真实事故都在 `test/` 里留一条回归。已经钉住的有：
  - `sidecar --no-build` 不许改清单
  - `inspect` 给了 `--pack` 不许提示"已有同名 mod"（会指回自己刚写的）
  - 去重与嫌疑判据的形状（`test/calibrate-core.test.mjs`：块内重复、放置 id 优先认领）
- 判据写进日志/回执里时要能对上：报告的数字必须是**实际用到的那个数**
  （例如状态数按去重后累加，不按测量条数）。
- **多包共用一个服务器时**：捕获的 `declare_recipes` 是整服快照，每份清单都会含别的包
  的配方；`recipes` 要用 `--ids-all`（各份 ids 指纹必须一致，否则拒绝——id 整体位移）。
  换/加 jar 后所有包都要 `calibrate --fresh`，只重测一个包不够。
- **"没有"不等于"失败"**：纯物品/食物包（0 方块）推不出站点、没有空方块校验，是正确
  结果；只有清单里有方块却推不出来才报错。两次真事故都是把"没有"当成了失败，把
  onboard 卡死在一个永远过不去的步骤上。

## 与宿主的边界

modsmith **不 import 宿主的代码**（`src/cortico-bridge.mjs` 是自带的精简注入实现）。
理由是它要能独立发出去。清单格式（`schema/manifest.schema.json` + `src/validate.mjs`）
就是两边唯一的契约。
