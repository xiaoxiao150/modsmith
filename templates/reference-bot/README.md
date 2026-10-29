# reference-bot

最小的参考消费者：**不依赖 Cortico**，只证明一份 `manifest + ids` 能被普通
mineflayer 机器人消费。

```bash
npm i modsmith mineflayer
node index.mjs \
  --host 127.0.0.1 --port 25565 \
  --manifest ../../mods/<pack>.json \
  --ids ../../mods/<pack>-ids.json \
  --username ModReference
```

它做三件事：

1. 在 `inject_allowed` 之前把 manifest + ids 注入 `bot.registry`；
2. 丢掉只读验证不需要的大包（`declare_recipes` / `declare_commands` / `entity_metadata`）；
3. 打印方块 state 数、实体显示名与 boss 标记，然后退出。

它不 setblock、不召唤、不聊天，所以可以安全地指向生产服做一次只读验收。
需要写世界抽样的完整 live 验收见仓库里的 `modsmith conformance --live`。