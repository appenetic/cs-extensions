---
description: Tesla mit dieser Claude-Code-Bridge koppeln (Code aus dem Auto oder Kopplungslink für den QR-Code)
argument-hint: "[Code aus der Claude-App im Auto]"
disable-model-invocation: true
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/coilshift-bridge.mjs" pair '$ARGUMENTS' --data "${CLAUDE_PLUGIN_DATA}"`

Gib die Ausgabe oben dem Nutzer vollständig und unverändert aus; einen Kopplungslink als eigene Zeile in einem Codeblock, damit er sich am Stück kopieren lässt. Füge nichts hinzu und führe keine weiteren Befehle aus.
