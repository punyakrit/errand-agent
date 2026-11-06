# Real bugs found while building

Each entry was logged when it happened. The failing test was committed before the fix.

## 1. A failing tool was counted and traced twice

- **What broke:** when a mock tool threw, `tests/agent/loop.test.ts` saw 5 `tool_call` events for 4 attempts, and the run's tool-call count was one too high.
- **Why:** `Run.callMock` already traces and counts each attempt. The `catch` in `dispatch()` then traced and counted the same failure again. The success path skipped mock tools, but the failure path did not.
- **Effect:** the trace overstated what happened, and the 20-call limit could trip early.
- **Fix:** the `catch` in `dispatch()` now adds its event and count only for tools that do not trace themselves.
- **Regression test:** `counts each attempt of a failing tool exactly once` in `tests/agent/loop.test.ts`.

## 2. A late "yes" replayed an old booking result

- **What broke:** after a finished booking, a "yes" to an unrelated question got the old "Booked and verified" message back instead of an answer.
- **Why:** the repeated-yes check in `handleApprovalReply` looked only at whether a consumed approval existed and no task was active. It never checked what the user was replying to.
- **Effect:** no second booking, because the approval was already used, but the user got a wrong answer and the model never saw their message.
- **Fix:** a yes counts as a repeat only if the last assistant message was that action's result, or the action is still unresolved.
- **Regression test:** `a yes long after a finished booking is not treated as a repeat` in `tests/agent/approval.test.ts`.
