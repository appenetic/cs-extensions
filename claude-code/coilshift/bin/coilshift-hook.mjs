#!/usr/bin/env node
// Hook forwarder: hands the hook's JSON to the bridge and prints the bridge's
// answer as the hook output. It never blocks Claude Code on an error: no bridge,
// a bad answer or a timeout all end in exit 0 without output.
import fs from 'node:fs'
import { dataDir, ensureBridge, local } from '../lib/common.mjs'

const BLOCKING = new Set(['PreToolUse', 'PermissionRequest'])

async function main() {
  let input
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    return
  }
  const dir = dataDir()
  const event = input.hook_event_name
  if (event === 'SessionStart' && !(await ensureBridge(dir))) return
  // The session's own inbox socket, so the bridge can match its relay.
  input._env = {
    socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || '',
    ppid: process.ppid,
  }
  // A waiting prompt is held by the bridge until the car answers or its own
  // timeout ends, which is shorter than the hook timeout in hooks.json.
  const timeout = BLOCKING.has(event) ? 0 : 2500
  let answer
  try {
    answer = await local(dir, 'POST', '/hook', input, timeout)
  } catch {
    return
  }
  if (answer.status === 200 && answer.body && answer.body.hookSpecificOutput) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: answer.body.hookSpecificOutput }))
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
)
