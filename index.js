/**
 * Host 半：跑在 DSH 主机进程里。
 *
 * 这里做两件事：
 *  1) 注册 `plugin_search` 工具 —— 让模型也能在 npm 上按名字片段检索 DSH 插件；
 *  2) 不碰安装：真正的安装统一走 Web UI 内置安装对话框（Client 半调用插件页
 *     提供的 install({ spec })），模型侧只负责“找”，避免模型误装来源不明的包。
 *
 * 检索数据来自 npm 公共 registry：
 *   - 搜索：https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin <query>
 *   - 校验：https://registry.npmjs.org/<name>/latest  （看 package.json 是否声明 dsh.bundle）
 *
 * 刻意不 import 任何 @deepseek-ai/* 包：零依赖 → 不会被「插件与 dsh 版本不兼容」拦下。
 */

export const name = 'dsh-plugin-search'

// 没有 tools 服务的 profile 里静默不激活，而不是抛错。
export const inject = ['tools']

const REGISTRY = 'https://registry.npmjs.org'
/** npm 下载统计接口：搜索响应里没有的包（例如完整包名直查 registry 时）单独问一次。 */
const DOWNLOADS_API = 'https://api.npmjs.org'
/** npm 上 DSH 插件社区的约定关键词；用它把搜索范围收敛到 DSH 插件。 */
const DSH_KEYWORD = 'dsh-plugin'
const REQUEST_TIMEOUT_MS = 15000
/** 下载统计是锦上添花，读不到就早点放手，不拖慢检索。 */
const DOWNLOADS_TIMEOUT_MS = 5000
/** 工具一次最多校验多少个包（每个包要额外请求一次 metadata）。 */
const MAX_PROBE = 12

function withTimeout(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return response.json()
}

/**
 * 完整包名直查 registry 只拿得到元信息；下载量优先用搜索结果里同名包的数据补上，
 * 这样既准确又不用多打一次下载统计接口（下载接口读不到时退回 0）。
 */
function withDownloadsFromSearch(exact, ...pages) {
  if (!exact) return null
  const found = pages.flat().find((item) => item.name === exact.name)
  return {
    ...exact,
    downloadsWeekly: exact.downloadsWeekly || found?.downloadsWeekly || 0,
    downloadsMonthly: exact.downloadsMonthly || found?.downloadsMonthly || 0,
  }
}

/** npm 搜索响应里的下载量：`downloads.weekly` / `downloads.monthly`，缺失按 0 处理。 */
function downloadsOf(object) {
  const downloads = object?.downloads ?? {}
  return {
    weekly: typeof downloads.weekly === 'number' && downloads.weekly > 0 ? downloads.weekly : 0,
    monthly: typeof downloads.monthly === 'number' && downloads.monthly > 0 ? downloads.monthly : 0,
  }
}

/**
 * 查某个包近一周的 npm 下载量。
 *
 * npm 搜索响应自带 downloads 字段，但完整包名是直查 `/<包名>/latest` 的，那里没有
 * 下载量；只能再问一次 api.npmjs.org。新包还没聚合时接口会 404，读不到按 0 处理。
 */
async function fetchWeeklyDownloads(name) {
  const timeout = withTimeout(DOWNLOADS_TIMEOUT_MS)
  try {
    const encoded = name.replace('/', '%2f')
    const data = await fetchJson(`${DOWNLOADS_API}/downloads/point/last-week/${encoded}`, timeout.signal)
    return typeof data?.downloads === 'number' && data.downloads > 0 ? data.downloads : 0
  } catch (_error) {
    return 0
  } finally {
    timeout.done()
  }
}

/** 普通全文检索每页条数；关键词检索沿用同一个窗口。 */
const FULLTEXT_SIZE = 30
/** npm 搜索接口的硬限制：2..64 个字符。 */
const MAX_QUERY = 64

function toItem(object) {
  const pkg = object?.package ?? {}
  const downloads = downloadsOf(object)
  return {
    name: typeof pkg.name === 'string' ? pkg.name : '',
    version: typeof pkg.version === 'string' ? pkg.version : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    date: typeof pkg.date === 'string' ? pkg.date : '',
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
    publisher: typeof pkg.publisher?.username === 'string' ? pkg.publisher.username : '',
    downloadsWeekly: downloads.weekly,
    downloadsMonthly: downloads.monthly,
  }
}

