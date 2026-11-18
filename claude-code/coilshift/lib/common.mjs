// Shared by the bridge daemon, the hook forwarder and the per-session inbox relay:
// where the bridge keeps its state, how to reach it, and how to start it.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.2.4'
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The plugin data directory survives plugin updates and goes with an uninstall.
// Hooks and MCP servers get it in their environment, slash commands pass --data.
export function dataDir(argv = process.argv) {
  const flag = argv.indexOf('--data')
  const dir =
    (flag > 0 && argv[flag + 1]) ||
    process.env.COILSHIFT_BRIDGE_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'coilshift-appenetic')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

// A Unix socket path has about 104 bytes on macOS. A data directory too deep for
// that gets a short private directory of its own, derived from its path, so every
// process finds the same sockets. Fixed under /tmp: Claude Code gives its child
// processes a TMPDIR of their own.
function socketDir(dir) {
  if (Buffer.byteLength(path.join(dir, 'bridge.sock')) <= 100) return dir
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12)
  const short = path.join('/tmp', `coilshift-${process.getuid()}-${hash}`)
  fs.mkdirSync(short, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(short)
  if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('unsafe socket directory ' + short)
  fs.chmodSync(short, 0o700)
  return short
}

export const socketPath = (dir) => path.join(socketDir(dir), 'bridge.sock')
export const relaySocketPath = (dir) => path.join(socketDir(dir), 'relay.sock')

// One HTTP request to the bridge's local socket. Resolves {status, body}.
export function local(dir, method, route, body, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        socketPath: socketPath(dir),
        method,
        path: route,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

export async function running(dir) {
  return (await daemonVersion(dir)) !== ''
}

// daemonVersion is the version of the daemon that answers, '' for none.
async function daemonVersion(dir) {
  try {
    const answer = await local(dir, 'GET', '/ping', undefined, 1500)
    return answer.status === 200 ? String((answer.body && answer.body.version) || '0') : ''
  } catch {
    return ''
  }
}

// older says whether version a comes before b (dotted numbers).
export function older(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0)
  }
  return false
}

// Starts the daemon detached unless it answers already; waits until it does.
// A daemon of an older plugin version is stopped and replaced, so an update
// takes effect with the next session. A newer one stays, for sessions that
// still run the old plugin.
export async function ensureBridge(dir, waitMs = 4000) {
  const version = await daemonVersion(dir)
  if (version && !older(version, VERSION)) return true
  if (version) {
    await local(dir, 'POST', '/stop', {}).catch(() => {})
    const until = Date.now() + 3000
    while (Date.now() < until && (await running(dir))) await new Promise((r) => setTimeout(r, 100))
  }
  const log = fs.openSync(path.join(dir, 'bridge.log'), 'a', 0o600)
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'coilshift-bridge.mjs'), 'serve', '--data', dir], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, COILSHIFT_BRIDGE_DATA: dir },
    cwd: os.homedir(),
  })
  child.unref()
  fs.closeSync(log)
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150))
    if (await running(dir)) return true
  }
  return false
}
