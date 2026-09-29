#!/usr/bin/env node
// Hermes Manager's local, on-device CI/CD pipeline. Everything runs on this machine; no cloud runner.
//
//   node scripts/pipeline.mjs              everything this change needs
//   node scripts/pipeline.mjs --full       every stage regardless of what changed (includes e2e and packaging)
//   node scripts/pipeline.mjs --fast       preflight, static checks and unit tests only
//   node scripts/pipeline.mjs --only X     one or more stages (repeat --only)
//   node scripts/pipeline.mjs --list       the plan for this change
//   node scripts/pipeline.mjs --no-deploy  verify, but leave a running bridge alone
//   npm run pipeline / npm run hooks:install (runs it on every `git push`)
//
// Stages (a failed stage stops the run; a skipped stage says why):
//   preflight  Node 22+, npm, git state, free disk, Hermes's Python for the bridge, a stale run's lock
//   deps       npm ci, only when package-lock.json changed since the last install (a stamp records its hash)
//   static     eslint, TypeScript (main, renderer, e2e), prettier (reported), no secret-shaped strings or big files
//              in what this push adds, npm audit of production dependencies (high/critical block)
//   tests      renderer tests (vitest) and bridge tests (pytest on Hermes's Python); a failed test file is re-run
//              once on its own, so a flake is reported as a flake and a real failure still blocks
//   build      electron-vite build, with the output checked (main, preload, renderer)
//   smoke      the real bridge, isolated: started in a throwaway HM_HOME, it must answer /api/v1/ping, refuse
//              callers without the token, list its operations, run a read-only call, and its MCP server (stdio) must
//              answer initialize and tools/list; then it is stopped
//   e2e        Playwright against the built Electron app (when the app's code changed, or --full)
//   package    electron-builder (--package or --full)
//   deploy     a bridge started by ABP or the MCP server from this checkout is restarted onto the new code; a
//              running window is told to be restarted (never closed under the user)
//
// Robustness: one run at a time (a lock naming the pid; a dead run's lock is taken over); every command has a timeout
// and its whole process tree is killed on timeout; change-aware (unknown scope runs everything); each run writes
// logs/pipeline/<time>.log, reports/pipeline/<time>.json + latest.json, and a line in reports/pipeline/history.jsonl.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const LOGS = path.join(ROOT, 'logs', 'pipeline')
const REPORTS = path.join(ROOT, 'reports', 'pipeline')
const LOCK = path.join(ROOT, '.pipeline.lock')
const STAMP_FILE = path.join(ROOT, 'node_modules', '.pipeline-lock-hash')
const STAGES = ['preflight', 'deps', 'static', 'tests', 'build', 'smoke', 'e2e', 'package', 'deploy']
const MIN_NODE = 22
const MIN_FREE_GB = 3
const FLAKY_RERUN_LIMIT = 10
const BIG_FILE = 5_000_000
const SECRET_PATTERNS = {
  'api key': /\bsk-(?:ant-|or-v1-)?[A-Za-z0-9_-]{24,}/,
  'github token': /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  'aws key': /\bAKIA[0-9A-Z]{16}\b/,
  'slack token': /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  'google key': /\bAIza[0-9A-Za-z_-]{35}\b/,
  'private key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  'hf token': /\bhf_[A-Za-z0-9]{30,}\b/,
}
// What each stage cares about.
const APP = ['src/', 'electron.vite.config.ts', 'tsconfig', 'package.json', 'package-lock.json', 'tests/e2e/', 'playwright.config.ts']
const CODE = ['src/', 'tests/', 'scripts/', 'package.json', 'package-lock.json', 'tsconfig', 'vitest.config.ts', 'eslint.config.mjs', 'electron.vite.config.ts']
const BRIDGE = ['src/bridge/']

// ---- output ------------------------------------------------------------------------------------------------------
let buf = ''
const line = (t = '') => { process.stdout.write(t + '\n'); buf += t + '\n' }
const head = (t) => line(`\n=== ${t} ===`)
const ok = (t) => line(`  [ok]   ${t}`)
const skip = (t) => line(`  [--]   ${t}`)
const doing = (t) => line(`  ->     ${t}`)
const warn = (t) => line(`  [!]    ${t}`)
const err = (t) => line(`  [ERR]  ${t}`)
const tail = (s, n = 3500) => (s.length <= n ? s : '...\n' + s.slice(-n))

