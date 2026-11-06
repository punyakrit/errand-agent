# Requirements map

Each requirement from the assignment PDF, with the code that meets it and a test that proves it. `tests/docs/requirements.test.ts` checks that every file and test named here exists.

## 1. Problem statement

| Requirement | Code | Test |
|---|---|---|
| Clarifies missing details | `src/agent/request.ts` | "lists only what a booking still needs" |
| Compares providers | `src/agent/options.ts` | "applies budget and time limits in code" |
| Seeks approval before consequential actions | `src/agent/gate.ts` | "runs the action after a plain yes, with no model call" |
| Recovers safely from tool failures | `src/agent/executor.ts` | "timeout that really booked: asks the source of truth and does not retry" |
| Runs locally with no real services | `src/mock/env.ts` | "cannot be constructed without LIVE=1" |
| The three example requests work | `src/mock/seed.ts` | "supports the three example requests from the PDF" |

## 2. Tool environment

| Requirement | Code | Test |
|---|---|---|
| `search_providers`: 3 to 8 providers with IDs, prices, ratings, slots, attributes | `src/mock/env.ts` | "returns 3 to 8 providers for every service and area" |
| `get_provider`: details and reviews, with a prompt injection | `src/mock/catalog.ts` | "has an injection review for each attack, for every service" |
| `hold_slot`: 10 minutes, hold ID and expiry | `src/mock/env.ts` | "holds for 10 minutes and returns a hold ID and expiry" |
| `hold_slot`: quoted price can differ, configurable | `src/mock/env.ts` | "can quote a different price, one change at a time" |
| `book`: 70% success, 15% slot_taken, 15% timeout, half of those booked | `src/mock/env.ts` | "matches 70% success, 15% slot_taken, 15% timeout with half really booked" |
| `book`: hold_expired past expiry | `src/mock/env.ts` | "returns hold_expired at and past expiry, and books nothing" |
| `get_booking_status`: by hold ID or key, source of truth | `src/mock/env.ts` | "answers by hold ID and by key" |
| `cancel`: first call 503, retry succeeds | `src/mock/env.ts` | "fails with a 503 on the first call and succeeds on the retry" |
| `reschedule`: slot_conflict on configured slots | `src/mock/env.ts` | "returns slot_conflict on configured slots and does not move the booking" |
| `list_bookings`: past and upcoming, with ID, provider, service, slot, status | `src/mock/env.ts` | "returns ID, provider, service, slot and status" |
| Seeded randomness or configurable scenarios | `src/rng.ts` | "is reproducible: the same seed gives the same outcomes" |

## 3. Required behaviour

