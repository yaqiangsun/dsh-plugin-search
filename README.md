<p align="center">
  <img src="./icon.svg" width="96" height="96" alt="dsh-plugin-search 图标" />
</p>

<h1 align="center">dsh-plugin-search</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-plugin-search"><img alt="npm 版本" src="https://img.shields.io/npm/v/dsh-plugin-search.svg" /></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-search"><img alt="npm 下载量" src="https://img.shields.io/npm/dm/dsh-plugin-search.svg" /></a>
  <a href="https://github.com/yaqiangsun/dsh-plugin-search/actions/workflows/check.yml"><img alt="自检状态" src="https://github.com/yaqiangsun/dsh-plugin-search/actions/workflows/check.yml/badge.svg" /></a>
  <a href="./LICENSE"><img alt="许可证" src="https://img.shields.io/npm/l/dsh-plugin-search.svg" /></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-search"><img alt="DSH 插件" src="https://img.shields.io/badge/DSH-plugin-4f6bed.svg" /></a>
</p>

在 DeepSeek Harness（DSH）里搜索 npm 上的 DSH 插件，并一键走内置安装流程。

装上之后：

- **「插件」页多一个「搜索」标签页**：输入插件名字片段，直接在 npm 上检索 DSH 社区插件；每条结果标出「组合包 · 可安装」「含界面」「已弃用」，点「安装」打开插件页自带的安装对话框（检查 → 进度 → 结果都由内置流程完成）。
- **模型侧多一个 `plugin_search` 工具**：让模型也能按名字片段找插件，返回版本、作者、是否可安装等信息。安装始终由用户在界面上确认，工具只负责找。

## 安装

在 DSH 的「插件 → 添加插件」里填包名：

```
dsh-plugin-search
```

或者用命令行装进某个 profile：

```bash
dsh plugin --profile desktop add dsh-plugin-search
```

装完需要重启 DSH（插件的 Host 半在主机进程里），重启后刷新页面即可看到「搜索」标签页。

## 检索行为

- **名字检索优先**：先做 npm 全文检索，命中名字的结果排前面；名字没命中时才退到「描述/关键词提到它」的结果，并明确标注。补充进来的「相关」结果必须自己真的提到查询词（名字、关键词或描述），不会因为搜索排名靠前就混进来。
- **完整包名直查 registry**：输入的是合法包名（`name` 或 `@scope/name`）时，插件会直接请求 `registry.npmjs.org/<包名>/latest` 并把它排在最前面 —— 不受 npm 搜索「整词匹配」的影响。所以 `qubitclient-dsh-panel` 这种完整名字一定能搜到（除非 npm 上确实没有这个包）。
- **按需校验**：是否「可安装」由本插件读取 npm 元信息（`GET registry.npmjs.org/<包名>/latest`）判断，看它有没有声明 `dsh.bundle.patch`。首屏只自动校验前 10 条，其余卡片滚到可见处才校验，避免一次打几十个请求。
- **失败不阻塞**：元信息读不到时显示「元信息读取失败 · 重试」，安装按钮照常可用（安装对话框自己会再校验一次）；只有确认「没有声明组合包」时才禁用安装。

### 一个已知的 npm 限制

npm registry 的搜索按**整词**匹配，不做前缀/子串。包名 `qubitclient-dsh-panel` 会被切成 `qubitclient` / `dsh` / `panel` 三个词，所以搜 `qubit` 匹配不到它——这是 registry 的语义（`name:` 限定符和 `qubit*` 通配符都无效），不是插件的问题。

不过**完整包名不受这个限制**：插件会绕过搜索接口，直接按名字查 registry（见上面「完整包名直查 registry」）。所以只要知道包名，就一定搜得到；只有「不知道名字、想按片段猜」时才会受整词匹配影响。

另外 npm 搜索接口要求查询词长度在 2..64 之间，输入 1 个字符时插件会直接提示，不会发请求（完整包名同样要满足这个长度）。

## 数据与隐私

- 只访问 npm 公共 registry（`registry.npmjs.org`）的搜索与元信息接口，不经过任何第三方中转。
- 不做任何安装动作：装什么、装不装，都由用户在插件页确认。
- 无遥测、无本地持久化（元信息只缓存在当前页面的内存里）。

## 兼容性

- 需要在有「插件」页（`@deepseek-ai/dsh-client-ui-plugin-manager`）的 profile 里使用；纯 Host 的 profile 下 Client 半不激活，`plugin_search` 工具照常可用。
- 不依赖任何 `@deepseek-ai/*` 包，因此不会被「插件与 dsh 版本不兼容」拦下。

## 许可证

MIT
