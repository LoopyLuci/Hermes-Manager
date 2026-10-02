#!/usr/bin/env node
// Install (or remove, with --remove) the pre-push hook that runs the local CI/CD pipeline on every `git push`.
// Push without it once (an emergency): `git push --no-verify`, or set HM_SKIP_PIPELINE=1.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MARK = '# hermes-manager local pipeline'
const HOOK = `#!/bin/sh
${MARK}
if [ "$HM_SKIP_PIPELINE" = "1" ]; then
  echo "HM_SKIP_PIPELINE=1: skipping the local pipeline"
  exit 0
fi
ROOT="$(git rev-parse --show-toplevel)"
HM_PIPELINE_HOOK=1 exec node "$ROOT/scripts/pipeline.mjs"
`
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const hooks = path.resolve(
  root,
  execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim(),
)
const file = path.join(hooks, 'pre-push')

if (process.argv.includes('--remove')) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK)) {
    fs.unlinkSync(file)
    console.log(`removed ${file}`)
  } else console.log('no pipeline hook installed')
  process.exit(0)
}
if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARK)) {
  fs.renameSync(file, file + '.before-pipeline')
  console.log(`kept the existing pre-push hook as ${file}.before-pipeline`)
}
fs.mkdirSync(hooks, { recursive: true })
fs.writeFileSync(file, HOOK, { mode: 0o755 })
console.log(`installed ${file}: every \`git push\` now runs scripts/pipeline.mjs first`)
