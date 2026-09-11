# dsh-artifact-index

为 DSH 的 `dsh-artifacts` 侧边栏标签页提供它所需的 artifact 索引端点。

零依赖、只读、约 600 行（含注释与测试）。无遥测，无网络外联，无 install 脚本。

---

## 它解决什么问题

`dsh-artifacts` 是一个**纯前端 viewer**：它只管渲染，不负责提供数据。它的 host 半
（`lib/index.js`）是一个刻意的空实现，客户端加载后就去轮询一个外部端点：

```js
// dsh-artifacts/lib/client.js:32
var DEFAULT_LIST_URL = "/report/?list=1";
```

所以装完之后，侧边栏会稳定地显示：

> Could not read the artifact index. HTTP 404 from /report/?list=1&session=…

**这不是 bug，是缺了一半。** 上游把「索引从哪来」留给了使用者。本插件就是那一半：
在 DSH 的 web server 上把 `/report` 这条路挂起来，返回上游约定的 JSON 形状，并把
artifact 的字节流发给它塞进 iframe。

---

## 安装

需要 **DSH ≥ 0.1.5-rc.1**，且 `dsh-better-sidebar` 与 `dsh-artifacts` 已先安装
（本插件只补后端，不替代它们）。

从 npm 安装：

```bash
dsh plugin --profile desktop add dsh-artifact-index
```

从源码安装（本仓库根目录）：

```bash
# 符号链接：改代码后重启 DSH Desktop 即可生效
dsh plugin --profile desktop add "link:<本仓库的绝对路径>"

# 或冻结一份副本
dsh plugin --profile desktop add "file:<本仓库的绝对路径>"
```

重启 DSH Desktop，确认挂载行存在：

```bash
dsh --profile desktop --dump-config | grep artifact-index
```

**改动插件后必须新开一个会话** —— DSH 的插件与工具列表是会话创建时的快照。

### 验证安装

插件启动时会往日志里写一行（日志在 DSH Desktop 的 logs 目录，
Windows 下是 `%APPDATA%\DSH Desktop\logs\dsh-<日期>.log`）：

```
[dsh-artifact-index] artifact root = <artifact 目录> (maxItems=500, ...)
```

- **出现这行** → 插件已激活，接下来只需看侧栏的 Artifacts 标签页。
- **没有这行** → 插件未激活。检查 `dsh.profile.bundles` 里是否有
  `dsh-artifact-index`，以及日志中有无 `failed to apply loader entry …`。

注意 DSH 的 web server 会拒绝非浏览器发起的请求，因此 `curl` 之类的命令行工具
无法用来验证路由。要对真实目录做端到端检查，用仓库里的脚本：

```bash
node scripts/smoke.mjs <artifact 目录>
```

它直接驱动 handler，对目录逐项回取校验。（该脚本只监听 loopback 并把请求发回自己。）

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里那条 mount row 的 `config` 下，
或者用环境变量。优先级：**config > 环境变量 > 默认值**。

```yaml
- id: dsh-artifact-index
  name: 'dsh-artifact-index'
  config:
    root: <artifact 目录>
    maxItems: 500
    maxFileBytes: 26214400
    csp: sandbox
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/artifacts` | 要索引的目录。**不递归**，只扫这一层。 |
| `maxItems` | `500` | 返回条目数上限，超出部分丢弃并在日志里记一条警告。 |
| `maxFileBytes` | `26214400`（25 MB） | 单文件上限，超过返回 `413`。 |
| `csp` | `sandbox` | 给 HTML/SVG/XML 响应加的 `Content-Security-Policy`。见下。 |
| `trustedHosts` | `[]` | 额外允许的 Host。仅当 DSH 不跑在 loopback 上时才需要。 |

`$DSH_HOME` 指 DSH 的数据目录（Windows 下可用 `echo $env:DSH_HOME` 查看，
或从 `dsh --profile desktop --dump-config` 里找）。

环境变量：`DSH_ARTIFACT_INDEX_ROOT` 覆盖 `root`（当 config 未提供时）。

`csp` 三个取值：

| 值 | 实际下发的头 | 适用 |
|---|---|---|
| `sandbox`（默认） | `sandbox` | artifact 内的脚本、表单、弹窗、同源访问全部失效。 |
| `sandbox-scripts` | `sandbox allow-scripts` | 需要看 JS 渲染的 HTML artifact（如自绘图表）。 |
| `none` | 不下发 | 只在明确理解风险时使用。 |

---

## 端点契约

### `GET /report/`（也接受 `/report`、`?list=1&session=<id>`）

```json
{
  "count": 2,
  "items": [
    { "name": "report.html", "url": "/report/report.html", "ext": "html", "size": 5120, "mtime": 1757000000 },
    { "name": "data.json",   "url": "/report/data.json",   "ext": "json", "size": 2048, "mtime": 1756990000 }
  ]
}
```

- `items` 按 `mtime` 降序（新→旧），同刻按 `name` 升序。
- `url` 被上游**原样**当作 iframe 的 `src`，因此是根相对且已百分号编码的。
- `mtime` 单位是**秒**。
- **响应里没有 `mine` 字段**，这是故意的：上游在 `mine` 缺席时会隐藏
  「This chat / All」切换器，而 v0.1 还做不了按会话归属。详见下方「关于 `mine`」。