// ---- running commands --------------------------------------------------------------------------------------------
function killTree(pid) {
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
}

/** Run a command: { ok, out }. On timeout the whole process tree is killed. */
function run(cmd, args, { cwd = ROOT, timeout = 1800, env, retries = 0, input } = {}) {
  return new Promise((resolve) => {
    let attempt = 0
    const go = () => {
      let out = ''
      let done = false
      const useShell = WIN && !cmd.endsWith('.exe') && !path.isAbsolute(cmd)
      const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
      const baseEnv = { ...(env ?? process.env), NO_COLOR: '1', FORCE_COLOR: '0' }
      const child = useShell
        ? spawn([cmd, ...args].map(quote).join(' '), { cwd, env: baseEnv, shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd, env: baseEnv, detached: !WIN, windowsHide: true })
      const timer = setTimeout(() => {
        if (done) return
        done = true
        killTree(child.pid)
        resolve({ ok: false, out: `${cmd} ${args.join(' ')}: timed out after ${timeout}s (process tree killed)\n${tail(out, 2000)}` })
      }, timeout * 1000)
      child.stdout?.on('data', (d) => { out += d })
      child.stderr?.on('data', (d) => { out += d })
      if (input !== undefined) { child.stdin.write(input); child.stdin.end() } else child.stdin?.end()
      child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, out: `${cmd}: ${e.message}` }) } })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (code === 0) return resolve({ ok: true, out })
        if (attempt++ < retries) return setTimeout(go, 3000)
        resolve({ ok: false, out })
      })
    }
    go()
  })
}
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' })
const npm = (args, opts) => run('npm', args, opts)

