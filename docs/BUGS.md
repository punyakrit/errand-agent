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

## 3. The model never saw proactive notices

- **What broke:** after a provider cancelled, the user asked "what happened?" and the payload sent to the model had no mention of the notice the user had just read.
- **Why:** `pickRecent` in `src/agent/context.ts` removed assistant messages from the start of the window, because the first message sent must come from the user. A proactive notice or reconcile result has no user message before it, so it was always removed. The older-chat summary keeps only user lines, so nothing else carried it.
- **Effect:** the model would answer as if nothing had happened, and could ask the user to explain their own cancelled booking.
- **Fix:** leading assistant messages now stay. A short fixed user line goes in front of them, so the first message is still from the user.
- **Regression test:** `the model sees the notice in chat history on the next message` in `tests/monitor/monitor.test.ts`.

## 4. A core preference was crowded out by minor notes

- **What broke:** eval scenario 29 (50+ memories) failed: `earliest_time` was missing from the payload, so a user's "not before 9" could be silently dropped.
- **Why:** `score()` in `src/memory/select.ts` gave service scope more weight than being a core preference. Thirty minor plumber notes all ranked above `earliest_time`, and they used up the memory budget first.
- **Effect:** the more a user had stored, the more likely their important preferences were to vanish. The earlier unit test missed it because the fact it checked also got a bonus for mentioning the current area.
- **Fix:** a core preference now outweighs service scope, so core keys are selected before notes.
- **Regression test:** `keeps a core preference when many service notes compete for the budget` in `tests/memory/select.test.ts`, plus eval scenario 29.

## 5. The live event stream did not open until the first event

- **What broke:** the server-sent events test hung for 30 seconds and timed out waiting for the response to `GET /events`.
- **Why:** Node's `writeHead` only stores the headers. They are sent with the first body write, and a quiet page has nothing to write, so the connection never finished opening.
- **Effect:** the page could sit in a pending state with no sign that it was connected, until something else caused an event.
- **Fix:** `openEventStream` now writes an SSE comment straight away, which sends the headers.
- **Regression test:** `delivers over a real server-sent event stream` in `tests/demo/server.test.ts`.

## 6. A repeat search cancelled the user's pick

- **What broke:** in the first live smoke run, the user picked a provider, the model searched again in that same message, and `hold_slot` was blocked with `user_must_pick`. The agent then told the user "the system wants you to pick the option yourself", and it never got past that point.
- **Why:** `saveOptions` stamped the current message ID on the options every time, even when the user had already seen them. The check read that as "these options are new, so the user cannot have picked yet".
- **Effect:** a real user would be stuck in a loop. Scripted tests missed it because I wrote them assuming a tidy model that never searches twice.
- **Fix:** each option now remembers the message it was first offered in, and a repeat search keeps that value. A provider that is new in this message still needs a pick.
- **Regression test:** `a repeat search in the same message does not undo the user's pick` in `tests/agent/tools.test.ts`.

## 7. Schema field order made the request fields unreachable

- **What broke:** in a live smoke run, the model called `update_request` eight times with only `{"kind":"book","new_slot":""}` and hit the 8-turn limit before it could record anything.
- **Why:** `strict: true` output follows the order of the schema's properties. `update_request` listed `kind` near the end, because it extended the request schema. Once the model wrote `kind`, only the fields after it could follow, so `service`, `area` and the rest could no longer be written.
- **Effect:** a request with every detail in the first message burned all its turns and got a limit message. This cannot show up in scripted evals, because they never go through strict decoding.
- **Fix:** `kind` and `target_booking_id` now come first. Empty strings also count as not given.
- **Regression test:** `lists kind before the request fields, because strict output follows schema order` in `tests/agent/loop.test.ts`.

## 8. Blocked tool calls were missing from the trace

- **What broke:** a live smoke run showed two `gate_decision` entries for a blocked `hold_slot`, but no `tool_call` event for either attempt.
- **Why:** `dispatch()` skipped tracing for mock-named tools, assuming `callMock` always does it. That is false when code stops the call before it reaches the mock.
- **Effect:** the tool log hid the calls you most want to see, and they did not count towards the 20-call limit.
- **Fix:** `dispatch()` now traces and counts any tool that did not reach the mock.
- **Regression test:** `traces and counts a tool call that code stopped before it reached the provider` in `tests/agent/loop.test.ts`.

## 9. The "conservative" token estimate was too low

- **What broke:** measuring with `count_tokens` showed the local estimate 19% below the real count on a JSON-heavy payload: 1,441 estimated against 1,769 real.
- **Why:** I assumed 3 characters per token and called that high. JSON tool results tokenise much more densely than English, at about 2.4 characters per token.
- **Effect:** the budget check and invariant 7 could pass on a payload that was really over budget.
- **Fix:** the estimate now uses 2.2 characters per token, chosen from the measurement, and the budgets were rebalanced to suit.
- **Regression test:** `is never below the real count measured for a JSON-heavy conversation` in `tests/agent/tokens.test.ts`.
