# DESIGN.md — dsh-artifact-index

> 一个为 DSH Web GUI 提供 **artifact 索引与预览端点** 的插件，把 `dsh-artifacts`
> 侧栏标签页所需的那层「宿主端服务」补齐。
>
> 状态：已实现并发布（v0.1.0）｜ 日期：2026-09-11

---

## 1. 背景与问题

`lucagiftzek/dsh-artifacts` 是一个**纯查看器**插件：它在 DSH 侧栏注册一个
「Artifacts」标签页，列出 agent 产出的文件并内嵌预览。

但它的宿主半边是**故意的空实现**（见其 `lib/index.js` 注释），所有数据通过 HTTP
从一个**外部索引端点**获取。其 README 原话：

> DSH does not define an artifact directory or an index route itself,
> **so this is the one requirement you must supply**

当前该端点为 `/report/?list=1`，DSH 没有任何东西提供它 → 侧栏显示
`Could not read the artifact index. HTTP 404`。

**本项目的目标就是补上这一层。**

### 已确认的现状（本机实测）

| 项 | 值 |
|---|---|
| DSH 版本 | `0.1.5-rc.1`（DSH Desktop 2.0.9） |
| `$DSH_HOME` | DSH 数据目录（Windows 下可用 `echo $env:DSH_HOME` 查看） |
| profile | `desktop` |
| `dsh-artifacts` | `github:lucagiftzek/dsh-artifacts` v1.0.0，已装、侧栏 tab 已注册 |
| 依赖 | `dsh-better-sidebar` v0.19.0（tab 注册的宿主） |
| 当前症状 | `GET /report/?list=1&session=…` → **404** |

---

## 2. 目标与非目标

### Goals（v0.1.0）
1. 在 DSH 自带的 web server 上注册端点，**同源**提供索引 JSON 与文件内容。
2. 让 `dsh-artifacts` 的侧栏 tab **开箱可用**：列表、类型徽章、大小、相对时间、iframe 预览。
3. **默认安全**：只暴露一个受控目录、只读、防路径穿越、预览内容不获得同源脚本能力。
4. 零运行时依赖、可单文件安装、有测试、有文档、可一键卸载。
5. 与既有 profile 插件（19 个 bundle）**零冲突**。

### Non-goals（明确不做）
- ❌ **不实现 per-session 归属（`mine`）**。契约明确说「忽略 `session` 参数是完全支持的」，
  忽略时 tab 会隐藏 `This chat / All` 开关，行为与之前一致。
  归属判定属 v0.2（见 §9），因为正确实现需要解析会话记录的工具调用参数，
  而不是正则匹配原始行（契约文档专门警告过这个坑）。
- ❌ 不做写入/发布（那是 `contrib/publish-artifact` 一类工具的职责）。
- ❌ 不做鉴权体系（依托 DSH 的回环绑定）。
- ❌ 不修改 `dsh-artifacts` 本身。

---

## 3. 契约（必须精确匹配）

来源：`dsh-artifacts/README.md` + `docs/artifact-index-endpoint.md`。

### 3.1 索引端点

```
GET <indexUrl>          # 默认 /report/?list=1
     &session=<id>      # 可选；本版忽略
```

响应 `application/json`：

```json
{
  "count": 2,
  "items": [
    { "name": "report.html", "url": "/report/report.html",
      "ext": "html", "size": 11160, "mtime": 1788934528 }
  ]
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `items` | ✅ | 数组，**最新在前**。非数组会被降级为空列表 |
| `name` | ✅ | 显示名，同时是行的身份，必须稳定 |
| `url` | ✅ | 相对或绝对；**原样**作为 iframe `src` |
| `ext` | — | 小写无点，驱动类型徽章 |
| `size` | — | 字节 |
| `mtime` | — | Unix **秒** |
| `mine` | — | **本版不发**（见 Non-goals） |
| `count` | — | 信息性；插件自己数 `items` |

错误处理：对象级 `error` 字符串会被内联展示（比空列表更有诊断价值）。

> ⚠️ 契约要求：**不能**为不了解的 artifact 发 `mine: false`
> （会显示一个永远为空的 `This chat` 视图）。本版**完全省略 `mine`**。

### 3.2 文件端点

`items[].url` 由**本插件**生成，因此文件端点路径由我们定义。选择：

```
/report/<filename>          ← 与默认 indexUrl 同前缀，语义直观
```

要求：`Content-Type` 正确、支持 `HEAD`、支持 `Range`（大文件/视频友好，可选）。

---

## 4. 架构

```
┌──────────────────────────── DSH Host 进程 ────────────────────────────┐
│                                                                        │
│  dsh-artifact-index (本插件, profile bundle)                           │
│    ├─ inject: ["webServer"]                                            │
│    ├─ ctx.effect(() => ctx.webServer.register({                        │
│    │                    kind: "prefix", path: "/report",               │
│    │                    handler: dispatch }))                          │
│    │      └─ 内部分流：/report 与 /report/ → 索引 JSON                  │
│    │                   其余 /report/<name> → 文件字节                 │
│    └─ 纯函数模块（可单测）：scan.js / safe-path.js / trust.js          │
│                                                                        │
│  @deepseek-ai/dsh-web-app  ── HTTP :<port> (loopback) ──┐              │
└───────────────────────────────────────────────────────┼────────────────┘
                                                        │ 同源
