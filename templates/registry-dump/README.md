# modsmith registry dump

A tiny Fabric **server-side** mod that writes the server's real registry to
`config/modsmith-dump.json` right after startup:

```json
{
  "blocks": { "supplementaries:ash": [{ "props": { "layers": "1" }, "stateId": 63586 }] },
  "items":  { "supplementaries:ash": 2437 }
}
```

It registers **no blocks or items**, so it does not change the registry. Install
it once, start the server, take the dump, stop the server and **remove the jar**
before running the host. Then:

```bash
modsmith import-dump config/modsmith-dump.json \
  --manifest mods/<pack>.json \
  --ids mods/<pack>-ids.json \
  --server-mods mods
```

This replaces the hours-long `calibrate` (`setblock` per state) with a seconds-long
registry read. `import-dump` still filters: only manifest blocks/items, state ids
below the vanilla ceiling and duplicate state ids are rejected.

## Build

```bash
cd templates/registry-dump
gradle build        # Java 21, Gradle 8.x
# jar: build/libs/modsmith-dump-0.1.0.jar
```

Copy the jar into the server's `mods/`, restart, then check the log for
`wrote registry dump to .../config/modsmith-dump.json`.
