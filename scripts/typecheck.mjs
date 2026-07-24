// Typecheck gate that scopes failures to OUR src/.
//
// Why this exists: siyuan@1.2.2 ships its type surface as `.ts` source (not `.d.ts`),
// and under our TypeScript version those files have a latent internal inconsistency
// (`types/constants.ts`: `foldRecursive` missing on IKeymapEditorGeneral). That error
// lives in node_modules — it is the SDK's bug, not ours — and `skipLibCheck` cannot
// suppress it because it targets `.d.ts` only. A raw `tsc --noEmit` therefore always
// fails, drowning real errors. This gate runs tsc, ignores node_modules-origin errors,
// and fails only when there is a type error under src/.
import { spawnSync } from 'node:child_process'

const r = spawnSync('tsc', ['--noEmit', '--pretty', 'false'], { encoding: 'utf8', shell: true })

// tsc 进程本身没跑起来（未安装 / 启动失败）→ 直接失败，别误报成功。
if (r.error) {
  console.error('failed to run tsc:', r.error.message)
  process.exit(1)
}

const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
const errorLines = output.split('\n').filter((l) => /: error TS\d+/.test(l))

// tsc 退出非 0 却一条诊断都没有 → 配置错 / 崩溃等非诊断失败，不能当通过。
if (r.status !== 0 && errorLines.length === 0) {
  console.error(output.trim() || `tsc exited with status ${r.status} and no diagnostics`)
  process.exit(1)
}

const sdkErrors = errorLines.filter((l) => /node_modules/.test(l))
// node_modules 之外的一切错误（src/ 里的、或无路径的配置错）都算我们的，必须失败。
const ourErrors = errorLines.filter((l) => !/node_modules/.test(l))

if (ourErrors.length > 0) {
  console.error(ourErrors.join('\n'))
  console.error(`\n${ourErrors.length} type error(s) outside node_modules.`)
  process.exit(1)
}

console.log(`typecheck OK — no errors outside node_modules (${sdkErrors.length} tolerated SDK-internal error(s))`)