┌──────────────────────── Browser ───────────────────────┼───────────────┐
│  DSH GUI (同源)                                         │               │
│    dsh-better-sidebar ── 注册 tab ──┐                   │               │
│    dsh-artifacts (client) ── fetch("/report/?list=1") ──┤               │
│                            └─ iframe src=items[].url ───┘               │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1 为什么用 `webServer.register` 而不是自建 HTTP 服务

- **同源**：契约要求相对 `url` 继承 GUI 的 origin 与 session cookie；
  另一个端口 = 另一个 origin，会导致 fetch 需 CORS、iframe 拿不到 cookie。
- **生命周期**：`ctx.effect()` 保证插件卸载/重载时路由自动注销，不留孤儿监听。
- **既有先例**：`dsh-billing-dashboard`（`kind:"exact"`）与 `dsh-better-sidebar`
  （`kind:"prefix"`）已在本机验证可用，属受支持路径。

### 4.2 路由注册：单条 prefix + 内部分流（实现时定案）

设计阶段曾计划在 `/report/` 上同时注册 `exact`（索引）与 `prefix`（文件）两条路由。
**实现时改为单条 `prefix` 路由 + 内部按 `pathname` 分流**，理由：

1. **遮蔽语义无法自证。** 两条路由同前缀时谁先命中取决于注册顺序与宿主的匹配实现；
   而 `exact` 在 path 带尾斜杠时能否命中 `/report/` 也无从确认——客户端请求的正是
   `/report/?list=1`，其 `pathname` 是 `/report/` 而不是 `/report`。
2. **重复 prefix 挂载会拖垮整棵 plugin tree。** `dsh-better-sidebar` 的
   `cordis.patch.yml` 里明确记录：同一 prefix 挂载两次会以 `duplicate prefix route`
   失败并导致**整个插件树**加载失败。单条注册把这一整类风险降到零。
3. **代价只是一个 `if`。** 分流本身就是一次 `pathname` 判定，没有引入额外复杂度。

分流规则（见 `lib/index.js`）：

| `pathname` | 处理 |
|---|---|
| `/report` 或 `/report/` | 索引 JSON（`?list=1`、`?session=<id>` 均被忽略） |
| `/report/<单段名>` | 该 artifact 的字节流 |
| 其他 | `404` |

**prefix 处理器拿到的 `req.url` 是完整路径（含前缀），不是剩余段。** 依据是
`dsh-better-sidebar` 的 `/sidebar/api` 处理器：它用
`pathname.slice("/sidebar/api/".length)` 取剩余段。因此本插件用
`pathname.slice("/report".length + 1)` 取文件名，并对**单段性**在解码前后各校验一次。

### 4.3 信任闸门为什么不用 `ctx.webRuntime`

`dsh-better-sidebar` 的 `fence()` 委托给 `ctx.webRuntime.trustedHosts`。本插件**没有**
这样做，而是把等价逻辑放在 `lib/trust.js`：

- Cordis 对**未满足的 `inject` 是静默跳过**——不报错、不打日志。多写一个服务名，
  就多一种「装上了但永远不激活」的失败模式，而本机已经因此损失过
  `dsh-browser-plus`（配置合成正常、零日志、工具永不出现）。
- 本插件的判断面很小（Host 是否 loopback + `Sec-Fetch-Site` / `Origin`），
  自持一份的维护成本低于引入服务依赖的风险。
- 需要通过非 loopback 主机访问时，用 `config.trustedHosts` 显式放开，
  比继承宿主的一份隐式列表更容易审计。