// ---- lock --------------------------------------------------------------------------------------------------------
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function takeLock() {
  if (fs.existsSync(LOCK)) {
    let held = {}
    try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')) } catch { /* unreadable: stale */ }
    if (held.pid && pidAlive(held.pid)) throw new Error(`another pipeline run (pid ${held.pid}, started ${held.started}) is still going; wait for it, or delete ${LOCK}`)
    warn(`took over a stale lock left by pid ${held.pid ?? '?'}`)
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
}
const dropLock = () => { try { fs.unlinkSync(LOCK) } catch { /* already gone */ } }

// ---- change detection --------------------------------------------------------------------------------------------
async function changedFiles() {
  let range = null
  if (process.env.HM_PIPELINE_HOOK === '1') {
    const input = fs.readFileSync(0, 'utf8')
    for (const l of input.split(/\r?\n/)) {
      const p = l.trim().split(/\s+/)
      if (p.length === 4 && !/^0+$/.test(p[3])) range = `${p[3]}..${p[1]}`
    }
  }
  if (!range) {
    const up = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
    if (up.status !== 0) return { files: null, range: 'no upstream branch' }
    const base = git('merge-base', 'HEAD', up.stdout.trim())
    if (base.status !== 0) return { files: null, range: 'no merge base with the upstream' }
    range = `${base.stdout.trim()}..HEAD`
  }
  const d = git('diff', '--name-only', range)
  if (d.status !== 0) return { files: null, range: `git diff ${range} failed` }
  const files = new Set(d.stdout.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/')))
  const st = git('status', '--porcelain')
  for (const l of st.stdout.split(/\r?\n/)) if (l.length > 3) files.add(l.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
  return { files, range }
}
const bridgePath = () => [path.join(ROOT, 'src', 'bridge'), path.join(ROOT, '.pytest-deps'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
const touches = (files, prefixes) => files === null || [...files].some((f) => prefixes.some((p) => f.startsWith(p)))

// ---- the bridge's Python ----------------------------------------------------------------------------------------
async function bridgePython() {
  const ps = `. '${path.join(ROOT, 'scripts', 'runtime.ps1').replace(/'/g, "''")}'; $r = Get-HermesManagerRuntime; if ($r) { $r = Use-PytestRuntime -Runtime $r -ProjectRoot '${ROOT.replace(/'/g, "''")}'; $r.Path }`
  const r = await run(WIN ? 'pwsh' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 900 })
  const p = r.out.trim().split(/\r?\n/).filter(Boolean).pop()
  return r.ok && p && fs.existsSync(p) ? p : null
}

// ---- stages ------------------------------------------------------------------------------------------------------
const ctx = {}

async function preflight() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE) return [false, `Node ${process.versions.node} is older than ${MIN_NODE}`]
  ok(`node ${process.versions.node}`)
  const v = await npm(['--version'], { timeout: 60 })
  if (!v.ok) return [false, 'npm does not run']
  ok(`npm ${v.out.trim()}`)
  try {
    const free = fs.statfsSync(ROOT)
    const gb = (free.bavail * free.bsize) / 1024 ** 3
    if (gb < MIN_FREE_GB) return [false, `only ${gb.toFixed(1)} GB free (need ${MIN_FREE_GB})`]
    ok(`${gb.toFixed(1)} GB free`)
  } catch { warn('could not read free disk space') }
  const head = git('rev-parse', '--short', 'HEAD').stdout.trim()
  ctx.commit = head
  ok(`git: ${git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()} @ ${head}`)
  ctx.python = await bridgePython()
  if (ctx.python) ok(`bridge Python: ${ctx.python}`)
  else warn('no Hermes Python found: bridge tests and the smoke stage will be skipped (install Hermes)')
  ctx.electron = fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'))
  return [true, '']
}

function lockHash() { return createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).digest('hex') }

async function deps() {
  const want = lockHash()
  const have = fs.existsSync(STAMP_FILE) ? fs.readFileSync(STAMP_FILE, 'utf8').trim() : ''
  if (have === want && fs.existsSync(path.join(ROOT, 'node_modules'))) { ok('dependencies match package-lock.json'); return [true, ''] }
  doing('npm ci (package-lock.json changed since the last install)')
  const r = await npm(['ci', '--no-audit', '--no-fund'], { timeout: 3600, retries: 1 })
  if (!r.ok) return [false, 'npm ci failed:\n' + tail(r.out)]
  const install = path.join(ROOT, 'node_modules', 'electron', 'install.js')
  if (fs.existsSync(install) && !fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'))) {
    doing('fetching the Electron runtime')
    const e = await run(process.execPath, [install], { timeout: 1800, retries: 1 })
    if (!e.ok) return [false, 'Electron download failed:\n' + tail(e.out)]
  }
  fs.writeFileSync(STAMP_FILE, want)
  ctx.electron = fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'))
  ok('dependencies installed')
  return [true, '']
}

async function staticChecks() {
  let r = await npm(['run', '-s', 'lint'], { timeout: 900 })
  if (!r.ok) return [false, 'eslint:\n' + tail(r.out)]
  ok('eslint: clean')
  r = await npm(['run', '-s', 'typecheck'], { timeout: 900 })
  if (!r.ok) return [false, 'TypeScript:\n' + tail(r.out)]
  ok('TypeScript: main, renderer and e2e type-check')
  r = await npm(['run', '-s', 'format:check'], { timeout: 600 })
  if (r.ok) ok('prettier: formatted')
  else warn(`prettier: ${(r.out.match(/issues found in (\d+) files?/) || [])[1] ?? 'some'} file(s) not formatted (npm run format)`)
  if (ctx.range && !ctx.range.includes(' ')) {
    const log = git('log', '-p', '--no-color', '--format=', ctx.range)
    const hits = new Set()
    let current = '?'
    for (const l of (log.stdout || '').split(/\r?\n/)) {
      if (l.startsWith('+++ b/')) current = l.slice(6)
      else if (l.startsWith('+') && !l.startsWith('+++')) for (const [kind, re] of Object.entries(SECRET_PATTERNS)) if (re.test(l)) hits.add(`${current} (${kind})`)
    }
    if (hits.size) return [false, 'secret-shaped strings in this push (never push them): ' + [...hits].join(', ')]
    const objs = git('rev-list', '--objects', ctx.range).stdout
    const check = spawnSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'], { cwd: ROOT, input: objs, encoding: 'utf8' })
    const big = (check.stdout || '').split(/\r?\n/).map((l) => l.split(' ')).filter((p) => p[0] === 'blob' && Number(p[1]) > BIG_FILE).map((p) => `${p.slice(2).join(' ')} (${(Number(p[1]) / 1e6).toFixed(1)} MB)`)
    if (big.length) return [false, 'files over 5 MB in this push (build output?): ' + big.join(', ')]
    ok('no secrets or big files in this push')
  }
  r = await npm(['audit', '--omit=dev', '--audit-level=high', '--json'], { timeout: 300 })
  let vulns = null
  try { vulns = JSON.parse(r.out).metadata?.vulnerabilities } catch { /* offline or registry down */ }
  if (!vulns) warn('npm audit could not run (offline?)')
  else if ((vulns.high ?? 0) + (vulns.critical ?? 0) > 0) return [false, `npm audit: ${vulns.critical ?? 0} critical, ${vulns.high ?? 0} high in production dependencies (npm audit)`]
  else ok(`npm audit: no high or critical issues in production dependencies${vulns.moderate ? ` (${vulns.moderate} moderate)` : ''}`)
  return [true, '']
}

async function tests() {
  let r = await npm(['run', '-s', 'test:renderer', '--', '--reporter=dot'], { timeout: 1200 })
  const renderSummary = (r.out.match(/Tests\s+(.+)/) || [])[1]
  if (!r.ok) {
    const files = [...new Set([...r.out.matchAll(/FAIL\s+(\S+\.test\.\w+)/g)].map((m) => m[1]))]
    if (files.length && files.length <= FLAKY_RERUN_LIMIT) {
      warn(`renderer: ${files.length} file(s) failed; running just those again`)
      const r2 = await npm(['run', '-s', 'test:renderer', '--', ...files], { timeout: 900 })
      if (!r2.ok) return [false, 'renderer tests (failed again on their own):\n' + tail(r2.out)]
      warn('FLAKY renderer test file(s): ' + files.join(', '))
      ;(ctx.flaky ??= []).push(...files)
    } else return [false, 'renderer tests:\n' + tail(r.out)]
  }
  ok(`renderer: ${renderSummary ?? 'passed'}`)
  if (!ctx.python) { warn('bridge tests skipped: no Hermes Python'); return [true, ''] }
  const env = { ...process.env, PYTHONPATH: bridgePath(), PYTHONUTF8: '1' }
  fs.mkdirSync(REPORTS, { recursive: true })
  r = await run(ctx.python, ['-m', 'pytest', 'tests/bridge', '-q', '-rfE', `--junitxml=${path.join(REPORTS, 'bridge-junit.xml')}`], { timeout: 1800, env })
  if (!r.ok) {
    const failed = [...r.out.matchAll(/^(?:FAILED|ERROR) (\S+::\S+)/gm)].map((m) => m[1])
    if (!failed.length || failed.length > FLAKY_RERUN_LIMIT) return [false, 'bridge tests:\n' + tail(r.out)]
    warn(`bridge: ${failed.length} test(s) failed; running just those again`)
    const r2 = await run(ctx.python, ['-m', 'pytest', '-q', ...failed], { timeout: 900, env })
    if (!r2.ok) return [false, 'bridge tests (failed again on their own):\n' + tail(r2.out)]
    warn('FLAKY bridge test(s): ' + failed.join(', '))
    ;(ctx.flaky ??= []).push(...failed)
    r = r2
  }
  ok(`bridge: ${(r.out.trim().split(/\r?\n/).pop() || 'passed').replace(/=/g, '').trim()}`)
  ctx.tests = `renderer ${renderSummary ?? 'ok'}; bridge ${(r.out.trim().split(/\r?\n/).pop() || '').replace(/=/g, '').trim()}`
  return [true, '']
}

async function build() {
  const r = await npm(['run', '-s', 'build'], { timeout: 1800, retries: 1 })
  if (!r.ok) return [false, 'electron-vite build:\n' + tail(r.out)]
  const need = ['out/main/index.js', 'out/preload/index.js']
  const missing = need.filter((p) => !fs.existsSync(path.join(ROOT, p)))
  const renderer = fs.existsSync(path.join(ROOT, 'out', 'renderer')) && fs.readdirSync(path.join(ROOT, 'out', 'renderer')).some((f) => f.endsWith('.html'))
  if (missing.length || !renderer) return [false, `the build is incomplete: ${[...missing, renderer ? '' : 'out/renderer/*.html'].filter(Boolean).join(', ')}`]
  ok('built main, preload and renderer')
  return [true, '']
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
}

async function http(url, { method = 'GET', token = '', body } = {}) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  let data = null
  try { data = await res.json() } catch { /* empty */ }
  return { status: res.status, data }
}

