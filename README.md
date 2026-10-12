# title2doi · DOI 补全工作台

一个面向 Zotero 的中文网页工具：整批导入文献，通过 Crossref 查找缺失 DOI，核对后一次粘贴脚本回填原条目。

纯 HTML / CSS / JavaScript，无构建依赖，无需 Crossref 或 Zotero API Key。

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

## 在 GitHub Pages 上部署

本仓库根目录就是可发布的静态网页，不需要安装依赖或构建。

1. 打开仓库的 **Settings → Pages**。
2. 在 **Build and deployment → Source** 选择 **Deploy from a branch**。
3. 选择 **main** 分支和 **/ (root)**，点击 **Save**。
4. 等待 GitHub Pages 部署完成。

启用并部署成功后，网址为：<https://thanejoss.github.io/title2doi/>。将代码推送到仓库本身不会自动启用 Pages；请以 GitHub Pages 设置页显示的部署状态为准。

仓库提供 `.nojekyll`，直接按静态文件发布。所有应用资源使用相对路径，支持项目子路径部署。

## 本地运行

在仓库目录启动任意静态 HTTP 服务。例如使用 Python：

```sh
python3 -m http.server 8000
```

打开 <http://localhost:8000>。请使用 HTTP 服务打开页面；浏览器可能限制直接通过 `file://` 打开的 JavaScript 模块。

运行测试需要 Node.js 18 或更新版本，无需 `npm install`：

```sh
npm test
```

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
| `app.mjs` | 交互、请求队列、本地进度和导出 |
| `core.mjs` | CSL 解析、匹配评分及 Zotero 回填脚本生成 |
| `tests/core.test.mjs` | 核心逻辑及模拟 Zotero API 测试 |

## 验证范围

10 组自动测试覆盖格式校验、匹配条件、原始元数据保留、预览不写入、确认后事务写入、保护已有 DOI、唯一条目对应、重复执行、生成脚本语法和 CSV 转义。

已通过真实 Crossref 接口验证 ResNet 与 AlphaGo 示例的 DOI，接口支持浏览器跨域查询。目前尚未进行浏览器视觉/交互实测，也未在真实 Zotero 客户端运行回填脚本；首次使用请先检查预览结果。

## 官方文档

- [Crossref REST API](https://github.com/CrossRef/rest-api-doc)
- [Crossref 访问与认证](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)
- [Zotero JavaScript API 与批量编辑](https://www.zotero.org/support/dev/client_coding/javascript_api)
- [Zotero CSL JSON 转换器](https://github.com/zotero/translators/blob/master/CSL%20JSON.js)

本项目是独立辅助工具，与 Zotero 或 Crossref 官方无隶属关系。