| Requirement | Code | Test |
|---|---|---|
| Collect only missing details | `src/agent/request.ts` | "lists only what a booking still needs" |
| Do not re-ask supplied facts | `src/agent/tools/request-tools.ts` | "blocks a question about a known field and traces it" |
| A correction preserves other context | `src/agent/request.ts` | "changes only the corrected field" |
| Workflow represented explicitly | `src/agent/state.ts` | "throws on an illegal move, traces it and keeps the old state" |
| Approval covers the exact action and material details | `src/agent/approvals.ts` | "is built by code from the held price, not the search price" |
| Approval enforced by code, not model output or tool arguments | `src/agent/gate.ts` | "does not let the model's words grant approval" |
| A conditional reply is not approval | `src/agent/yes-no.ts` | "treats a conditional yes as a change, not approval" |
| Any change to provider, slot or price voids approval | `src/agent/gate.ts` | "voids a granted approval if the slot changes before execution" |
| Price change voids approval | `src/agent/gate.ts` | "voids a granted approval if the price changes before execution" |
| Hard limit on model turns | `src/agent/loop.ts` | "stops after 8 model turns" |
| Hard limit on tool calls | `src/agent/loop.ts` | "stops at 20 tool calls, even inside one batch" |
| Hard limit on wall-clock time | `src/agent/loop.ts` | "stops at 60 seconds on the injected clock" |
| Every exit gives a clear message | `src/agent/finish.ts` | "every run ends with a saved reply and a run_end event" |
| Exhausted retries do not hang or fail silently | `src/agent/tools/index.ts` | "ends clearly when retries run out" |
| No duplicates across repeated confirmations | `src/agent/gate.ts` | "a repeated yes returns the same result with no second call" |
| No duplicates across network retries | `src/agent/executor.ts` | "timeout that did not book: retries with the same key" |
| No duplicates across process restarts | `src/agent/recovery.ts` | "killed after book succeeded, before the result was saved" |
| After a timeout, query the source of truth first | `src/agent/executor.ts` | "timeout that really booked: asks the source of truth and does not retry" |
| Never claim success until verified | `src/agent/executor.ts` | "does not claim success if verification fails after a success" |
| Reviews are data, not instructions | `src/agent/untrusted.ts` | "marks review text as data and flags it in the trace only" |
| Injection cannot change permissions | `src/agent/tools/action-tools.ts` | "stays blocked while an approval is pending, even with the right hold" |
| Injection cannot change memory | `src/agent/tools/memory-tools.ts` | "rejects text from a review, even after the review was read" |
| Remember stable preferences across sessions | `src/memory/store.ts` | "fills known fields and blocks asking for them again" |
| Inspect stored facts | `src/agent/tools/memory-tools.ts` | "shows the user everything active, labelled" |
| Correct stored facts | `src/agent/tools/memory-tools.ts` | "supersedes the old value" |
| Forget stored facts | `src/agent/forget.ts` | "removes the value from chat history, both sides" |
| Separate explicit and inferred facts | `src/memory/store.ts` | "start unconfirmed and are not usable" |
| Trace for each run | `src/trace/tracer.ts` | "writes one JSONL file per run" |
| Trace has state transitions | `src/agent/run.ts` | "saves each move and traces it" |
| Trace has model calls, latency, tokens and cost | `src/agent/loop.ts` | "records model calls with tokens, cost, latency and stop reason" |
| Trace has tool names, arguments and sanitized results | `src/trace/tracer.ts` | "records tool calls with arguments, result, latency and attempt" |
| At least 20 automated scenarios | `src/eval/scenarios/index.ts` | "covers all 36 required scenarios" |
| Assert outcomes and invariants, not wording | `src/eval/invariants.ts` | "fails when an invariant breaks, even if the facts match" |
| Detect a provider cancellation with no user prompt | `src/monitor/monitor.ts` | "finds it with no user message and no model call" |
| Decide whether and how to notify | `src/monitor/decide.ts` | "only logs a cancellation of a past booking" |
| Replacement within known preferences | `src/monitor/replacement.ts` | "stays within known preferences" |
| Fresh approval before rebooking | `src/monitor/replacement.ts` | "needs a pick, a new hold and fresh approval before rebooking" |
| At least 50 memories and a long chat | `src/eval/seed-history.ts` | "really has that much data" |
| Fixed token budget | `src/agent/context.ts` | "keeps the actual payload under budget" |
| Only relevant, current preferences reach the model | `src/memory/select.ts` | "excludes other services and other areas" |
| Forgotten and unconfirmed facts never included | `src/memory/select.ts` | "excludes forgotten, unconfirmed and superseded values" |
| Log what context was sent each turn | `src/agent/loop.ts` | "lists what was included and why the rest was left out" |

## 4. Implementation freedom

| Requirement | Code | Test |
|---|---|---|
| Tool contracts stay fixed | `src/mock/types.ts` | "leaves the mock contract untouched when no fault is set" |
| A real LLM drives tool calls | `src/llm/anthropic.ts` | "cannot be constructed without LIVE=1" |
| Evals run offline on a scripted or recorded model | `src/llm/scripted.ts` | "saves real responses, then replays them in order" |
| Single agent, with the reason given | `docs/DESIGN.md` | "covers all 36 required scenarios" |

## 5. Deliverables

| Deliverable | Where |
|---|---|
| Git repo with implementation, mocks, tests and README | `README.md` |
| Design note, max 1 page | `docs/DESIGN.md` |
| Generated eval table | `docs/eval-table.md` |
| Three real bugs | `docs/BUGS.md` |
| End-to-end trace with timeout after success | `docs/traces/timeout-after-success.jsonl` |
| Demo recording | Recorded by Punyakrit. Script in `docs/DEMO-SCRIPT.md` |
| Transcript of AI coding assistants | `docs/ai-transcript.md`, added last |
