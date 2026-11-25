---
description: Pair a Tesla with this Claude Code bridge (a code from the car, or a pairing link for the QR code)
argument-hint: "[code from the Claude app in the car]"
disable-model-invocation: true
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/coilshift-bridge.mjs" pair '$ARGUMENTS' --data "${CLAUDE_PLUGIN_DATA}"`

Gib die Ausgabe oben dem Nutzer vollständig und unverändert aus; einen Kopplungslink als eigene Zeile in einem Codeblock, damit er sich am Stück kopieren lässt. Füge nichts hinzu und führe keine weiteren Befehle aus.
