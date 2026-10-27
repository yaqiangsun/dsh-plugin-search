// 不安装、不重启就能做的自检：清单 / exports / locale / patch 形状 / Host 半 / Client 半插槽注册。
// 用法: node scripts/check-search-plugin.mjs [插件目录] [--network]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(here, '..'))
const network = process.argv.includes('--network')
const fail = []
const ok = (msg) => console.log(`  ok   ${msg}`)
const bad = (msg) => {
  fail.push(msg)
  console.log(`  FAIL ${msg}`)
}

console.log(`检查插件目录: ${pkgDir}`)

// ---- 1. 清单 -------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
for (const key of ['name', 'version', 'type', 'exports']) {
  manifest[key] ? ok(`package.json 有 ${key}`) : bad(`package.json 缺少 ${key}`)
}
manifest.type === 'module' || bad('package.json 的 type 应为 module')
const bundle = manifest.dsh?.bundle?.patch
bundle ? ok(`声明了 bundle patch: ${bundle}`) : bad('package.json 缺少 dsh.bundle.patch')
const client = manifest.dsh?.client
client ? ok(`声明了 client 半: platform=${client.platform}`) : bad('package.json 缺少 dsh.client')
manifest.keywords?.includes('dsh-plugin') ? ok('keywords 含 dsh-plugin（方便 npm 检索）') : bad('keywords 缺少 dsh-plugin')

// ---- 2. exports 与 files 指向的文件 --------------------------------------
for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
  if (subpath.includes('*')) continue
  const abs = path.join(pkgDir, target)
  fs.existsSync(abs) ? ok(`export ${subpath} -> ${target} 存在`) : bad(`export ${subpath} -> ${target} 不存在`)
}
if (bundle && fs.existsSync(path.join(pkgDir, bundle))) ok(`patch 文件存在: ${bundle}`)
else if (bundle) bad(`patch 文件不存在: ${bundle}`)

// ---- 3. locale -----------------------------------------------------------
const localeDir = path.join(pkgDir, 'locale')
if (fs.existsSync(localeDir)) {
  for (const file of fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'))
    doc.meta?.title && doc.meta?.description
      ? ok(`locale/${file} 有 meta.title / meta.description`)
      : bad(`locale/${file} 缺少 meta.title 或 meta.description`)
  }
} else {
  bad('缺少 locale/ 目录（插件列表会退回包名和默认图标）')
}
fs.existsSync(path.join(pkgDir, 'icon.svg')) ? ok('icon.svg 存在') : bad('缺少 icon.svg')

// ---- 4. patch 形状（手写解析，不依赖 js-yaml） ---------------------------
if (bundle) {
  const text = fs.readFileSync(path.join(pkgDir, bundle), 'utf8')
  const hasInsert = /^\s*-\s*insert:/m.test(text)
  const hasId = /^\s+-\s+id:/m.test(text)
  const hasName = new RegExp(`^\\s+name:\\s*${manifest.name}\\s*$`, 'm').test(text)
  hasInsert && hasId && hasName
    ? ok('patch 是 - insert: [{id, name}] 形状且包名一致')
    : bad('patch 不是 - insert: [{id, name}] 形状，或 name 与包名不一致')
}

// ---- 5. Host 半：import 后能拿到 apply --------------------------------
const hostModule = await import(
  pathToFileURL(path.join(pkgDir, manifest.exports['.'] ?? './index.js')).href
)
typeof hostModule.apply === 'function' ? ok('Host 半导出 apply(ctx)') : bad('Host 半没有导出 apply(ctx)')
if (Array.isArray(hostModule.inject)) ok(`Host 半 inject: ${hostModule.inject.join(', ')}`)
else bad('Host 半缺少 inject 数组')

const registered = []
let packageSchema
const fakeCtx = {
  tools: { register: (def) => registered.push(def) },
  effect: (fn) => fn(),
  on: () => () => {},
}
try {
  hostModule.apply(fakeCtx, {})
  ok(`Host 半 apply() 执行通过，注册了 ${registered.length} 个工具: ${registered.map((t) => t.name).join(', ') || '(无)'}`)
  for (const def of registered) {
    def.name && def.description && def.parameters && def.output?.render
      ? ok(`工具 ${def.name} 形状完整（name/description/parameters/output.render）`)
      : bad(`工具 ${def.name ?? '?'} 形状不完整`)
  }
  packageSchema = registered[0]?.output?.schema?.properties?.packages?.items
  for (const field of ['downloadsWeekly', 'downloadsMonthly']) {
    packageSchema?.properties?.[field]
      ? ok(`工具输出 schema 有 ${field}`)
      : bad(`工具输出 schema 缺少 ${field}`)
    packageSchema?.required?.includes(field)
      ? ok(`工具输出 required 含 ${field}`)
      : bad(`工具输出 required 缺少 ${field}`)
  }
} catch (error) {
  bad(`Host 半 apply() 抛错: ${error.message}`)
}

