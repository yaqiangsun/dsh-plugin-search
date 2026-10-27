// 不安装、不重启就能做的插件自检。
// 用法: node scripts/check-plugin.mjs [插件目录]
// 检查项: package.json 必备字段 / exports 指向的文件存在 / locale 是合法 JSON /
//         cordis.patch.yml 形状 / client.js 能在假宿主里完成一次插槽注册。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(process.argv[2] ?? path.join(here, '..'))
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

// ---- 4. patch 形状（手写解析，不依赖 js-yaml） ---------------------------
if (bundle) {
  const text = fs.readFileSync(path.join(pkgDir, bundle), 'utf8')
  const hasInsert = /^\s*-\s*insert:/m.test(text)
  const hasId = /^\s+-\s+id:/m.test(text)
  const hasName = /^\s+name:/m.test(text)
  hasInsert && hasId && hasName ? ok('patch 看起来是 - insert: [{id, name}] 形状') : bad('patch 不是 - insert: [{id, name}] 形状')
}

// ---- 5. Host 半：import 后能拿到 apply --------------------------------
const hostModule = await import(
  pathToFileURL(path.join(pkgDir, manifest.exports['.'] ?? './index.js')).href
)
typeof hostModule.apply === 'function' ? ok('Host 半导出 apply(ctx)') : bad('Host 半没有导出 apply(ctx)')
if (Array.isArray(hostModule.inject)) ok(`Host 半 inject: ${hostModule.inject.join(', ')}`)

// 用假 ctx 跑一遍 apply，看看它注册了什么
const registered = []
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
} catch (error) {
  bad(`Host 半 apply() 抛错: ${error.message}`)
}

// ---- 6. Client 半：在假窗口里跑一次插槽注册 ---------------------------
const clientTarget = manifest.dsh?.client ? manifest.exports['./client'] : undefined
if (clientTarget) {
  const source = fs.readFileSync(path.join(pkgDir, clientTarget), 'utf8')
  let loaded
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useReducer: (reducer, initial) => [initial, () => {}],
    useId: () => 'id',
    createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', value }),
    useContext: (context) => context?.value,
    forwardRef: (render) => render,
    memo: (component) => component,
  }
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded = { id, factory }
      },
    },
  }
  const sandbox = { window, console }
  vm.runInNewContext(source, sandbox, { filename: clientTarget })
  if (!loaded) {
    bad('client.js 没有调用 window.__ModuleLoader__.load')
  } else {
    loaded.id === manifest.name
      ? ok(`client 模块 id 与包名一致: ${loaded.id}`)
      : bad(`client 模块 id (${loaded.id}) 应等于包名 (${manifest.name})`)
    const registrations = []
    const tabTypes = []
    const disposers = []
    const ctx = {
      slots: {
        inject: (ownerKey, factory) => {
          registrations.push({ ownerKey, entry: factory() })
        },
        register: (options, Component) => ({ options, Component }),
      },
      // 右侧栏 tab 类型注册表
      sidebarRightTabs: {
        register: (definition) => {
          tabTypes.push(definition)
          return () => {}
        },
      },
      effect: (fn) => {
        const disposer = fn()
        disposers.push(disposer)
        return disposer
      },
    }
    try {
      const plugin = loaded.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require(${name})`)
      })
      plugin.inject?.includes('slots') || bad('client 插件没有声明 inject: [\'slots\']')
      plugin.apply(ctx)
      if (registrations.length === 0) bad('client apply() 没有调用 ctx.slots.inject')
      for (const hit of registrations) {
        ok(`client 注册到插槽 ${hit.ownerKey}，id/key=${hit.entry.options.id ?? hit.entry.options.key}`)
        hit.ownerKey === hit.entry.options.name
          ? ok('inject 的 ownerKey 与 register 的 name 一致')
          : bad('inject 的 ownerKey 与 register 的 name 不一致')
        typeof hit.entry.Component === 'function' ? ok('注册项带有组件函数') : bad('注册项没有组件函数')
        // 组件能渲染一次（假 React，只验证不抛错）
        const tree = hit.entry.Component({})
        tree ? ok('组件函数可渲染，无异常') : bad('组件函数返回空')
      }
      if (tabTypes.length > 0) {
        for (const def of tabTypes) {
          def.id && def.kind && typeof def.title === 'function'
            ? ok(`右侧栏 tab 类型: kind=${def.kind} id=${def.id}`)
            : bad('右侧栏 tab 类型缺少 id/kind/title')
          const guide = def.guide?.[0]
          guide ? ok(`引导页入口: ${guide.id}（order=${guide.order}）`) : bad('tab 类型没有 guide 入口，用户点不进去')
          const body = registrations.find((r) => r.ownerKey === 'sidebar.right.pane.tab')
          body && body.entry.options.key === def.id
            ? ok('sidebar.right.pane.tab 的 key 与 tab 类型 id 一致')
            : bad('sidebar.right.pane.tab 的 key 必须等于 tab 类型 id')
          guide?.icon && (typeof guide.icon === 'function' ? ok('引导页入口带图标组件') : bad('guide.icon 应是组件'))
        }
      }
    } catch (error) {
      bad(`client 半执行抛错: ${error.message}`)
    }
  }
}

console.log(fail.length === 0 ? '\n全部检查通过 ✅' : `\n${fail.length} 项未通过 ❌`)
process.exit(fail.length === 0 ? 0 : 1)