---

## 5. 配置

三层，后者覆盖前者（与 DSH 惯例一致）：

| 层 | 键 | 默认 | 说明 |
|---|---|---|---|
| 内置默认 | `root` | `$DSH_HOME/artifacts` | 唯一被暴露的目录 |
| 环境变量 | `DSH_ARTIFACT_INDEX_ROOT` | — | 覆盖 root |
| 插件 config（`cordis.patch.yml`） | `root` / `maxItems` / `csp` | — | 最高优先级 |

```yaml
# 用户可在 profile 的 cordis.patch.yml 覆盖（顶层裸 id = 覆盖已有条目）
- id: dsh-artifact-index
  config:
    root: <你的 artifact 目录>    # 例如 $DSH_HOME/artifacts
    maxItems: 500
    csp: sandbox
```

> **客户端侧**无需改：`dsh-artifacts` 默认就请求 `/report/?list=1`。
> 若将来换路径，可用 `localStorage['dsh-artifacts:indexUrl']` 覆盖，无需重装。

---

## 6. 安全模型（本项目最需要评审的部分）

### 6.1 威胁与对策

| 威胁 | 对策 |
|---|---|
| 路径穿越（`../`、绝对路径、`%2e%2e`） | 规范化后校验：`resolve(root, name)` 必须以 `root + sep` 开头；再用 `realpath` 复核，防止软链接逃逸 |
| 符号链接指向 root 之外 | `fs.realpath` 后**再**做一次前缀校验（对 root 本身也取 realpath） |
| 暴露敏感文件（`.env`、密钥、`.git`） | 只服务**白名单扩展名**；且 root 默认是专用目录，不是整个 home |
| 目录遍历枚举 | 索引只 `readdir` 一层（不递归），跳过目录、隐藏文件、符号链接 |
| 超大响应 | `maxItems` 上限；单文件大小上限（默认 64 MiB），超限 413 |
| **预览内容获得同源脚本能力**（见 6.2） | 默认对 HTML/SVG 加 `Content-Security-Policy: sandbox` |
| 跨站调用索引 | 校验 `Sec-Fetch-Site` / `Origin`：只接受 same-origin / `none` |
| 非回环访问 | 依托宿主 `networkExposure: loopback`；插件**不额外放开**绑定 |

### 6.2 ⚠️ 关键决策：预览 HTML 的 CSP（**需你拍板**）

`items[].url` 会被 `dsh-artifacts` 放进 **同源 iframe**。这意味着一个被 agent 生成的
恶意 HTML 可以：读取 DSH 的 `localStorage`、以你的会话身份调用 DSH 的本地 API。

**三个可选策略：**

| 策略 | 响应头 | 效果 | 代价 |
|---|---|---|---|
| **A. `sandbox`（我推荐）** | `Content-Security-Policy: sandbox` | HTML/CSS 正常渲染；**脚本不执行**、无法访问父页面或 cookie | 生成物里的交互脚本（图表按钮、live-reload）失效 |
| **B. `sandbox allow-scripts`** | `Content-Security-Policy: sandbox allow-scripts` | 脚本可跑，但仍是**不透明源**（拿不到 cookie / 父页面） | 图表库这类需要脚本的自包含 HTML 可用；仍无法触碰 DSH |
| **C. 不加头** | — | 完全同源，交互最完整 | **风险最高**：等于让 agent 生成的任意 HTML 以你的身份运行 |

**我的建议：默认 A，提供配置项 `csp: "sandbox" \| "sandbox-scripts" \| "none"`，
并在 README 里写明各自代价。** 请你在评审时确认。

### 6.3 明确不做的事

- 不写任何文件（纯只读）。
- 不读会话记录（v0.2 归属功能才会涉及，且只读解析）。
- 不引入任何凭据访问。

---

## 7. 兼容性与依赖

| 项 | 要求 | 依据 |
|---|---|---|
| DSH | `>= 0.1.5-rc.1` | 本机实测版本；`webServer.register` 的 `prefix` 形态由 better-sidebar 佐证 |
| Node | `>= 22` | DSH Desktop 内置 24.x |
| 运行时依赖 | **零** | 与 `dsh-artifacts` 保持同一标准 |
| lifecycle 脚本 | **零**（无 `prepare`/`postinstall`） | 避免 pnpm `ERR_PNPM_IGNORED_BUILDS`（本项目已两次踩坑） |
| 冲突面 | 仅 `/report/` 前缀 | 已核查：本机无其他插件占用该前缀 |