// ---- 6. Client 半：在假窗口里跑一次插槽注册 ---------------------------
const clientTarget = manifest.dsh?.client ? manifest.exports['./client'] : undefined
if (clientTarget) {
  const source = fs.readFileSync(path.join(pkgDir, clientTarget), 'utf8')
  source.includes('downloadsWeekly') && source.includes('周下载')
    ? ok('client 半有周下载量渲染')
    : bad('client 半缺少周下载量渲染')
  let loaded
  const noop = () => {}
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, noop],
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
    useEffect: () => undefined,
  }
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded = { id, factory }
      },
    },
  }
  const sandbox = { window, console, setTimeout, clearTimeout, AbortController, fetch }
  vm.runInNewContext(source, sandbox, { filename: clientTarget })
  if (!loaded) {
    bad('client.js 没有调用 window.__ModuleLoader__.load')
  } else {
    loaded.id === manifest.name
      ? ok(`client 模块 id 与包名一致: ${loaded.id}`)
      : bad(`client 模块 id (${loaded.id}) 应等于包名 (${manifest.name})`)
    const registrations = []
    const ctx = {
      slots: {
        inject: (ownerKey, factory) => {
          registrations.push({ ownerKey, entry: factory() })
        },
        register: (options, Component) => ({ options, Component }),
      },
    }
    try {
      const plugin = loaded.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require(${name})`)
      })
      plugin.inject?.includes('slots') || bad("client 插件没有声明 inject: ['slots']")
      plugin.apply(ctx)
      if (registrations.length === 0) bad('client apply() 没有调用 ctx.slots.inject')
      const hit = registrations.find((r) => r.ownerKey === 'plugins.tab')
      if (!hit) {
        bad("client 没有注册到 'plugins.tab'（插件页标签页）")
      } else {
        hit.entry.options.name === 'plugins.tab'
          ? ok("inject 的 ownerKey 与 register 的 name 一致（plugins.tab）")
          : bad('inject 的 ownerKey 与 register 的 name 不一致')
        typeof hit.entry.Component === 'function' ? ok('注册项带有组件函数') : bad('注册项没有组件函数')
        typeof hit.entry.options.label === 'function'
          ? ok(`标签页 label 是函数：${hit.entry.options.label()}`)
          : bad('注册项缺少 label（标签页没有名字）')
        hit.entry.options.id ? ok(`标签页 id: ${hit.entry.options.id}`) : bad('注册项缺少 id')
        let tree
        try {
          tree = hit.entry.Component({ install() {}, openPackage() {} })
          tree ? ok('组件函数可渲染，无异常') : bad('组件函数返回空')
        } catch (error) {
          bad(`组件渲染抛错: ${error.message}`)
        }
        // 用假 React 的树形结构找关键控件：搜索框 / 搜索按钮 / 标题
        const texts = []
        const walk = (node) => {
          if (node === null || node === undefined || typeof node === 'boolean') return
          if (typeof node === 'string') {
            texts.push(node)
            return
          }
          if (Array.isArray(node)) return node.forEach(walk)
          if (typeof node !== 'object') return
          if (node.props && typeof node.props === 'object') {
            if (node.props.placeholder) texts.push(`placeholder:${node.props.placeholder}`)
            if (node.props['data-plugin-search-result']) texts.push(`result:${node.props['data-plugin-search-result']}`)
          }
          walk(node.children)
        }
        walk(tree)
        const hasSearchInput = texts.some((text) => String(text).startsWith('placeholder:'))
        const hasSearchTitle = texts.includes('搜索插件')
        hasSearchInput ? ok('渲染树里有搜索输入框') : bad('渲染树里没有搜索输入框')
        hasSearchTitle ? ok('渲染树里有「搜索插件」标题') : bad('渲染树里没有标题')
      }
    } catch (error) {
      bad(`client 半执行抛错: ${error.message}`)
    }
  }
}

// ---- 7. 可选：真网络验证 npm 检索 ---------------------------------------
if (network) {
  const tool = registered[0]
  if (!tool) {
    bad('没有可用的 Host 工具，跳过网络验证')
  } else {
    try {
      const result = await tool.execute({ query: 'pet', limit: 3 })
      result.ok || bad(`Host 工具执行失败: ${result.error}`)
      result.ok && ok(`Host 工具网络检索可用：total=${result.total}，返回 ${result.packages.length} 个包`)
      const required = packageSchema?.required ?? []
      for (const pkg of result.packages) {
        const missing = required.filter((key) => !(key in pkg))
        ok(
          `  ${pkg.name}@${pkg.version} installable=${pkg.installable} hasClient=${pkg.hasClient} ` +
            `周下载=${pkg.downloadsWeekly} 月下载=${pkg.downloadsMonthly}`,
        )
        typeof pkg.downloadsWeekly === 'number' && typeof pkg.downloadsMonthly === 'number'
          ? ok(`  ${pkg.name} 下载量字段是数字`)
          : bad(`  ${pkg.name} 下载量字段不是数字`)
        missing.length === 0
          ? ok(`  ${pkg.name} 输出含 schema 要求的全部字段`)
          : bad(`  ${pkg.name} 输出缺少字段: ${missing.join(', ')}`)
      }
    } catch (error) {
      bad(`Host 工具网络验证抛错: ${error.message}`)
    }
  }
}

console.log(fail.length === 0 ? '\n全部检查通过 ✅' : `\n${fail.length} 项未通过 ❌`)
process.exit(fail.length === 0 ? 0 : 1)
