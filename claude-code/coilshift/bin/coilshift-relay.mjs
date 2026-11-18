#!/usr/bin/env node
// The session's inbox relay: a stdio MCP server without tools that Claude Code
// starts for each session. Being the session's own child, it may post into the
// session's inbox socket, where a message from any other process would be held
// in a session that bypasses permission prompts. The bridge sends it the text
// the driver dictated or typed in the car; it posts it and reports back.
import net from 'node:net'
import readline from 'node:readline'
import { VERSION, dataDir, ensureBridge, relaySocketPath } from '../lib/common.mjs'

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET || ''
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN || ''
const dir = dataDir()

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

// Minimal MCP: initialize, tools/list (none), ping. server/discover is refused,
// so Claude Code falls back to the classic initialize handshake.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize': {
      const asked = message.params && message.params.protocolVersion
      send({
        id: message.id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'coilshift-inbox', version: VERSION },
        },
      })
      break
    }
    case 'tools/list':
      send({ id: message.id, result: { tools: [] } })
      break
    case 'ping':
      send({ id: message.id, result: {} })
      break
    default:
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
})
process.stdin.on('end', () => process.exit(0))

// Posts one message into this session's inbox: the auth line, then the message.
function post(text) {
  return new Promise((resolve, reject) => {
    if (!inbox) return reject(new Error('no inbox socket in this session'))
    const socket = net.createConnection(inbox, () => {
      if (token) socket.write(JSON.stringify({ type: 'auth', token }) + '\n')
      socket.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
      socket.end()
    })
    socket.setTimeout(5000, () => socket.destroy(new Error('inbox timeout')))
    socket.on('error', reject)
    socket.on('close', (failed) => (failed ? null : resolve()))
  })
}

// Keeps a connection to the bridge, reconnecting after a bridge restart.
async function connect() {
  if (!inbox) return
  for (;;) {
    await ensureBridge(dir).catch(() => false)
    await new Promise((done) => {
      const socket = net.createConnection(relaySocketPath(dir), () => {
        socket.write(JSON.stringify({ type: 'hello', socket: inbox, ppid: process.ppid, cwd: process.cwd() }) + '\n')
      })
      readline.createInterface({ input: socket }).on('line', async (line) => {
        let order
        try {
          order = JSON.parse(line)
        } catch {
          return
        }
        if (order.type !== 'deliver' || typeof order.text !== 'string') return
        try {
          await post(order.text)
          socket.write(JSON.stringify({ type: 'result', id: order.id, ok: true }) + '\n')
        } catch (error) {
          socket.write(JSON.stringify({ type: 'result', id: order.id, ok: false, error: String(error.message) }) + '\n')
        }
      })
      socket.on('error', () => {})
      socket.on('close', done)
    })
    await new Promise((r) => setTimeout(r, 5000))
  }
}

connect()
