---
status: blocked
tags: [serve]
---
# Multi-client daemon (roadmap Phase 5)

## Goal
A standalone `daemon start|stop|status` with a discovery file (`{port, pid, token}`),
bearer-token auth, `POST /api/v1/…` control API, a request queue serializing human approval,
a session cache, and SSE to a persistent tab.

Blocked on demand: justified only when several independent processes must share one connected
wallet tab. Until then the per-binding `serve` subprocess gives each consumer a persistent
session. Rationale in ARCHITECTURE.md § Roadmap.

## Decisions
- Would mount on the `start_with` / `build_router_with` extension point.