async function fetchSearch(text, size, signal) {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`
  const body = await fetchJson(url, signal)
  const objects = Array.isArray(body?.objects) ? body.objects : []
  return {
    total: typeof body?.total === 'number' ? body.total : objects.length,
    items: objects.map(toItem).filter((item) => item.name !== ''),
  }
}

/** npm 包名格式（含 scoped），用来判断用户是不是直接敲了完整包名。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * 按完整包名精确查一次 `/<name>/latest`。
 *
 * npm 搜索是「整词匹配 + 相关性排序」：输入 `qubitclient-dsh-panel` 这种三词包名时，
 * 搜索接口会把 dsh / panel 这些常见词的其他包排到前面，目标包反而被挤出前 30 条。
 * 所以**完整包名必须直接打 registry**，不能只靠搜索接口。
 */
async function fetchExactPackage(name, signal) {
  if (!PACKAGE_NAME_RE.test(name)) return null
  try {
    const encoded = name.replace('/', '%2f')
    const [data, weekly] = await Promise.all([
      fetchJson(`${REGISTRY}/${encoded}/latest`, signal),
      fetchWeeklyDownloads(name),
    ])
    if (!data || typeof data.name !== 'string') return null
    const maintainer = Array.isArray(data.maintainers) ? data.maintainers[0] : null
    return {
      name: data.name,
      version: typeof data.version === 'string' ? data.version : '',
      description: typeof data.description === 'string' ? data.description : '',
      date: '',
      keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
      publisher: typeof maintainer?.name === 'string' ? maintainer.name : '',
      downloadsWeekly: weekly,
      downloadsMonthly: 0,
    }
  } catch (_error) {
    return null
  }
}

/**
 * npm 搜索：把 DSH 社区插件按查询词相关性排好序。
 *
 * 两个 npm 的坑：
 * 1) `keywords:dsh-plugin <词>` 先把结果集收敛成「全部带该关键词的包」（上万个），
 *    后面的词几乎不影响排序 —— 具体包常排在 250 名之外，看起来就是搜不出来。
 * 2) 全文检索按「整词」匹配，不做前缀/子串：qubitclient-dsh-panel 的名字被切成
 *    qubitclient / dsh / panel，所以搜 `qubit` 永远命中不了它（`name:` 限定符和
 *    `qubit*` 通配符都实测无效）。这是 registry 的语义，只能如实说明。
 *
 * 返回的 `mode` 交给调用方决定措辞：browse / name / text / none。
 */
async function searchRegistry(query, size, signal) {
  if (!query) {
    const page = await fetchSearch(`keywords:${DSH_KEYWORD}`, size, signal)
    return { total: page.total, items: page.items, mode: 'browse' }
  }

  const [plain, scoped, exactPackage] = await Promise.all([
    fetchSearch(query, FULLTEXT_SIZE, signal),
    fetchSearch(`keywords:${DSH_KEYWORD} ${query}`, FULLTEXT_SIZE, signal).catch(() => ({
      total: 0,
      items: [],
    })),
    fetchExactPackage(query, signal).catch(() => null),
  ])
  const exact = withDownloadsFromSearch(exactPackage, plain.items, scoped.items)

  const needle = query.toLowerCase()
  const isDshLike = (item) =>
    item.keywords.includes(DSH_KEYWORD) ||
    item.keywords.includes('deepseek-harness') ||
    item.name.toLowerCase().includes('dsh')

  /** 精确命中的包永远排第一，其余去重后按相关性排。 */
  const compose = (base) => {
    const merged = []
    const seen = new Set()
    if (exact) {
      seen.add(exact.name)
      merged.push(exact)
    }
    for (const item of base) {
      if (!seen.has(item.name)) {
        seen.add(item.name)
        merged.push(item)
      }
    }
    const ordered = rankItems(merged, query)
    if (exact) {
      const index = ordered.findIndex((item) => item.name === exact.name)
      if (index > 0) ordered.unshift(ordered.splice(index, 1)[0])
    }
    return ordered
  }

  const nameHits = plain.items.filter(
    (item) => item.name.toLowerCase().includes(needle) && isDshLike(item),
  )
  /**
   * 「相关」补充项必须自己真的提到查询词（名字/关键词/描述）。
   * npm 全文检索会命中 README，光靠搜索排名会把名字、描述都没有该词的包带进来，
   * 那样工具输出里的「名字包含」就成了假话。
   */
  const mentionsNeedle = (item) =>
    item.name.toLowerCase().includes(needle) ||
    item.keywords.some((keyword) => keyword.toLowerCase().includes(needle)) ||
    (item.description || '').toLowerCase().includes(needle)

  if (nameHits.length > 0 || exact) {
    const related = plain.items.filter(
      (item) => isDshLike(item) && mentionsNeedle(item) && !nameHits.includes(item),
    )
    const items = compose([...nameHits, ...related])
    return { total: items.length, items, mode: 'name' }
  }

  const textHits = scoped.items.filter((item) => {
    const keywords = item.keywords.join(' ').toLowerCase()
    const description = (item.description || '').toLowerCase()
    return item.keywords.includes(DSH_KEYWORD) && (keywords.includes(needle) || description.includes(needle))
  })
  if (textHits.length > 0) {
    return { total: textHits.length, items: rankItems(textHits, query), mode: 'text' }
  }

  return { total: 0, items: [], mode: 'none' }
}

/**
 * 读取某个包的 latest 元信息，判断它是不是“可安装的组合包”。
 * 可安装 = package.json 里有 dsh.bundle.patch（组合包补丁）。
 */
async function probePackage(name) {
  const timeout = withTimeout(REQUEST_TIMEOUT_MS)
  try {
    const encoded = name.replace('/', '%2f')
    const data = await fetchJson(`${REGISTRY}/${encoded}/latest`, timeout.signal)
    const dsh = data?.dsh && typeof data.dsh === 'object' ? data.dsh : null
    const patch = dsh?.bundle?.patch
    return {
      ok: true,
      name: typeof data?.name === 'string' ? data.name : name,
      version: typeof data?.version === 'string' ? data.version : '',
      description: typeof data?.description === 'string' ? data.description : '',
      installable: typeof patch === 'string' && patch !== '',
      hasClient: Boolean(dsh?.client),
      deprecated: typeof data?.deprecated === 'string' ? data.deprecated : '',
      homepage: typeof data?.homepage === 'string' ? data.homepage : '',
      error: '',
    }
  } catch (error) {
    return {
      ok: false,
      name,
      version: '',
      description: '',
      installable: false,
      hasClient: false,
      deprecated: '',
      homepage: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    timeout.done()
  }
}

/** 并发上限：npm registry 对突发请求比较宽容，但还是收敛一点。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 名字里出现查询片段的排前面（按出现位置），其余保持合并时的顺序。
 * 与 Client 半的排序保持一致，避免两边结果顺序不同。
 */
function rankItems(items, query) {
  if (!query) return items
  const needle = query.toLowerCase()
  return items
    .map((item, index) => {
      const position = item.name.toLowerCase().indexOf(needle)
      return { item, index, position: position < 0 ? Number.POSITIVE_INFINITY : position }
    })
    .sort((a, b) => (a.position !== b.position ? a.position - b.position : a.index - b.index))
    .map((entry) => entry.item)
}

/** 下载量的紧凑写法（9.4万 / 1.2k）；0 表示 npm 还没给出数据，显示成「—」。 */
function formatCount(value) {
  if (!Number.isFinite(value) || value <= 0) return '—'
  try {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  } catch (_error) {
    return String(value)
  }
}

const PLUGIN_SEARCH_TOOL = {
  name: 'plugin_search',
  description:
    'Search the npm registry for DeepSeek Harness (DSH) plugins by a name fragment. ' +
    'Returns matching packages with version, description, publisher, weekly/monthly npm download counts, ' +
    'and whether the package is an ' +
    'installable bundle (declares dsh.bundle.patch). Use it when the user asks to find or install a DSH plugin. ' +
    'The same search is available to the user in the Plugins page tab "搜索"; installation is done by the user ' +
    'through the built-in install dialog, not by this tool.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'A fragment of the plugin name or a topic keyword, e.g. "pet", "cost", "wallpaper". ' +
          'Empty string lists the most relevant DSH plugins.',
      },
      limit: {
        type: 'integer',
        description: `How many results to return (1-${MAX_PROBE}, default 8).`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        query: { type: 'string' },
        total: { type: 'integer' },
        mode: {
          type: 'string',
          enum: ['browse', 'name', 'text', 'short', 'none'],
          description:
            'browse: keyword list; name: plugin names contain the query; text: query only appears in ' +
            'descriptions/keywords; short: query shorter than npm allows; none: no match.',
        },
        packages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              description: { type: 'string' },
              publisher: { type: 'string' },
              downloadsWeekly: {
                type: 'number',
                description: 'npm downloads in the last week; 0 when npm has no data yet.',
              },
              downloadsMonthly: {
                type: 'number',
                description: 'npm downloads in the last month; 0 when npm has no data yet.',
              },
              installable: { type: 'boolean' },
              hasClient: { type: 'boolean' },
              error: { type: 'string' },
            },
            required: [
              'name',
              'version',
              'description',
              'publisher',
              'downloadsWeekly',
              'downloadsMonthly',
              'installable',
              'hasClient',
              'error',
            ],
            additionalProperties: false,
          },
        },
        error: { type: 'string' },
      },
      required: ['ok', 'query', 'total', 'mode', 'packages', 'error'],
      additionalProperties: false,
    },
    render(_args, value) {
      if (!value.ok) {
        return [{ type: 'text', text: `npm 插件搜索失败：${value.error}` }]
      }
      if (value.mode === 'short') {
        return [
          {
            type: 'text',
            text: 'npm 搜索接口要求查询词至少 2 个字符，请给一个更长的名字片段。',
          },
        ]
      }
      if (value.packages.length === 0) {
        return [
          {
            type: 'text',
            text:
              value.mode === 'none'
                ? `没有 DSH 插件的名字包含「${value.query}」。npm 搜索按整词匹配、不做前缀/子串：` +
                  '包名里的 qubitclient 不会被「qubit」命中。请改用更完整的名字片段（例如 qubitclient）。'
                : `npm 上没有找到与「${value.query || 'DSH 插件'}」匹配的插件（检索关键词 dsh-plugin）。`,
          },
        ]
      }
      const lines = value.packages.map((pkg) => {
        const flags = [pkg.installable ? '可安装' : '非组合包', pkg.hasClient ? '含界面' : '仅 Host']
        const weekly = formatCount(pkg.downloadsWeekly)
        const reason = pkg.error ? ` | 校验失败: ${pkg.error}` : ''
        return `- ${pkg.name}@${pkg.version || '?'} | ${flags.join(' / ')} | 周下载 ${weekly} | ${pkg.publisher || '-'}\n  ${pkg.description}${reason}`
      })
      const header =
        value.mode === 'browse'
          ? `npm 共 ${value.total} 个 DSH 插件（关键词 dsh-plugin）`
          : value.mode === 'text'
            ? `名称没命中「${value.query}」，描述/关键词提到它的 DSH 插件 ${value.total} 个，显示 ${value.packages.length} 个`
            : (() => {
                const lower = value.query.toLowerCase()
                const nameCount = value.packages.filter((pkg) =>
                  pkg.name.toLowerCase().includes(lower),
                ).length
                const exactHit = value.packages.some((pkg) => pkg.name.toLowerCase() === lower)
                const head = exactHit
                  ? `找到了「${value.query}」`
                  : `名字包含「${value.query}」的 DSH 插件 ${nameCount} 个`
                const related = value.packages.length - nameCount
                return `${head}${related > 0 ? `，另有 ${related} 个相关` : ''}；共 ${value.total} 个匹配，显示 ${value.packages.length} 个`
              })()
      return [
        {
          type: 'text',
          text: `${header}：\n` + lines.join('\n') + '\n\n提示：用户可在「插件 → 搜索」标签页里点「安装」走内置安装对话框。',
        },
      ]
    },
  },
  async execute(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : ''
    const rawLimit = Number(args?.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(MAX_PROBE, Math.max(1, Math.trunc(rawLimit))) : 8
    const timeout = withTimeout(REQUEST_TIMEOUT_MS * 2)
    try {
      if (query.length === 1) {
        return { ok: true, query, total: 0, mode: 'short', packages: [], error: '' }
      }
      const found = await searchRegistry(query.slice(0, MAX_QUERY), Math.max(limit, Math.min(30, limit * 2)), timeout.signal)
      const ordered = rankItems(found.items, query)
      const probed = await mapLimit(ordered.slice(0, limit), 4, (item) => probePackage(item.name))
      const packages = probed.map((probe) => {
        const origin = ordered.find((item) => item.name === probe.name)
        return {
          name: probe.name,
          version: probe.version,
          description: probe.description,
          publisher: origin?.publisher ?? '',
          downloadsWeekly: origin?.downloadsWeekly ?? 0,
          downloadsMonthly: origin?.downloadsMonthly ?? 0,
          installable: probe.installable,
          hasClient: probe.hasClient,
          error: probe.error,
        }
      })
      return {
        ok: true,
        query,
        total: found.total,
        mode: found.mode,
        packages,
        error: '',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, query, total: 0, mode: 'none', packages: [], error: message }
    }
  },
}

/**
 * 插件入口。所有注册都挂在 ctx 下，插件卸载时框架自动清理。
 */
export function apply(ctx) {
  ctx.tools.register(PLUGIN_SEARCH_TOOL)
}
