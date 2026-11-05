# 0001. Layers and the dependency rule, checked by a test

Status: accepted

## Context

The code has to be adapted to a client in days: a different channel, a different model, a different database layout. That only works if the booking rules do not know about HTTP, SQL or a chat provider.

## Decision

Four layers and an entry point: `domain` (pure rules: time zones, slots, phone numbers, redaction) <- `application` (use cases, the assistant, the ports they need) <- `infrastructure` (PostgreSQL, HTTP, crypto, model and relay adapters) <- `composition` (wiring), and `src/bin.ts` plus `src/demo` as entry points that may only reach `composition`, `application` and `domain`.

`test/architecture/layers.test.ts` reads every source file, extracts its imports and fails on a wrong direction, on any package or Node built-in imported by the pure layers, on the database driver outside `infrastructure/postgres`, and on the clock, randomness, `process`, `fetch`, timers or `console` in the pure layers. It also checks that nothing under `application/assistant` can import infrastructure. The checker has its own tests.

## Consequences

- The clock and the id generator are ports; no use case calls `Date.now()`, so every time rule is tested with a clock that is set by hand.
- The in-memory double of the store (`test/support/memory-db.ts`) is only trusted because the same scenarios run against it and against PostgreSQL (`test/contract`).
- The architecture test caught the first public entry file that imported an adapter directly.
