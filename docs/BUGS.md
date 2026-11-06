# Real bugs found while building

Each entry was logged when it happened. The failing test was committed before the fix.

## 1. A failing tool was counted and traced twice

- **What broke:** when a mock tool threw, `tests/agent/loop.test.ts` saw 5 `tool_call` events for 4 attempts, and the run's tool-call count was one too high.
- **Why:** `Run.callMock` already traces and counts each attempt. The `catch` in `dispatch()` then traced and counted the same failure again. The success path skipped mock tools, but the failure path did not.
- **Effect:** the trace overstated what happened, and the 20-call limit could trip early.
- **Fix:** the `catch` in `dispatch()` now adds its event and count only for tools that do not trace themselves.
- **Regression test:** `counts each attempt of a failing tool exactly once` in `tests/agent/loop.test.ts`.