- 读不到目录时不抛错，而是回 `200` + `{ count: 0, items: [], error: "…" }`，
  由客户端把 `error` 内联显示出来。

### `GET /report/<name>`

返回该 artifact 的字节。`Content-Type` 按扩展名映射；HTML/SVG/XML 会带上 CSP。
只允许**单段文件名**，不接受子路径。

---

## 关于 `mine`

`mine` 是 **`dsh-artifacts` 客户端约定的一个可选字段**，不是本插件发明的。

它的语义是「**这个 artifact 是不是当前这次会话产出的**」。客户端据此渲染一个
**This chat / All** 切换器，让使用者在一堆历史产物里只看本轮的结果。

- 字段**存在**时，客户端显示该切换器。
- 字段**缺席**时，客户端把切换器整个隐藏起来。

本插件 v0.1 **故意不下发 `mine`**，因为算不对它比不算更糟：要做对，必须从会话记录里
把本轮的 artifact 路径**还原**出来，而会话记录里并没有现成的「产物清单」。可行的做法是
解析 **tool-call 的参数**（比如写文件工具的 `path` 参数），而不是拿正则去扫原始文本——
后者只要对话里提到一个文件名就会误判。

所以 v0.1 的选择是：**给一份诚实的、扁平的「全部产物」列表**，而不是一份会撒谎的归属
信息。`?session=<id>` 参数会被解析但忽略，留给 v0.2 使用。

---

## 安全

这是**本机文件读取**接口，所以按不可信输入对待。详见 [`SECURITY.md`](SECURITY.md)。

**做的**：

- 路径双重校验：先按解析后的前缀判断是否在 `root` 内，再对**两端都做 `realpath`**，
  因此指向外部目录的符号链接会被拒（只看字符串是拦不住的）。
- 只允许**单段**文件名；`%2F`、`..%2F`、`..\\` 等在解码前后各拦一次。
- 扩展名白名单（文档 + 图片），非白名单返回 `404`。
- **不递归**子目录，跳过隐藏文件（`.` 开头）与符号链接。
- `GET`/`HEAD` 之外一律 `405`。
- 同源闸门：Host 必须是 loopback（或 `trustedHosts`），`Sec-Fetch-Site: cross-site`
  直接 `403`——用于挡住「网页读取本机端口」这一类请求。
- 交付前再 `stat` 一次并核对大小上限，避免「先 stat 再读」的时间差被换文件放大。

**不做的**（明确的非目标）：

- **没有认证**。能访问这个端口的人就能读 `root` 里的白名单文件。防线是 profile 的
  `networkExposure: loopback`，**不要**把 DSH 暴露到公网。
- **不写入、不删除**，也不提供任何上传/发布通道。
- **不做按会话归属**（`mine`）。
- 不跟随符号链接，即使它指向 `root` 内部。

---

## 开发

```bash
node --test          # 64 个测试：契约、路径穿越、信任判断、装配一致性
```

两个核心测试文件：

- `test/contract.test.mjs` —— 起一个**真的 HTTP server** 打**真的临时目录**，
  逐字断言上游契约（字段集合、排序、`mine` 缺席、CSP、413、403）。契约不匹配的表现
  是界面上只显示一行错误，因此不看测试很难发现。
- `test/safe-path.test.mjs` —— 路径穿越矩阵，包括「前缀相同的兄弟目录」
  和「符号链接指向 root 外部」这两个字符串检查拦不住的用例。

代码结构：

```
lib/index.js      Cordis 宿主半：路由、信任闸门、CSP、流式发送
lib/scan.js       目录扫描 + 契约映射（fs 可注入，纯逻辑可单测）
lib/safe-path.js  路径安全（双重校验）
lib/trust.js      请求信任判断（Host / Sec-Fetch-Site / Origin）
```

### 依赖与网络行为

**没有任何第三方运行期依赖**，也不需要安装期脚本：`package.json` 的 `scripts` 里没有
`preinstall` / `install` / `postinstall`，因此装这个包不会执行任何代码。

需要核对网络行为时，只有两处：

1. `lib/index.js` 与其余 `lib/*.js` 的 `import` —— 全部是 `node:` 内置模块。
2. `scripts/smoke.mjs` —— 只监听 loopback、只请求自己的端口，不向外部地址发送数据。

---

## Roadmap

**v0.2 — 按会话归属（`mine`）**

需要从会话事件流里把本轮的 artifact 路径还原出来。实现时必须解析 tool-call 的
**参数**（`write` 的 `path`），而不是正则扫描原始文本——否则对话内容里提到一个文件名
就会误判。契约上表现为 `mine: true/false`，侧栏随之出现 `This chat / All` 开关。

**v0.2 — 分页与搜索**

`maxItems` 目前是硬截断。超过几百个 artifact 之后需要 `?offset=` 或按名字过滤。

**v0.3 — 缩略图**

图片现在走原图。大量截图时侧边栏会明显变慢。

---

## 设计文档

[`docs/DESIGN.md`](docs/DESIGN.md) 记录了设计推理与取舍（为什么用单条 `prefix`
路由而不是 `exact` + `prefix`、为什么不注入 `ctx.webRuntime`、风险登记表等）。

---

## License

MIT
