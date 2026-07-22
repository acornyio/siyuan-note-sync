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
const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
const errorLines = output.split('\n').filter((l) => /: error TS\d+/.test(l))

const srcErrors = errorLines.filter((l) => /(^|[\\/])src[\\/]/.test(l))
const sdkErrors = errorLines.filter((l) => /node_modules/.test(l))

if (srcErrors.length > 0) {
  console.error(srcErrors.join('\n'))
  console.error(`\n${srcErrors.length} type error(s) in src/.`)
  process.exit(1)
}

console.log(`typecheck OK — src/ clean (${sdkErrors.length} tolerated SDK-internal error(s) in node_modules)`)