async function smoke() {
  if (!ctx.python) return [true, 'skip:no Hermes Python']
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-smoke-'))
  const port = await freePort()
  const token = createHash('sha256').update(String(Math.random()) + Date.now()).digest('hex')
  const env = { ...process.env, HM_HOME: home, HM_BRIDGE_TOKEN: token, PYTHONPATH: bridgePath(), PYTHONUTF8: '1' }
  const logFd = fs.openSync(path.join(home, 'bridge.log'), 'w')
  const child = spawn(ctx.python, ['-m', 'hermes_manager_bridge', '--discovery', '--owner', 'ci', '--port', String(port)], { cwd: path.join(ROOT, 'src', 'bridge'), env, stdio: ['ignore', logFd, logFd], windowsHide: true, detached: !WIN })
  const url = `http://127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 90_000
    let up = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return [false, 'the bridge exited at start:\n' + tail(fs.readFileSync(path.join(home, 'bridge.log'), 'utf8'), 2000)]
      try { if ((await http(url + '/api/v1/ping')).status === 200) { up = true; break } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!up) return [false, 'the bridge did not answer /api/v1/ping in 90 s']
    ok(`bridge up on ${url} (pid ${child.pid})`)
    const anon = await http(url + '/api/v1/operations')
    if (![401, 403].includes(anon.status)) return [false, `/api/v1/operations without the token answered ${anon.status}; it must refuse`]
    const ops = await http(url + '/api/v1/operations', { token })
    if (ops.status !== 200 || !Array.isArray(ops.data) || ops.data.length < 20) return [false, `the catalog is wrong: ${ops.status}, ${Array.isArray(ops.data) ? ops.data.length : 0} operations`]
    ok(`catalog: ${ops.data.length} operations; refuses callers without the token`)
    const readOnly = ops.data.find((o) => o.id === 'gateway.status') || ops.data.find((o) => !o.mutating)
    const call = await http(`${url}/api/v1/call/${readOnly.id}`, { method: 'POST', token, body: {} })
    if (call.status >= 500) return [false, `a read-only call (${readOnly.id}) failed with ${call.status}`]
    ok(`a read-only call works (${readOnly.id}: ${call.status})`)
    if (!fs.existsSync(path.join(home, 'control.json'))) return [false, 'the bridge did not write control.json (--discovery)']
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci', version: '1' } } }
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    const mcp = await run(ctx.python, ['-m', 'hermes_manager_bridge.mcp', '--tools', 'compact'], { cwd: path.join(ROOT, 'src', 'bridge'), env, timeout: 120, input: JSON.stringify(init) + '\n' + JSON.stringify(list) + '\n' })
    const replies = mcp.out.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l) } catch { return {} } })
    const tools = replies.find((m) => m.id === 2)?.result?.tools ?? []
    if (!replies.find((m) => m.id === 1)?.result || !tools.length) return [false, 'the MCP server did not answer initialize/tools/list:\n' + tail(mcp.out, 1500)]
    ok(`MCP over stdio: initialize and ${tools.length} tool(s)`)
    return [true, '']
  } finally {
    if (child.exitCode === null) killTree(child.pid)
    fs.closeSync(logFd)
    await new Promise((r) => setTimeout(r, 500))
    fs.rmSync(home, { recursive: true, force: true })
  }
}

async function e2e() {
  if (!ctx.electron) return [true, 'skip:the Electron runtime is not installed (npm ci fetches it)']
  const r = await npm(['run', '-s', 'test:e2e', '--', '--reporter=line'], { timeout: 1800, retries: 1 })
  if (!r.ok) return [false, 'Playwright:\n' + tail(r.out)]
  ok(`e2e: ${(r.out.match(/(\d+ passed[^\n]*)/) || [])[1] ?? 'passed'}`)
  return [true, '']
}

async function pkg() {
  const r = await npm(['exec', '--', 'electron-builder', '--win', 'zip', '--publish', 'never'], { timeout: 3600 })
  if (!r.ok) return [false, 'electron-builder:\n' + tail(r.out)]
  const dist = path.join(ROOT, 'dist')
  const art = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => /\.(zip|exe)$/.test(f)) : []
  for (const f of art) {
    const sum = createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')
    fs.writeFileSync(path.join(dist, f + '.sha256'), `${sum}  ${f}\n`)
  }
  ok(`packaged: ${art.join(', ') || '(nothing found under dist/)'}; SHA-256 files written`)
  return [true, '']
}

async function deploy() {
  const control = path.join(process.env.HM_HOME || path.join(os.homedir(), '.hermes-manager'), 'control.json')
  if (!fs.existsSync(control)) return [true, 'skip:no bridge is running']
  let d
  try { d = JSON.parse(fs.readFileSync(control, 'utf8')) } catch { return [true, 'skip:control.json is unreadable'] }
  if (!d.pid || !pidAlive(d.pid)) return [true, 'skip:no bridge is running']
  if (d.owner === 'app') { warn('the Hermes Manager window is running: restart it to use this build (it is not closed under you)'); return [true, ''] }
  if (!['abp', 'mcp', 'bridge'].includes(d.owner)) return [true, `skip:the running bridge belongs to ${d.owner}`]
  const info = spawnSync(WIN ? 'powershell' : 'ps', WIN ? ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${d.pid}").CommandLine`] : ['-o', 'args=', '-p', String(d.pid)], { encoding: 'utf8' })
  const cmdline = (info.stdout || '').trim()
  if (!cmdline.includes('hermes_manager_bridge')) return [true, 'skip:cannot confirm the running bridge is from this checkout']
  doing(`restarting the bridge (pid ${d.pid}, started by ${d.owner}) onto this code`)
  killTree(d.pid)
  if (!ctx.python) return [false, 'no Hermes Python to start the bridge again']
  const token = createHash('sha256').update(String(Math.random()) + Date.now()).digest('hex')
  const child = spawn(ctx.python, ['-m', 'hermes_manager_bridge', '--discovery', '--owner', d.owner], { cwd: path.join(ROOT, 'src', 'bridge'), env: { ...process.env, HM_BRIDGE_TOKEN: token, PYTHONPATH: bridgePath() }, stdio: 'ignore', detached: true, windowsHide: true })
  child.unref()
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const n = JSON.parse(fs.readFileSync(control, 'utf8'))
      if (n.pid !== d.pid && (await http(n.url.replace(/\/$/, '') + '/api/v1/ping')).status === 200) { ok(`bridge restarted (pid ${n.pid})`); return [true, ''] }
    } catch { /* not yet */ }
  }
  return [false, 'the bridge did not come back within 45 s']
}