---

## 8. 测试策略

| 层 | 内容 | 方式 |
|---|---|---|
| **单元** | `resolveSafe()` 路径穿越矩阵（`..`、绝对路径、`%2e`、软链接、大小写、UNC、空字节） | `node:test`，纯函数、无 IO |
| **单元** | `toItem()` 映射（ext 小写化、mtime 转秒、size 缺失降级） | 同上 |
| **单元** | `scan()` 排序（最新在前）、跳过目录/隐藏/软链接、`maxItems` 截断 | 临时目录夹具 |
| **契约** | 响应体严格匹配 §3.1 的 JSON Schema；`items[].url` 能被自身文件端点取回（往返测试） | 起真实 server 或用 mock res |
| **集成** | 装到 `desktop` profile → 重启 → 新会话 → 侧栏出现列表并可预览 | 手工验收（见 §11） |
| **负向** | 非白名单扩展名 404、越界路径 403、超限 413、跨站 403 | 单元 + 手工 curl |

> 门禁：`node --test` 全绿 + `node --check` 语法检查（沿用本机既有惯例）。

---

## 9. 版本与里程碑

| 版本 | 范围 |
|---|---|
| **v0.1.0**（本次交付） | 索引 + 文件服务 + 安全模型 + 测试 + 文档；**不做 `mine`** |
| v0.2.0 | per-session 归属：解析会话记录的**工具调用参数**（不是正则原始行），输出 `mine` + `attributed`；侧栏自动出现 `This chat / All` 开关 |
| v0.3.0（可选） | 发布侧配合：`publish-artifact` 风格的 CLI，把文件复制进 root 并生成稳定的 `name` |
| 未来 | 若契约变更/上游提供原生端点，本项目可整体退役 |

---

## 10. 交付物结构（PR-ready）

实际树（✅ = 已交付）：

```
dsh-artifact-index/
├─ package.json          # ✅ name/version/exports/dsh.bundle.patch，零依赖、零 lifecycle
├─ cordis.patch.yml      # ✅ - insert: [{ id: dsh-artifact-index, name: 'dsh-artifact-index' }]
├─ .gitignore            # ✅ 零依赖，故忽略项很短
├─ lib/
│  ├─ index.js           # ✅ 宿主半：路由分流、信任闸门、CSP、流式发送
│  ├─ scan.js            # ✅ 扫描 + 契约映射 + 排序（fs 可注入）
│  ├─ safe-path.js       # ✅ 路径解析与穿越防护（双端 realpath）
│  └─ trust.js           # ✅ Host / Sec-Fetch-Site / Origin 信任判断
├─ test/
│  ├─ safe-path.test.mjs # ✅ 穿越矩阵
│  ├─ scan.test.mjs      # ✅ 过滤/排序/截断/错误路径
│  ├─ trust.test.mjs     # ✅ 信任矩阵（含 IPv6 与 DNS-rebinding）
│  ├─ contract.test.mjs  # ✅ 真 HTTP + 真临时目录的契约测试
│  └─ load.test.mjs      # ✅ 打包一致性与 apply 装配
├─ scripts/
│  └─ smoke.mjs          # ✅ 对真实 root 的端到端冒烟（可作安装门禁）
├─ docs/
│  └─ DESIGN.md          # ✅ 本文档
├─ README.md             # ✅ 中文说明（给人 / 给 AI 的入口）
├─ README.en.md          # ✅ English README
├─ SECURITY.md           # ✅ 威胁模型与 CSP 策略（GitHub 只识别根目录这一份）
├─ CHANGELOG.md          # ✅
└─ LICENSE               # ✅ MIT
```

`lib/trust.js` 与 `test/trust.test.mjs` 是设计阶段没有的：评审
`dsh-better-sidebar` 的 `fence()` 时发现「Host 必须是 loopback」这道防
DNS-rebinding 的闸门在设计里缺失，补上并单测（见 §4.3）。

安装（实际采用，已验证成功）：

```powershell
# 本地开发：link: 建符号链接，改代码后重启 DSH Desktop 即可生效
dsh plugin --profile desktop add "link:<本仓库的绝对路径>"
# 或冻结一份副本
dsh plugin --profile desktop add "file:<本仓库的绝对路径>"
# 或发布到 npm 后
dsh plugin --profile desktop add dsh-artifact-index
```

