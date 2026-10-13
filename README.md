# title2doi · DOI 补全工作台

一个面向 Zotero 的中文网页工具：整批导入文献，通过 Crossref 查找缺失 DOI，核对后一次粘贴脚本回填原条目。

纯 HTML / CSS / JavaScript，浏览器运行时无框架依赖，无需 Crossref 或 Zotero API Key。界面沿用 [webapps](https://github.com/ThaneJoss/webapps) 的 Web Apps 标识、蓝色主色、浅灰背景、顶部导航和白色圆角卡片。

目标域名：**https://title2doi.thanejoss.com**。域名已写入 Workers 配置、canonical、Open Graph 与 sitemap；正式访问需完成下面的 Cloudflare 部署和域名绑定。

## 如何使用

1. 在 Zotero 中多选需要补全的文献，右键 **导出条目**，格式选择 **CSL JSON**。
2. 将 `.json` 文件拖入网页，或粘贴文件全文。每批最多 **5,000 条 / 15 MB**，已有 DOI 的条目自动跳过。
3. 点击 **开始批量查询**。可以暂停、继续和重试失败条目，进度保存在当前浏览器。
4. 核对匹配结果。高匹配结果可以整批确认，其他候选通过「核对」选择。不确定的记录可以跳过。
5. 点击 **批量回填 Zotero**，在 Zotero 主窗口选中原来的那批文献。
6. 打开 Zotero 的 **工具 → 开发者 → Run JavaScript（运行 JavaScript）**，勾选 **Run as async function（作为异步函数运行）**。
7. 先复制整批预览脚本并运行，检查待更新列表；再复制整批回填脚本并运行，在弹窗中确认。无需逐条复制 DOI。

运行写入脚本前请备份 Zotero 数据。预览脚本只展示计划，不修改条目。

### 回填如何对应原条目

- 仅处理 Zotero 主窗口中选中的原文献。
- 优先使用导出 `id` 中的 Zotero 条目 key 和标题匹配。
- 没有条目 key 时，要求标题、第一作者、年份一致，而且只能对应一个所选条目。
- 已有 DOI、Extra 中已有 DOI、重复匹配、缺少必要信息，以及类型不支持 DOI 字段的条目会跳过，并在结果中说明。
- 写入在单个数据库事务中进行；重复运行不会覆盖已填入的 DOI。
- 不创建新条目，附件、笔记和既有引用仍关联到原条目。

页面也提供 CSV 核对表、补全后的 CSL JSON 下载。**重新导入 CSL JSON 会新建条目，不能代替更新现有条目的回填脚本。**

## Cloudflare 部署

Workers Static Assets 与 Pages 都可以托管本项目，选择其中一种即可；同一域名只绑定一个部署项目。构建统一执行 `npm run build`，输出 `dist/`。构建脚本仅复制网站资源，不发布仓库配置、测试或依赖文件。

### 方式一：Workers Static Assets

在 Cloudflare **Workers & Pages** 中创建 Worker 并连接 `ThaneJoss/title2doi`：

| 设置 | 值 |
| --- | --- |
| 项目 / Worker 名称 | `title2doi` |
| 生产分支 | `main` |
| 根目录 | 仓库根目录 |
| 构建命令 | `npm run build` |
| 部署命令 | `npm run deploy:worker` |
| Node.js | 24，参考 `.node-version` |

`deploy:worker` 直接执行本地锁定版本的 `wrangler deploy`，由 `wrangler.jsonc` 统一定义静态资源目录、构建步骤和自定义域名。仓库根目录的 `wrangler.jsonc` 会被默认部署命令自动识别，并在部署前构建、校验 `dist/`。这是只托管静态资源的 Worker，无需额外编写后端脚本或配置数据库。

**已有 Cloudflare 项目请检查 Settings → Build 中保存的生产分支部署命令**：改成 `npm run deploy:worker`，删除旧命令中的 `--assets .`、`--assets ./` 或 `--assets /opt/buildhome/repo`。根目录可以是仓库根目录，但静态资源目录必须是 `dist`。

配置中的 Custom Domain 为 `title2doi.thanejoss.com`。确保 `thanejoss.com` 在部署账户中，并授予正常部署所需的权限；Wrangler 会在部署时按配置绑定域名及证书。若该域名已有其他绑定，先在 Cloudflare 中处理冲突。

命令行部署：

```sh
npm ci
npm run build
npx wrangler login
npm run deploy:worker
```

#### 非生产分支预览

既有 Workers Builds Git 集成使用 `npx wrangler preview` 发布非生产分支预览，生产分支继续使用上面的 `npm run deploy:worker`。两个命令都直接读取 `wrangler.jsonc`，不需要自定义 API 部署或重试脚本。

按照 [Wrangler 官方预览配置](https://developers.cloudflare.com/workers/previews/configuration/#wrangler-configuration-file)，本项目只有静态资源，因此显式配置空的 `"previews": {}`。`assets`、构建步骤与兼容日期保持顶层；生产自定义域名也保留原有顶层 `routes`，不放入 `previews`。预览地址取决于 Cloudflare 已有的 Preview URL 设置，不替换生产域名或生产流量；构建成功后仍需核对平台是否返回可访问的预览地址。若缺少此块，`wrangler preview` 会在上传前报错。

`verify:dist` 会检查预览块存在且没有生产绑定或路由，防止配置缺失再次进入 PR；`check:worker` 是打包 dry run，不代表真实预览发布成功。分支预览结果仍以该提交的 Cloudflare `Workers Builds: title2doi` 检查与平台日志为准。

### 方式二：Cloudflare Pages

在 **Workers & Pages → Create application → Pages** 中导入同一 GitHub 仓库：

| 设置 | 值 |
| --- | --- |
| 项目名称 | `title2doi` |
| 生产分支 | `main` |
| Framework preset | `None` |
| 构建命令 | `npm run build` |
| Build output directory | `dist` |
| 根目录 | 仓库根目录 |

首次部署成功后，进入 Pages 项目的 **Custom domains → Set up a custom domain**，添加 `title2doi.thanejoss.com`，按照向导完成 DNS 验证。必须先在 Pages 项目内添加域名，不能仅手动添加 CNAME；若向导要求填写 CNAME 目标，使用该项目实际分配的 `*.pages.dev` 地址。

Pages 使用上面的控制台构建设置。根目录的 `wrangler.jsonc` 是 Workers 配置，不包含 `pages_build_output_dir`；Pages 可能提示忽略该文件，继续使用控制台中的 `dist` 输出目录即可。不要将 Workers 的 `deploy:worker` 命令用作 Pages 的构建命令。

### 排查 `Asset too large` / `node_modules/workerd/bin/workerd`

若日志显示静态资源目录为 `/opt/buildhome/repo`，说明部署命令把整个仓库作为资源目录，因而扫描到了 `node_modules` 中的工具程序。

1. 打开 Worker 的 **Settings → Build**，把构建命令设为 `npm run build`，部署命令设为 `npm run deploy:worker`。
2. 保存后部署 `main` 的最新提交，不要重试旧提交。正常日志应显示资源来自 `dist`。
3. 无需删除 `node_modules`、压缩 `workerd` 或增加上传大小限制。

默认 `wrangler.jsonc` 将资源目录设为 `./dist`；根目录另有 `.assetsignore` 白名单，为仍使用旧 `--assets .` 命令的部署提供保护，只允许公开网页文件，不上传依赖、测试、配置或仓库元数据。推荐仍按上面步骤修正控制台命令。

### 部署时的 `504 Gateway Timeout`

`wrangler deploy` 会读取配置并通过 Cloudflare API 应用它。日志中的 `/assets-upload-session` 和 `/subdomain` 请求由 Wrangler 自身发出。504 表示该部署请求超时；保留原始日志和 Ray ID，稍后重新部署，持续失败时联系 Cloudflare 支持。

项目直接保留 Wrangler 的成功或失败状态，不额外运行重试脚本或 `wrangler triggers deploy`。`Uploaded title2doi` 表示上传步骤完成，不能单凭这一行确认自定义域名已配置成功。

### 边缘与静态资源

- `_headers` 提供 CSP、nosniff、Referrer-Policy、Permissions-Policy、frame 限制与 HSTS。CSP 允许浏览器访问 `https://api.crossref.org`，并兼容 Cloudflare Web Analytics。
- 模块入口包含 `data-cfasync="false"`，与 `webapps` 的 Cloudflare 处理方式一致。建议为本域名关闭 Rocket Loader。
- `404.html` 为未知路径返回真实 404；Workers 使用 `not_found_handling: "404-page"`，Pages 使用顶层 404 文件。没有全局 SPA 重写。
- 页面和模块没有带 hash 的文件名，因此响应要求缓存重新验证，避免更新后继续执行旧脚本。
- 推送 GitHub 只更新仓库；在 Cloudflare 中完成 Git 集成后，后续推送才会按平台设置自动部署。

## 本地运行

使用 Node.js 24（最低 22.13，以兼容开发检查工具），按锁文件安装开发工具并启动本地 Worker 静态资源服务：

```sh
npm ci
npm run dev
```

按终端输出打开本地地址，默认 <http://localhost:8787>。修改静态源码后重新执行 `npm run build`。请使用 HTTP 服务打开页面；浏览器可能限制直接通过 `file://` 打开的 JavaScript 模块。

检查命令：

```sh
npm run lint
npm test
npm run build
npm run verify:dist
npm run check:worker
npx playwright install chromium
npm run test:e2e
```

`test:e2e` 自动启动仅本地运行的 Wrangler 静态服务，不需要 Cloudflare 登录。Linux 首次使用可运行 `npx playwright install --with-deps chromium` 安装浏览器系统依赖。已有 Chromium 时可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向其可执行文件。

## 匹配与接口

- 接口：`https://api.crossref.org/works`，使用 `query.bibliographic` 查询标题、第一作者和年份。
- 每条最多取 5 个候选，并对标题相似度、第一作者、年份和文献类型进行排序。
- 高匹配要求标题相似度至少 0.96、第一作者和年份一致、类型不冲突、标题长度足够，且领先第二候选至少 8 分。
- 高匹配仍需用户确认才进入回填脚本。匹配分数是启发式排序分，不是准确概率。
- 请求串行执行，设置超时，处理 HTTP 429 和 5xx 并等待重试；连续失败时自动暂停。
- 联系邮箱为选填，填写后作为 `mailto` 参数发送给 Crossref。

Crossref 可能不收录某些文献；未找到不代表文献一定没有 DOI。同名文献、预印本和正式发表版、勘误等情况需要人工核对。

## 数据与隐私

文件只在浏览器中解析。文献元数据、候选和确认进度保存在当前网站来源的 `localStorage`，可通过页面底部 **清空本地记录** 删除。

查询仅向 Crossref 发送标题、第一作者、年份和选填邮箱，不上传 PDF，不访问 Zotero 账号。请求不携带凭据或 Referer。网站本身不需要后端服务器。

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `index.html` | 页面、导入区域和核对/回填窗口 |
| `styles.css` | 响应式布局与视觉样式 |
| `favicon.svg` | 与主站一致的 Web Apps 标识 |
| `app.mjs` | 交互、请求队列、本地进度和导出 |
| `core.mjs` | CSL 解析、匹配评分及 Zotero 回填脚本生成 |
| `tests/core.test.mjs` | 核心逻辑及模拟 Zotero API 测试 |
| `tests/e2e/`、`playwright.config.mjs` | 桌面/移动端 Chromium、模拟 Crossref、axe 与截图验收 |
| `eslint.config.mjs` | 浏览器与 Node.js 模块的 JavaScript 检查 |
| `.github/workflows/ci.yml` | PR 与 main 推送的自动质量检查 |
| `scripts/build.mjs` | 生成可部署的静态目录 `dist/` |
| `scripts/verify-dist.mjs` | 检查资源、页面绑定、域名、CSP 和 404 配置 |
| `wrangler.jsonc` | 自动识别的 Workers Static Assets、构建与自定义域名配置 |
| `.assetsignore` | 误用根目录作为静态资源目录时的公开文件白名单 |
| `_headers`、`404.html` | Workers / Pages 共用响应头与错误页 |

## 验证范围

核心测试覆盖格式校验（含空标题）、DOI 链接规范化、匹配条件、原始元数据保留、预览不写入、确认后事务写入、保护已有 DOI、唯一条目对应、重复执行、生成脚本语法和 CSV 转义。

`verify:dist` 检查静态文件白名单、单文件 25 MiB 限制、DOM 绑定、站点域名、Cloudflare 模块入口、Crossref CSP 放行、真实 404 及空的分支预览配置。`check:worker` 直接执行 `wrangler deploy --dry-run`，自动构建并检查打包与配置，不发布或修改 DNS。dry run 不调用真实上传或域名配置接口，不能验证 Cloudflare 接口是否已经恢复。

PR（包括 draft）与 main 推送都会执行 ESLint、核心单元测试、静态构建、产物验证、Worker dry run，以及桌面/移动端 Chromium 浏览器验收。浏览器测试覆盖导入、查询、暂停/继续、失败重试、确认与导出、刷新恢复、键盘焦点、弹窗无障碍、布局和真实 404；Crossref 完全使用固定响应，其他外部浏览器请求会被拒绝。测试不会操作真实 Zotero 或 Cloudflare 资源。截图、HTML 报告及失败 trace 保存在 Actions 的 `browser-report` artifact 中，保留 14 天。

项目使用原生 JavaScript，没有独立 TypeScript 类型检查；ESLint 检查语法与变量使用，实际 DOM 绑定和交互由产物验证及浏览器测试覆盖。自动无障碍检查使用 axe，不能替代完整人工读屏验收。真实 Crossref 可用性和 Zotero 客户端写入不属于 CI；首次使用仍应先检查预览结果。

## 官方文档

- [Crossref REST API](https://github.com/CrossRef/rest-api-doc)
- [Crossref 访问与认证](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)
- [Zotero JavaScript API 与批量编辑](https://www.zotero.org/support/dev/client_coding/javascript_api)
- [Zotero CSL JSON 转换器](https://github.com/zotero/translators/blob/master/CSL%20JSON.js)
- [Workers Static Assets 配置](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Pages 静态 HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)
- [Pages 自定义域名](https://developers.cloudflare.com/pages/configuration/custom-domains/)

本项目是独立辅助工具，与 Zotero 或 Crossref 官方无隶属关系。