const FNS = { preflight, deps, static: staticChecks, tests, build, smoke, e2e, package: pkg, deploy }

// ---- the run -------------------------------------------------------------------------------------------------------
function plan(args, files) {
  const why = {}
  const code = touches(files, CODE)
  const app = touches(files, APP)
  for (const s of STAGES) {
    if (args.only.length && !args.only.includes(s)) why[s] = 'not asked for (--only)'
    else if (['preflight', 'deps', 'static'].includes(s)) why[s] = ''
    else if (s === 'tests') why[s] = args.full || code ? '' : 'no code changed'
    else if (s === 'build') why[s] = args.fast ? '--fast' : args.full || app || args.pkg ? '' : "the app's code did not change"
    else if (s === 'smoke') why[s] = args.fast ? '--fast' : args.full || touches(files, BRIDGE) ? '' : 'the bridge did not change'
    else if (s === 'e2e') why[s] = args.fast ? '--fast' : args.full || app ? '' : "the app's code did not change"
    else if (s === 'package') why[s] = args.full || args.pkg ? (args.fast ? '--fast' : '') : '--package not given'
    else if (s === 'deploy') why[s] = args.noDeploy ? '--no-deploy' : args.fast ? '--fast' : args.full || touches(files, BRIDGE) ? '' : 'the bridge did not change'
  }
  for (const s of args.only) why[s] = ''
  return why
}

