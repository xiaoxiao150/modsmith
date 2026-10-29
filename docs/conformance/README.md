# conformance 报告 · 2026-10-29

四个生产包在 `modsmith conformance` 下的离线体检结果（`--server-mods` 对上了同一份服务器指纹）。
报告是当时的机器产物，JSON 里每条都有 `id / level / subject / message`。

| 包 | 通过 | 警告 | 失败 | 警告说明 |
|---|---:|---:|---:|---|
| Farmer's Delight 3.3.6 | 31 | 2 | 0 | 自定义配方类型（无统一 result） |
| More Delight | 4 | 2 | 0 | manifest 没写 prompt；自定义配方 |
| Supplementaries 4.0.2 | 16 | 20 | 0 | 自定义序列化器（2 条作物 alias 的 seed 指向自名） |
| Twilight Forest 4.8.796 | 38 | 13 | 0 | travellers gear / scepter / uncrafting 等自定义配方；manifest 没写 prompt |

**这些警告不是失败**：`craftRecipeViews` 只消费 shaped/shapeless 等标准形状；自定义
序列化器由 sidesheet/discover 管线处理，不会伪装成“能做”。真正会让机器人做错事的
项（假空气、楼梯形状、作物可挖、实体/boss）都是 0 fail。

复跑：

```bash
modsmith conformance mods/<pack>.json --ids mods/<pack>-ids.json \
  --server-mods mods --json docs/conformance/<pack>.json
```

只读 live 复核（需要服务器，不写世界）：

```bash
modsmith conformance mods/twilightforest-1.21.1-4.8.796.json \
  --ids mods/twilightforest-1.21.1-4.8.796-ids.json \
  --server-mods mods --live
```

2026-10-29 实跑结果：`通过 73，警告 13，失败 0`；`ModConform @ 1.21.1 overworld`，
注册表 523 方块 / 80 实体。

### 写世界采样（RCON，仅测试服）

`--rcon-password` 给了才启用：在 `--x/--y/--z` 附近 forceload、setblock、tp，读真实
bot 的 `blockAt().shapes`，再还原空气。它补的是离线注入检查看不到的那一层——
“注册表里形状非空”不等于“客户端真的按这个状态显示”。

```bash
modsmith conformance mods/<pack>.json --ids mods/<pack>-ids.json \
  --server-mods mods --live --port 25566 \
  --rcon-port 25576 --rcon-password <pw> --x 400 --y 100 --z 400
```

dev 服（FD 3.3.6，2026-10-29）实跑：`通过 40，警告 9，失败 0`，报告见
[farmers-delight-dev-live.json](farmers-delight-dev-live.json)。采样覆盖 7 个整块 +
1 个实体（FD 没有楼梯/台阶）。

同一套采样在 Supplementaries dev 包上验证了上下两态（报告未归档，因为该包没有走
完整 onboard，未注册方块会正常报 R1 fail）：

- `ash_bricks_stairs`：stairs bottom / top 各 `shape 2`，两态形状不同
- `ash_bricks_slab`：slab bottom / top 各 `shape 1`，两态形状不同
- 采样会先等 `blockAt().stateId` 进入 `ids` 里对应 `half` / `type` 的集合再读 shape；
  只等固定 250ms 会把上一态读成当前态，误报“上下相同”

这次采样抓到一个真实的 P0：`templateShapeId` 把状态索引算成了“第一个属性最快变化”，
而 registry 实际是**最后一个属性最快**。结果 `oak_slab` 的 top 拿到下半砖形状、bottom
拿到上半砖形状（楼梯同理），且 shape 非空，所有只查非空的检查都放过了。已修复并有
`test/block-shapes.test.mjs` 的索引顺序回归。