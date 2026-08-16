---
"shellykit": patch
---

Upgrade terminal handoff across the desktop CLI, daemon, and Android app. Desktop attach now preserves a stable session status row while rendering terminal output through a VT parser; pairing authorizes the first valid phone connection while the local command is active; session termination is durably acknowledged by protocol v4; and the Android client gains more reliable session recovery, terminal input, navigation, notifications, and lifecycle handling.
