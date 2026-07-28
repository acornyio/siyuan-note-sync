// 用法: npx tsx scripts/render-banner.mjs   （或 node，需先 npx playwright install chrome）
// 把 scripts/banner.html 渲染成集市详情页要的 preview.png（严格 1024×768）。
//
// 用 headed 的本机 Chrome（channel: 'chrome'）：AGENTS.md 要求凡涉及像素/布局/截图的产出
// 一律用真实浏览器，headless Chromium 的渲染路径与字体回退和真实环境不同。
// 图里的中文依赖系统字体（Microsoft YaHei / PingFang SC），换机器渲染前先确认字体在。
import { createRequire } from 'node:module'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// playwright 不是本仓库的依赖（只为出图用一次，不值得进 package.json）。
// 默认按常规解析；解析不到时用 PLAYWRIGHT_DIR 指向任意一份已安装的 node_modules，例如：
//   PLAYWRIGHT_DIR=~/AppData/Local/npm-cache/_npx/<hash>/node_modules node scripts/render-banner.mjs
function loadChromium() {
  const dir = process.env.PLAYWRIGHT_DIR
  const require = createRequire(dir ? path.join(dir, 'noop.js') : import.meta.url)
  return require('playwright').chromium
}
const chromium = loadChromium()

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDTH = 1024
const HEIGHT = 768
const MAX_BYTES = 200 * 1024 // 集市对 preview.png 的体积上限

// 图标以 data URI 内联：file:// 页面加载同目录图片会被 Chrome 拦，内联最稳。
const icon = await readFile(path.join(root, 'icon.png'))
const html = (await readFile(path.join(root, 'scripts/banner.html'), 'utf8'))
  .replace('{{ICON}}', `data:image/png;base64,${icon.toString('base64')}`)

const tmp = path.join(root, 'scripts/.banner.rendered.html')
await writeFile(tmp, html, 'utf8')

const browser = await chromium.launch({ channel: 'chrome', headless: false })
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1, // 必须为 1，否则截图尺寸会翻倍，集市校验不过
  })
  await page.goto(`file://${tmp.replace(/\\/g, '/')}`)
  await page.waitForLoadState('networkidle')
  const out = path.join(root, 'preview.png')
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })

  const size = (await readFile(out)).length
  console.log(`preview.png 已生成: ${WIDTH}x${HEIGHT}, ${size} bytes`)
  if (size > MAX_BYTES) {
    console.error(`❌ 超过集市上限 ${MAX_BYTES} bytes，需要压缩后再发版`)
    process.exitCode = 1
  }
} finally {
  await browser.close()
  await unlink(tmp).catch(() => {})
}