`dsh plugin` 是 pnpm 的透传 wrapper（`dsh plugin --help` 直接落出 pnpm 的 help），
因此 spec 用 pnpm 的 `link:` / `file:` / `github:` 协议。

安装后 CLI 会**自动**把 `dsh-artifact-index` 追加进 `dsh.profile.bundles`
（读到本包的 `dsh.bundle.patch` 声明），无需手改 profile 文件。

卸载：`dsh plugin --profile desktop remove dsh-artifact-index`。

> **不做的事**：不改用户的 `pnpm-workspace.yaml`；不要求 `allowBuilds`
> （零 lifecycle → 不触发 pnpm 构建白名单，这是吸取前两次踩坑的教训）。
> 已实测：安装输出无 `ERR_PNPM_IGNORED_BUILDS`，依赖数 16 → 17，**无任何包被移除**。

---

## 11. 验收标准（Definition of Done）

自动化部分（已全绿）：

- [x] `node --test` —— **63/63 通过**
- [x] `GET /report/?list=1` 返回 §3.1 契约 JSON，`items` 最新在前
- [x] 负向全过：越界 → 400/404、非白名单 → 404、超限 → 413、跨站/非 loopback Host → 403
- [x] HTML 预览默认**不执行脚本**（响应带 `Content-Security-Policy: sandbox`）
- [x] `scripts/smoke.mjs` 对**真实** artifact 目录（`$DSH_HOME/artifacts`）端到端 **22/22 通过**
- [x] `dsh --profile desktop --dump-config` 出现 `# == dsh-artifact-index` 挂载行，
      且除既有的 `wallpaper-engine` 警告外**无其他插件回归**
- [x] `apply` 装配测试：注册恰好一条 `prefix` 路由、回调返回 disposer

重启 DSH Desktop 后的人工确认：

- [x] 重启 DSH Desktop
- [x] **新开一个会话**（工具/路由列表是会话创建时的快照）
- [x] 侧栏 **Artifacts** tab 正常渲染（用户已确认「有效果了」）
- [ ] 再放一个文件进 root，确认列表在轮询周期内自动出现
- [ ] 卸载后路由消失、无残留、无报错（未验证；卸载命令见 README）

> `node --check` 已从验收项中移除：它按 CommonJS 解析 `.js`，对 ESM 文件会误报
> `Cannot use import statement outside a module`。取而代之的是 `load.test.mjs`
> 用 `import()` 真加载每个模块——同时校验语法与导入路径。

---

## 12. 三个关键决策（已定案）

| # | 决策 | 结论 |
|---|---|---|
| **D1** | HTML 预览的 CSP 策略（§6.2） | **已定案 = A：`sandbox`**（脚本不跑）。`sandbox-scripts` / `none` 作为 config 逃生门存在，但默认值不放松。 |
| **D2** | artifact 根目录默认值 | **已定案 = `$DSH_HOME/artifacts`**；可用 config `root` 或环境变量 `DSH_ARTIFACT_INDEX_ROOT` 覆盖（避免默认暴露整个工作区）。 |
| **D3** | 项目落地位置 | **已定案（相对原建议变更）= DSH 相关项目工作区下的 `DeepseekHarness\dsh-artifact-index`**，与 `third-party/`、`catalogs/` 同级，而非 `Projects\` 直属。 |

---

## 13. 风险登记

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| ~~exact+prefix 在同路径互相遮蔽~~ | — | — | **已消解**：改为单条 prefix + 内部分流（§4.2） |
| ~~`webServer.register` 的 `prefix` 语义在 0.1.5 有差异~~ | — | — | **已消解**：语义由 better-sidebar 佐证；`test/contract.test.mjs` 的真 HTTP 用例与 `scripts/smoke.mjs` 已覆盖 |
| 用户误把 root 指向整个 home | 低 | 高 | 扩展名白名单 + 不递归 + 跳过隐藏文件；启动日志打印生效 root |
| 预览 XSS 影响 DSH 会话 | 中 | **高** | 已定案 D1：HTML/SVG/XML 默认下发 `Content-Security-Policy: sandbox` |
| 安装动作改动 profile 状态 | 中 | 中 | 安装前备份 `package.json` / `pnpm-workspace.yaml` / `cordis.patch.yml` |
| 索引被缓存导致「新 artifact 不出现」 | 低 | 中 | 所有响应带 `Cache-Control: no-store` |
| 符号链接把读取引到 root 之外 | 低 | 高 | 双端 `realpath` 校验；且扫描层不列符号链接 |
