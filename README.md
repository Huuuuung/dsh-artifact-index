# dsh-artifact-index

给 DSH 的 `dsh-artifacts` 侧边栏标签页**提供一个真正可用的 artifact 索引端点**。

零依赖、只读、约 600 行（含注释与测试）。

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

```bash
# 本地开发（符号链接，改代码后重启 DSH Desktop 生效）
dsh plugin --profile desktop add link:D:\opencode-workspace\Projects\DeepseekHarness\dsh-artifact-index

# 或按版本冻结一份副本
dsh plugin --profile desktop add file:D:\opencode-workspace\Projects\DeepseekHarness\dsh-artifact-index
```

重启 DSH Desktop，然后确认挂载行存在：

```bash
dsh --profile desktop --dump-config | Select-String artifact-index
```

**必须新开一个会话**才能看到效果——DSH 的插件/工具列表是会话创建时的快照。

> `dsh-artifacts` 与 `dsh-better-sidebar` 需要**先**安装好；本插件只补后端，不替代它们。

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里那条 mount row 的 `config` 下，
或者用环境变量。优先级：**config > 环境变量 > 默认值**。

```yaml
- id: dsh-artifact-index
  name: 'dsh-artifact-index'
  config:
    root: D:\DSHData\artifacts
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

环境变量：`DSH_ARTIFACT_INDEX_ROOT` 覆盖 `root`（当 config 未提供时）。

`csp` 三个取值：

| 值 | 实际下发的头 | 适用 |
|---|---|---|
| `sandbox`（默认） | `sandbox` | artifact 内的脚本、表单、弹窗、同源访问全部失效。 |
| `sandbox-scripts` | `sandbox allow-scripts` | 需要看 JS 渲染的 HTML artifact（如自绘图表）。 |
| `none` | 不下发 | 只在你看得懂风险时用。 |

启动时插件会往日志里写一行 `artifact root = …`，用于排障——**先看这行**。

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
  「This chat / All」切换器，而 v0.1 还做不了按会话归属。
- 读不到目录时不抛错，而是回 `200` + `{ count: 0, items: [], error: "…" }`，
  由客户端把 `error` 内联显示出来。

### `GET /report/<name>`

返回该 artifact 的字节。`Content-Type` 按扩展名映射；HTML/SVG/XML 会带上 CSP。
只允许**单段文件名**，不接受子路径。

---

## 安全

这是**本机文件读取**接口，所以按不可信输入对待。详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

**做的**：

- 路径双重校验：先按解析后的前缀判断是否在 `root` 内，再对**两端都做 `realpath`**，
  因此指向外部目录的符号链接会被拒（只看字符串是拦不住的）。
- 只允许**单段**文件名；`%2F`、`..%2F`、`..\\` 等在解码前后各拦一次。
- 扩展名白名单（文档 + 图片），非白名单返回 `404`。
- **不递归**子目录，跳过隐藏文件（`.` 开头）与符号链接。
- `GET`/`HEAD` 之外一律 `405`。
- 同源闸门：Host 必须是 loopback（或 `trustedHosts`），`Sec-Fetch-Site: cross-site`
  直接 `403`——这条挡的是「用户随便访问一个网页，那个网页偷偷读本机端口」的经典攻击。
- 交付前再 `stat` 一次并核对大小上限，避免「先 stat 再读」的时间差被换文件放大。

**不做的**（明确的非目标，别误以为有）：

- **没有认证**。能访问这个端口的人就能读 `root` 里的白名单文件。防线是 profile 的
  `networkExposure: loopback`，**不要**把 DSH 暴露到公网。
- **不写入、不删除**，也不提供任何上传/发布通道。
- **不做按会话归属**（`mine`），所以别指望「只看这次对话的产物」。
- 不跟随符号链接，即使它指向 `root` 内部。

---

## 开发

```bash
node --test          # 61 个测试：契约、路径穿越、信任判断、打包一致性
```

测试里最有价值的两组：

- `test/contract.test.mjs` —— 起一个**真的 HTTP server** 打**真的临时目录**，
  逐字断言上游契约（字段集合、排序、`mine` 缺席、CSP、413、403）。
  契约不匹配是那种「UI 上只显示一行红字」的失败，不测就等于没写。
- `test/safe-path.test.mjs` —— 路径穿越矩阵，包括「前缀相同的兄弟目录」
  和「符号链接指向 root 外部」这两个字符串检查拦不住的用例。

代码结构：

```
lib/index.js      Cordis 宿主半：路由、信任闸门、CSP、流式发送
lib/scan.js       目录扫描 + 契约映射（fs 可注入，纯逻辑可单测）
lib/safe-path.js  路径安全（双重校验）
lib/trust.js      请求信任判断（Host / Sec-Fetch-Site / Origin）
```

`package.json` 里的 **零依赖、零生命周期脚本** 是硬约束，不是巧合：这个 profile
被 pnpm 的 build-script 策略搞挂过两次（`node-pty`、一个 git 依赖），所以任何需要
`allowBuilds` 入口的东西都不要加进来。

---

## Roadmap

**v0.2 — 按会话归属（`mine`）**

需要从会话事件流里把本轮的 artifact 路径还原出来。注意：**不能用正则扫原始文本**，
必须解析 tool-call 的**参数**（`write` 的 `path`），否则会话内容里提到一个文件名就会误判。

**v0.2 — 分页与搜索**

`maxItems` 目前是硬截断。超过几百个 artifact 之后需要 `?offset=` 或按名字过滤。

**v0.3 — 缩略图**

图片现在走原图。大量截图时侧边栏会明显变慢。

---

## License

MIT
