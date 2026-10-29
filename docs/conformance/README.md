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