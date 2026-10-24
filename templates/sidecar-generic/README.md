# modsmith sidecar（通用）

一个 Fabric 服务端模组，读 `config/modsmith-sidecar/<pack>.json` 注册「代做」命令。
`modsmith sidecar` 把站点配置生成到 `sidecars/<pack>/config/modsmith-sidecar/`，并把本
目录按 MC 版本工具链编译一次；接新 mod 不再产出代码，只是多一份配置。

## 命令

每站点注册三条（`<command>` 来自配置）：

- `<command> cook <recipe>` —— 查 RecipeManager → 验料 → 扣料 → 等熟成 → 给成品
- `<command> list` —— 列出这个站点能做的配方（id）
- `<command> status` —— 报最近一个站点方块的位置

## 配置形状

```json
{
  "pack": "farmers-delight-1.21.1-3.3.6",
  "stations": [
    {
      "id": "cooking_pot",
      "label": "厨锅",
      "command": "cooking_pot",
      "block": "farmersdelight:cooking_pot",
      "recipeType": "farmersdelight:cooking",
      "cookTime": 200,
      "opLevel": 2,
      "heatTag": "farmersdelight:heat_sources"
    }
  ]
}
```

`heatTag` 可选：声明了才启用热源检查（站点下方一格在 tag 里、或自带 LIT 且为真）。
`cookTime` 是反射读不到配方自带熟成时间时的兜底值。配置在 mod 加载时读一次，改了要重启。

## 编译

```
gradle build        # 版本参数在 gradle.properties；modsmith 按 --mc-version 填好
```

产物在 `build/libs/modsmith-sidecar-<version>.jar`。装不装进哪台服务器由人决定。
