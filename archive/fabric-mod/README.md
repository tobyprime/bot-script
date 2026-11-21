# fabric-mod（已归档，暂停维护）

> 2026-11-21 归档。Minecraft Java mod 宿主**不再随引擎构建/发布**；引擎当前只维护
> mineflayer（Node）宿主。源码保留在这里，便于日后重启时有完整基线。

- 不进 CI：`.github/workflows/ci.yml` 不再构建本目录；
- 不发布 jar：`.github/workflows/release.yml` 只创建引擎源码 Release；
- 不参与 codegen：`tools/codegen.mjs` 不再生成 `AbiOps.java` / `HttpRoutes.java`；
- 代码可能与当前 ABI v2.1 / 可选库（`bslib` / `container_lib`）不一致，重启前需要重新对齐
  `contracts/host-abi.yaml`、Lua 运行时加载路径与测试向量。

历史入口：`gradlew build`（需要 JDK 21；原构建会把 `../runtime/lua` 与 `../contracts/data`
拷入 `src/main/resources`）。
