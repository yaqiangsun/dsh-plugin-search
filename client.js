/**
 * Client 半：跑在 DSH 浏览器页面里，负责「界面」。
 *
 * 在「插件」页的两个自带标签页（已安装 / 发现）之后，再挂一个「搜索」标签页：
 * 输入插件名字片段 → 去 npm 公共 registry 检索 DSH 插件 → 每条结果可点「安装」。
 *
 * 关键扩展点（来自 @deepseek-ai/dsh-client-ui-plugin-manager 的 README）：
 *   - 页面声明 list slot `plugins.tab`，其他插件注册条目即可多出一个标签页；
 *     条目字段：name / id / label / order，正文组件就是注册的组件函数；
 *   - owner props 提供 install({ spec, registry?, title, version }) 和 openPackage(name)。
 *     install 会打开页面自带的安装对话框（检查界面 → 进度 → 结果），
 *     安装、勾选组合包、写 profile 全部由内置流程完成，本插件不碰文件。
 *
 * 数据源：npm 公共 registry（浏览器直接 fetch，registry 对搜索与 metadata 都返回 CORS *）：
 *   - 搜索：https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin <片段>
 *   - 校验：https://registry.npmjs.org/<name>/latest   看是否声明 dsh.bundle.patch
 *
 * 三条硬规则：工厂函数无副作用；只用 --dsw-alias-* 主题 token 上色；
 * React 从模块表 require('react') 拿。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const REGISTRY = 'https://registry.npmjs.org'
    /** npm 上 DSH 插件社区的约定关键词；用它把搜索范围收敛到 DSH 插件。 */
    const DSH_KEYWORD = 'dsh-plugin'
    /** 每页拉多少条搜索结果。 */
    const PAGE_SIZE = 30
    /** 并发校验 metadata 的并发度。 */
    const META_CONCURRENCY = 6
    /** 首屏自动校验几条；剩下的按「滚到可见处」懒校验，省得一次打 30 个请求。 */
    const EAGER_PROBE = 10
    /** 输入防抖。 */
    const SEARCH_DEBOUNCE_MS = 350
    const FETCH_TIMEOUT_MS = 15000
    /** 元信息校验比搜索更“可失败”：读不到就早点放手，别让「校验中」挂太久。 */
    const META_TIMEOUT_MS = 8000

    // ---- 网络小工具 --------------------------------------------------------

    function createTimeoutSignal(timeoutMs) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      return { signal: controller.signal, done: () => clearTimeout(timer) }
    }

    async function fetchJson(url, signal) {
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`)
      return response.json()
    }

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

    // ---- npm 检索 ----------------------------------------------------------

    /** 普通全文检索每页条数；关键词检索沿用 PAGE_SIZE。 */
    const FULLTEXT_SIZE = 30

    /** npm 搜索返回的原始结果 → 列表项。 */
    function toItem(object) {
      const pkg = object?.package ?? {}
      return {
        name: typeof pkg.name === 'string' ? pkg.name : '',
        version: typeof pkg.version === 'string' ? pkg.version : '',
        description: typeof pkg.description === 'string' ? pkg.description : '',
        date: typeof pkg.date === 'string' ? pkg.date : '',
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
        publisher: typeof pkg.publisher?.username === 'string' ? pkg.publisher.username : '',
        score: typeof object?.score?.final === 'number' ? object.score.final : 0,
        npmUrl:
          typeof pkg.links?.npm === 'string'
            ? pkg.links.npm
            : `https://www.npmjs.com/package/${pkg.name ?? ''}`,
      }
    }

    async function fetchSearch(text, size, from, signal) {
      const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}&from=${from}`
      const body = await fetchJson(url, signal)
      const objects = Array.isArray(body?.objects) ? body.objects : []
      return {
        total: typeof body?.total === 'number' ? body.total : objects.length,
        items: objects.map(toItem).filter((item) => item.name !== ''),
      }
    }

    /** npm 搜索接口的硬限制：2..64 个字符，短于 2 直接 400。 */
    const MIN_QUERY = 2
    const MAX_QUERY = 64

    /**
     * 检索 npm 上的 DSH 插件。返回的 `mode` 决定列表上方的说明：
     *   browse —— 空查询，浏览关键词 dsh-plugin（分页）
     *   name   —— 名字里真的包含查询词的 DSH 插件（最靠谱）
     *   text   —— 名字没命中，但描述/关键词提到该词的 DSH 插件
     *   none   —— 全都没命中，交给界面解释「npm 按整词匹配」
     *
     * 两个 npm 的坑（踩过，别再退回单路关键词检索）：
     * 1) `keywords:dsh-plugin <词>` 先把结果集收敛成「全部带该关键词的包」（一万多个），
     *    后面的词几乎不影响排序 —— 具体包常排在 250 名之外，看起来就是搜不出来。
     * 2) 全文检索按「整词」匹配，不做前缀/子串：`qubitclient-dsh-panel` 的名字被
     *    切成 qubitclient / dsh / panel 三个词，所以搜 `qubit` 永远不会命中它 ——
     *    这是 npm registry 的语义，不是本插件能绕过的（`name:` 限定符、`qubit*`
     *    通配符都实测无效）。只能把「没命中」如实说清楚，而不是拿关键词全表充数。
     */
    async function searchRegistry(query, from, signal) {
      if (!query) {
        const page = await fetchSearch(`keywords:${DSH_KEYWORD}`, PAGE_SIZE, from, signal)
        return { total: page.total, items: rankItems(page.items, ''), mode: 'browse' }
      }

      const [plain, scoped] = await Promise.all([
        fetchSearch(query, FULLTEXT_SIZE, 0, signal),
        fetchSearch(`keywords:${DSH_KEYWORD} ${query}`, PAGE_SIZE, 0, signal).catch(() => ({
          total: 0,
          items: [],
        })),
      ])

      const needle = query.toLowerCase()
      const isDshLike = (item) =>
        item.keywords.includes(DSH_KEYWORD) ||
        item.keywords.includes('deepseek-harness') ||
        item.name.toLowerCase().includes('dsh')

      /** 名字真的包含查询词、且看起来是 DSH 插件的那些。 */
      const nameHits = plain.items.filter(
        (item) => item.name.toLowerCase().includes(needle) && isDshLike(item),
      )
      if (nameHits.length > 0) {
        const merged = []
        const seen = new Set()
        for (const item of plain.items.filter((entry) => entry.keywords.includes(DSH_KEYWORD))) {
          if (!seen.has(item.name)) {
            seen.add(item.name)
            merged.push(item)
          }
        }
        for (const item of nameHits) {
          if (!seen.has(item.name)) {
            seen.add(item.name)
            merged.push(item)
          }
        }
        return { total: merged.length, items: rankItems(merged, query), mode: 'name' }
      }

      /** 名字没命中时，退一步找「描述或关键词里提到它」的 DSH 插件。 */
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
     * 名称里出现查询片段的排前面（按出现位置），其余保持 npm 相关性顺序。
     * 这样「输入部分名字」时名字匹配的条目一眼就能看到，同时不丢掉关键词相关的插件。
     */
    function rankItems(items, query) {
      if (!query) return items
      const needle = query.toLowerCase()
      const withRank = items.map((item, index) => {
        const position = item.name.toLowerCase().indexOf(needle)
        return { item, index, position: position < 0 ? Number.POSITIVE_INFINITY : position }
      })
      withRank.sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position
        if (a.item.score !== b.item.score) return b.item.score - a.item.score
        return a.index - b.index
      })
      return withRank.map((entry) => entry.item)
    }

    /**
     * 读取 latest 元信息，判断能不能「一键安装」。
     * 能装的含义是 package.json 声明了 dsh.bundle.patch（组合包），否则装进 profile 也不会成为插件行。
     */
    const metaCache = new Map()

    function probePackage(name) {
      const cached = metaCache.get(name)
      if (cached) return cached
      const timeout = createTimeoutSignal(META_TIMEOUT_MS)
      const promise = (async () => {
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
            error: error instanceof Error ? error.message : String(error),
          }
        } finally {
          timeout.done()
        }
      })()
      metaCache.set(name, promise)
      promise.then((result) => {
        // 失败结果不缓存，下次重新校验；成功结果保留整个会话。
        if (!result.ok) metaCache.delete(name)
      })
      return promise
    }

    // ---- 样式（只用宿主主题 token，明暗自动跟随）--------------------------

    const styles = {
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        maxWidth: '880px',
        padding: '4px 0 32px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      heading: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      searchRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      inputWrap: {
        position: 'relative',
        flex: '1 1 auto',
        display: 'flex',
        alignItems: 'center',
      },
      input: {
        width: '100%',
        padding: '8px 34px 8px 34px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        outline: 'none',
      },
      searchIcon: {
        position: 'absolute',
        left: '12px',
        display: 'flex',
        color: 'var(--dsw-alias-label-secondary)',
        pointerEvents: 'none',
      },
      clearButton: {
        position: 'absolute',
        right: '8px',
        padding: '2px 6px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '16px',
        cursor: 'pointer',
      },
      primaryButton: {
        flex: '0 0 auto',
        padding: '7px 14px',
        borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-button-tool-bar-fill)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        cursor: 'pointer',
      },
      metaLine: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
      },
      dot: { color: 'var(--dsw-alias-border-l2)' },
      list: { display: 'flex', flexDirection: 'column', gap: '10px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 14px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardHead: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' },
      name: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '13px',
        fontWeight: 600,
        wordBreak: 'break-all',
      },
      version: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      },
      badge: {
        padding: '0 6px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '18px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      badgeOk: {
        padding: '0 6px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '18px',
        border: '1px solid var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      /** 校验失败时可点的徽标：让「读取失败」不是死路，点一下重新读。 */
      badgeRetry: {
        padding: '0 6px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '18px',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
        background: 'transparent',
        font: 'inherit',
        cursor: 'pointer',
      },
      description: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      cardFoot: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '10px',
        marginTop: '2px',
      },
      footMeta: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        flex: '1 1 auto',
        minWidth: 0,
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', flex: '0 0 auto' },
      link: {
        color: 'var(--dsw-alias-link)',
        fontSize: '12px',
        textDecoration: 'none',
      },
      installButton: {
        padding: '4px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-button-tool-bar-fill)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      disabledButton: {
        padding: '4px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'not-allowed',
        opacity: 0.7,
      },
      started: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      failure: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '14px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      failureText: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '28px 14px',
        alignItems: 'center',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
      },
      skeleton: {
        height: '76px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        opacity: 0.55,
      },
      moreRow: { display: 'flex', justifyContent: 'center', paddingTop: '2px' },
      moreButton: {
        padding: '6px 16px',
        borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      code: {
        padding: '1px 5px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-markdown-inline-code)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '11px',
      },
    }

    // ---- 小组件 ------------------------------------------------------------

    function SearchGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: 15, height: 15, 'aria-hidden': true },
        h('circle', { cx: 8.6, cy: 8.6, r: 5.2, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' }),
        h('path', {
          d: 'M12.6 12.6 17 17',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    function formatDate(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date)
      } catch (_error) {
        return date.toISOString().slice(0, 10)
      }
    }

    function Badge(props) {
      return h(
        'span',
        { style: props.good ? styles.badgeOk : styles.badge, title: props.title },
        props.children,
      )
    }

    /**
     * 一条搜索结果。
     *
     * 元信息是「按需校验」的：首屏前若干条由父组件直接校验，其余等卡片滚进视口
     * 才发请求（IntersectionObserver）。所以这里有第三种状态：还没轮到校验。
     */
    function ResultCard(props) {
      const { item, meta, probing, started, onInstall, onRetry, onVisible } = props
      const version = (meta && meta.version) || item.version
      const checking = meta === undefined
      const nodeRef = React.useRef(null)
      const probeFailed = Boolean(meta && !meta.ok)
      const knownNotBundle = Boolean(meta && meta.ok && !meta.installable)

      // 没校验过的卡片，进入视口（提前 200px）才请求元信息，读完就断开观察。
      React.useEffect(() => {
        if (meta !== undefined || !onVisible) return undefined
        const node = nodeRef.current
        if (!node || typeof IntersectionObserver === 'undefined') {
          onVisible(item.name)
          return undefined
        }
        const observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer.disconnect()
              onVisible(item.name)
            }
          },
          { rootMargin: '200px' },
        )
        observer.observe(node)
        return () => observer.disconnect()
      }, [meta, item.name, onVisible])

      const flags = []
      if (checking) {
        flags.push(
          probing
            ? h(
                Badge,
                { key: 'checking', title: '本插件（搜索插件自己）正在读取 npm 元信息：GET registry.npmjs.org/<包名>/latest，确认它有没有声明 dsh.bundle.patch' },
                '校验中…',
              )
            : h(
                Badge,
                { key: 'waiting', title: '滚到这里才开始校验（首屏只校验前几条，省请求）' },
                '待校验',
              ),
        )
      } else if (meta && meta.ok) {
        flags.push(
          h(
            Badge,
            { key: 'bundle', good: meta.installable },
            meta.installable ? '组合包 · 可安装' : '非组合包',
          ),
        )
        if (meta.hasClient) flags.push(h(Badge, { key: 'client' }, '含界面'))
        if (meta.deprecated) flags.push(h(Badge, { key: 'deprecated' }, '已弃用'))
      } else {
        flags.push(
          h(
            'button',
            {
              key: 'unknown',
              type: 'button',
              style: styles.badgeRetry,
              title: `读取 npm 元信息失败：${meta.error || '未知原因'}。点击重试（装不装得上由安装对话框自己再校验一次）`,
              onClick: () => onRetry(item.name),
            },
            '元信息读取失败 · 重试',
          ),
        )
      }

      const published = formatDate(item.date)
      const keywordText = item.keywords
        .filter((keyword) => keyword !== 'dsh' && keyword !== DSH_KEYWORD && keyword !== 'deepseek-harness')
        .slice(0, 3)
        .join(' · ')

      return h(
        'div',
        { ref: nodeRef, style: styles.card, 'data-plugin-search-result': item.name },
        h(
          'div',
          { style: styles.cardHead },
          h('span', { style: styles.name }, item.name),
          version ? h('span', { style: styles.version }, `v${version}`) : null,
          ...flags,
        ),
        h('p', { style: styles.description }, item.description || '（这个包没有写 description）'),
        h(
          'div',
          { style: styles.cardFoot },
          h(
            'div',
            { style: styles.footMeta },
            item.publisher ? h('span', null, item.publisher) : null,
            published ? h('span', { style: styles.dot }, '·') : null,
            published ? h('span', null, published) : null,
            keywordText ? h('span', { style: styles.dot }, '·') : null,
            keywordText ? h('span', null, keywordText) : null,
          ),
          h(
            'div',
            { style: styles.actions },
            h(
              'a',
              {
                style: styles.link,
                href: item.npmUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: '在 npm 上打开',
              },
              'npm ↗',
            ),
            started
              ? h('span', { style: styles.started }, '已打开安装对话框')
              : knownNotBundle
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: styles.disabledButton,
                      disabled: true,
                      title: '这个包没有声明 dsh.bundle.patch，装进 profile 也不会成为插件行',
                    },
                    '不可安装',
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      style: styles.installButton,
                      onClick: () => onInstall(item),
                      title: probeFailed
                        ? '元信息没读到，仍可打开安装对话框；安装前的校验由插件页自己做'
                        : '打开插件页内置的安装对话框',
                    },
                    '安装',
                  ),
          ),
        ),
      )
    }

    // ---- 标签页正文 --------------------------------------------------------

    function PluginSearchTab(props) {
      const install = typeof props.install === 'function' ? props.install : null

      const [draft, setDraft] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [items, setItems] = React.useState([])
      const [metaByName, setMetaByName] = React.useState({})
      const [probingByName, setProbingByName] = React.useState({})
      const [total, setTotal] = React.useState(0)
      const [mode, setMode] = React.useState('browse')
      const [phase, setPhase] = React.useState('loading') // loading | ready | error
      const [error, setError] = React.useState('')
      const [loadingMore, setLoadingMore] = React.useState(false)
      const [started, setStarted] = React.useState({})

      const mountedRef = React.useRef(true)
      const abortRef = React.useRef(null)
      const seqRef = React.useRef(0)

      React.useEffect(
        () => () => {
          mountedRef.current = false
          if (abortRef.current) abortRef.current.abort()
        },
        [],
      )

      /** 校验一批结果的 metadata；失败的由 probePackage 自己吃掉，不阻塞列表。 */
      const hydrateMeta = React.useCallback((names) => {
        const pending = names.filter((name) => !metaCache.has(name))
        if (pending.length === 0) return
        setProbingByName((previous) => {
          const next = { ...previous }
          for (const name of pending) next[name] = true
          return next
        })
        const settle = (name) => {
          if (!mountedRef.current) return
          setProbingByName((previous) => {
            if (!previous[name]) return previous
            const next = { ...previous }
            delete next[name]
            return next
          })
        }
        mapLimit(pending, META_CONCURRENCY, async (name) => {
          const meta = await probePackage(name)
          if (!mountedRef.current) return
          setMetaByName((previous) =>
            previous[name] ? previous : { ...previous, [name]: meta },
          )
          settle(name)
        }).catch(() => {
          /* 单条失败不影响整体 */
        })
      }, [])

      /** 卡片滚进视口时的按需校验（同一个函数，只是每次一条）。 */
      const hydrateOne = React.useCallback((name) => hydrateMeta([name]), [hydrateMeta])

      /** 手动重试某个包的元信息校验（徽标点一下就重来）。 */
      const retryMeta = React.useCallback(async (name) => {
        metaCache.delete(name)
        setMetaByName((previous) => {
          const next = { ...previous }
          delete next[name]
          return next
        })
        setProbingByName((previous) => ({ ...previous, [name]: true }))
        const meta = await probePackage(name)
        if (!mountedRef.current) return
        setMetaByName((previous) => ({ ...previous, [name]: meta }))
        setProbingByName((previous) => {
          const next = { ...previous }
          delete next[name]
          return next
        })
      }, [])

      const load = React.useCallback(
        async (nextQuery, from, append) => {
          if (abortRef.current) abortRef.current.abort()
          const controller = new AbortController()
          abortRef.current = controller
          const seq = seqRef.current + 1
          seqRef.current = seq

          // npm 搜索接口要求 2..64 个字符，短于 2 会直接 400；本地先拦住。
          if (nextQuery.length === 1) {
            setItems([])
            setTotal(0)
            setMode('short')
            setPhase('ready')
            setError('')
            setLoadingMore(false)
            return
          }

          if (append) setLoadingMore(true)
          else {
            setPhase('loading')
            setError('')
          }
          try {
            const result = await searchRegistry(nextQuery.slice(0, MAX_QUERY), from, controller.signal)
            if (!mountedRef.current || seq !== seqRef.current) return
            setTotal(result.total)
            setMode(result.mode)
            setItems((previous) => {
              if (!append) return result.items
              const seen = new Set(previous.map((item) => item.name))
              return previous.concat(result.items.filter((item) => !seen.has(item.name)))
            })
            setPhase('ready')
            // 只自动校验首屏前几条；其余卡片滚进视口时再各自校验。
            hydrateMeta(result.items.slice(0, EAGER_PROBE).map((item) => item.name))
          } catch (caught) {
            if (!mountedRef.current || seq !== seqRef.current) return
            if (caught && caught.name === 'AbortError') return
            setTotal(0)
            setItems([])
            setPhase('error')
            setError(caught instanceof Error ? caught.message : String(caught))
          } finally {
            if (mountedRef.current && seq === seqRef.current) setLoadingMore(false)
          }
        },
        [hydrateMeta],
      )

      // 输入防抖：停止输入 350ms 后把草稿提交成查询。
      React.useEffect(() => {
        const trimmed = draft.trim()
        if (trimmed === query) return undefined
        const timer = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [draft, query])

      // 查询变化（包括首次挂载的空查询）触发一次新的检索。
      React.useEffect(() => {
        void load(query, 0, false)
        return () => {
          if (abortRef.current) abortRef.current.abort()
        }
      }, [query, load])

      const submitDraft = () => setQuery(draft.trim())

      const startInstall = (item) => {
        const meta = metaByName[item.name]
        const version = (meta && meta.version) || item.version
        if (!install) {
          setPhase('error')
          setError('当前插件页没有提供 install()，无法打开安装对话框。')
          return
        }
        try {
          install({
            spec: version ? `${item.name}@${version}` : item.name,
            title: item.name,
            version,
          })
          setStarted((previous) => ({ ...previous, [item.name]: true }))
        } catch (caught) {
          setPhase('error')
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }

      const retry = () => void load(query, 0, false)
      const loadMore = () => void load(query, items.length, true)

      const heading = h(
        'div',
        { style: styles.heading },
        h('h2', { style: styles.title }, '搜索插件'),
        h(
          'p',
          { style: styles.hint },
          '输入插件名字的一部分（比如 ',
          h('code', { style: styles.code }, 'pet'),
          ' 或 ',
          h('code', { style: styles.code }, 'cost'),
          '），在 npm 上检索 DSH 插件；点「安装」直接走插件页内置的安装流程。',
        ),
        h(
          'p',
          { style: styles.hint },
          '「校验中」是本插件在读取 npm 元信息（GET registry.npmjs.org/<包名>/latest），',
          '确认这个包有没有声明 dsh.bundle.patch；首屏只自动校验前 ',
          String(EAGER_PROBE),
          ' 条，其余滚到可见处再校验。读不到就显示「元信息读取失败」，点一下重试，安装按钮照常可用。',
        ),
      )

      const searchRow = h(
        'div',
        { style: styles.searchRow },
        h(
          'div',
          { style: styles.inputWrap },
          h('span', { style: styles.searchIcon }, h(SearchGlyph)),
          h('input', {
            style: styles.input,
            value: draft,
            type: 'search',
            spellCheck: false,
            placeholder: '输入插件名片段，例如 pet、cost、wallpaper',
            'aria-label': '插件名片段',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submitDraft()
              if (event.key === 'Escape') setDraft('')
            },
          }),
          draft
            ? h(
                'button',
                {
                  type: 'button',
                  style: styles.clearButton,
                  title: '清空',
                  onClick: () => setDraft(''),
                },
                '×',
              )
            : null,
        ),
        h('button', { type: 'button', style: styles.primaryButton, onClick: submitDraft }, '搜索'),
      )

      const countLabel =
        mode === 'browse'
          ? `npm 共 ${total} 个 DSH 插件（关键词 ${DSH_KEYWORD}）`
          : mode === 'short'
            ? '至少输入 2 个字符'
            : mode === 'name'
              ? `名字包含「${query}」的 DSH 插件 ${total} 个`
              : mode === 'text'
                ? `名称没命中「${query}」，下面是描述/关键词提到它的 ${total} 个插件`
                : `没有 DSH 插件匹配「${query}」`

      const metaLine = h(
        'div',
        { style: styles.metaLine },
        h('span', null, query ? `按名字检索「${query}」` : '按 npm 相关度排序'),
        h('span', { style: styles.dot }, '·'),
        h('span', null, phase === 'loading' ? '正在检索 npm…' : countLabel),
        h('span', { style: styles.dot }, '·'),
        h('span', null, '数据来自 npm 公共 registry'),
      )

      let body
      if (phase === 'error') {
        body = h(
          'div',
          { style: styles.failure },
          h('p', { style: styles.failureText }, `检索失败：${error}`),
          h(
            'div',
            null,
            h('button', { type: 'button', style: styles.moreButton, onClick: retry }, '重试'),
          ),
        )
      } else if (phase === 'loading' && items.length === 0) {
        body = h(
          'div',
          { style: styles.list },
          h('div', { style: styles.skeleton }),
          h('div', { style: styles.skeleton }),
          h('div', { style: styles.skeleton }),
        )
      } else if (items.length === 0) {
        const hint =
          mode === 'short'
            ? 'npm 搜索接口要求至少 2 个字符，多打一个字就行。'
            : mode === 'none'
              ? 'npm 的搜索按整词匹配，不做前缀/子串匹配：包名 qubitclient-dsh-panel 被切成 qubitclient / dsh / panel，所以搜「qubit」不会命中它。请换成更完整的名字片段（例如 qubitclient）。'
              : '换个名字片段试试，例如 pet、cost、wallpaper。'
        body = h(
          'div',
          { style: styles.empty },
          h('p', { style: { margin: 0, fontWeight: 600 } }, '没有找到匹配的插件'),
          h('p', { style: { margin: 0 } }, hint),
        )
      } else {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { style: styles.list },
            items.map((item) =>
              h(ResultCard, {
                key: item.name,
                item,
                meta: metaByName[item.name],
                probing: Boolean(probingByName[item.name]),
                started: Boolean(started[item.name]),
                onInstall: startInstall,
                onRetry: retryMeta,
                onVisible: hydrateOne,
              }),
            ),
          ),
          total > items.length
            ? h(
                'div',
                { style: styles.moreRow },
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.moreButton,
                    disabled: loadingMore,
                    onClick: loadMore,
                  },
                  loadingMore ? '加载中…' : '加载更多',
                ),
              )
            : null,
        )
      }

      return h(
        'div',
        { style: styles.section, 'data-plugin-search': 'root' },
        heading,
        searchRow,
        metaLine,
        body,
      )
    }

    return {
      // slots: 往插槽里塞 UI。
      inject: ['slots'],
      /**
       * 注册到「插件」页的 `plugins.tab`（list slot）。
       * 条目一出现，页面会在「已安装」「发现」之后多出一个「搜索」标签页。
       */
      apply(ctx) {
        ctx.slots.inject('plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'plugins.tab',
              id: 'plugin-search',
              order: 30,
              label: () => '搜索',
            },
            PluginSearchTab,
          ),
        )
      },
    }
  },
})