async function main() {
  const argv = process.argv.slice(2)
  const args = { full: argv.includes('--full'), fast: argv.includes('--fast'), list: argv.includes('--list'), noDeploy: argv.includes('--no-deploy'), pkg: argv.includes('--package'), only: [] }
  argv.forEach((a, i) => { if (a === '--only' && argv[i + 1]) args.only.push(argv[i + 1]) })
  const bad = args.only.filter((s) => !STAGES.includes(s))
  if (bad.length) { console.error(`unknown stage(s): ${bad.join(', ')}; one of ${STAGES.join(', ')}`); return 2 }
  const started = Date.now()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  line('Hermes Manager local CI/CD pipeline')
  head('Change detection')
  const { files, range } = await changedFiles()
  ctx.range = files ? range : null
  if (files === null) warn(`cannot tell what changed (${range}): running everything`)
  else ok(`${files.size} file(s) changed (${range})`)
  const why = plan(args, files)
  if (args.list) { for (const s of STAGES) line(`  ${why[s] ? 'skip' : 'run '}  ${s.padEnd(10)} ${why[s]}`); return 0 }

  const results = []
  try { takeLock() } catch (e) { err(e.message); return 1 }
  try {
    for (const s of STAGES) {
      const r = { name: s, status: 'pending', seconds: 0, note: '' }
      results.push(r)
      head(s)
      if (why[s]) { r.status = 'skipped'; r.note = why[s]; skip(why[s]); continue }
      const t0 = Date.now()
      let res
      try { res = await FNS[s]() } catch (e) { res = [false, `${e.name}: ${e.message}`] }
      r.seconds = Math.round((Date.now() - t0) / 100) / 10
      const [passed, msg] = res
      if (passed && msg.startsWith('skip:')) { r.status = 'skipped'; r.note = msg.slice(5); skip(r.note) }
      else if (passed) r.status = 'passed'
      else { r.status = 'failed'; r.note = msg; err(`${s} failed:\n${msg}`); break }
    }
  } finally { dropLock() }
  const failed = results.filter((r) => r.status === 'failed')
  head('Summary')
  for (const r of results) line(`  ${{ passed: '[ok]  ', skipped: '[--]  ', failed: '[ERR] ', pending: '      ' }[r.status]} ${r.name.padEnd(10)} ${String(r.seconds).padStart(7)}s  ${(r.note.split('\n')[0] || '').slice(0, 90)}`)
  const total = Math.round((Date.now() - started) / 100) / 10
  line(`\n  ${failed.length ? 'FAILED' : 'PASSED'} in ${total}s${ctx.flaky?.length ? `  (flaky: ${ctx.flaky.join(', ')})` : ''}`)

  fs.mkdirSync(LOGS, { recursive: true })
  fs.mkdirSync(REPORTS, { recursive: true })
  const report = { started: stamp, seconds: total, status: failed.length ? 'failed' : 'passed', commit: ctx.commit, range: ctx.range, changed: files ? [...files].sort() : null, tests: ctx.tests, flaky: ctx.flaky ?? [], stages: results }
  fs.writeFileSync(path.join(REPORTS, `${stamp}.json`), JSON.stringify(report, null, 1))
  fs.writeFileSync(path.join(REPORTS, 'latest.json'), JSON.stringify(report, null, 1))
  fs.appendFileSync(path.join(REPORTS, 'history.jsonl'), JSON.stringify({ started: stamp, seconds: total, status: report.status, commit: ctx.commit, tests: ctx.tests, stages: Object.fromEntries(results.map((r) => [r.name, [r.status, r.seconds]])) }) + '\n')
  fs.writeFileSync(path.join(LOGS, `${stamp}.log`), buf)
  for (const dir of [LOGS, REPORTS]) {
    const old = fs.readdirSync(dir).filter((f) => /^\d{8}-\d{6}\.(log|json)$/.test(f)).sort().slice(0, -50)
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true })
  }
  console.log(`\n(log: logs/pipeline/${stamp}.log, report: reports/pipeline/latest.json)`)
  return failed.length ? 1 : 0
}

main().then((code) => process.exit(code), (e) => { console.error(e); dropLock(); process.exit(1) })
