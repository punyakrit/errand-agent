# Errand Agent

A chat agent that arranges home-service errands: it clarifies what you need, compares providers, asks for approval before acting, and recovers safely when tools fail. Everything runs locally against a mock provider. Only the model is real.

The rule behind the design: **the model suggests, plain code decides.** The model reads requests, picks tools and writes replies. Code owns approval, idempotency, retries, limits, memory rules and what goes into the context.

## Setup

Needs Node 26. A key is only needed for live runs. Tests and evals never touch the network.

```bash
npm install
cp .env.example .env
npm test
npm run eval
LIVE=1 npm run demo
```

Then open http://localhost:4000. Add your key to `.env` before running the demo.

## Commands

| Command | What it does |
|---|---|
| `npm test` | All tests, including every eval scenario and the seed sweep |
| `npm run eval` | Scenarios and sweep, then writes `docs/eval-table.md` and `docs/eval-results.json` |
| `npm run typecheck` | TypeScript check |
| `LIVE=1 npm run demo` | Chat and live trace at `localhost:4000` |
| `LIVE=1 npm run record` | Re-records the real model responses in `fixtures/recordings/` |
| `npm run design:pdf` | Renders `docs/DESIGN.md` to one page |

## Architecture

```
user message
   |
   v
Agent.handleMessage ---- plain yes while waiting? ----> gate ----> executor ----> mock tools
   |                                                     ^            |
   | anything else                                       |            +--> get_booking_status
   v                                                     |
tool loop <--> model                                     |
   |   model tools: update_request, ask_user, search, hold, request_approval, memory
   |   book / cancel / reschedule always return approval_required
   v
finish(reason) --> one user message, state saved, trace closed
```

- **Two SQLite files.** `mock.sqlite` stands in for the provider and `agent.sqlite` is ours. They never share a transaction, so recovery has to work the way it would against a real service.
- **A single agent.** One tool loop, written by hand. `docs/DESIGN.md` explains why.

## Reading order

1. `src/mock/types.ts`, `src/mock/env.ts`: the 8 tools and the mock provider
2. `src/agent/state.ts`, `src/agent/request.ts`: the workflow table and request merging
3. `src/agent/loop.ts`, `src/agent/tools/`, `src/agent/finish.ts`: the tool loop and its exits
4. `src/agent/approvals.ts`, `src/agent/gate.ts`: approval and the fingerprint check
5. `src/agent/executor.ts`, `src/agent/ops.ts`, `src/agent/recovery.ts`: acting and recovering
6. `src/memory/`, `src/agent/context.ts`: memory and the context budget
7. `src/monitor/`: proactive rebooking
8. `src/eval/`: scenarios, invariants and the generated table
9. `src/demo/`: the local server and page

## What the evals prove

`npm run eval` runs every scenario and a 500-seed sweep offline. After each scenario, 7 invariants are checked from the mock's own log and the trace.

**Scripted evals** use a fake model whose tool calls are written in the scenario. They prove that **the code around the model holds**: even when a model misbehaves on purpose, for example by obeying a prompt injection, code blocks it, and booking, recovery and memory rules stay correct. They do not prove that a real model will choose well, word things well, or follow the prompt. A scripted scenario passing says nothing about model quality.

**Recorded evals** replay real `claude-sonnet-5-5` responses saved in `fixtures/recordings/`. They prove the code handles real response shapes, including thinking blocks, on those exact conversations. They do not prove the model would answer the same way today, and they only cover the conversations recorded.

**The invariants can fail.** `tests/eval/invariants.test.ts` plants a violation of each one and checks that it is caught.

**Neither kind of eval measures** how often a real model gets a conversation right. That would need many live runs scored for quality, which this project does not do.

## Known gaps

- **Model quality is not measured.** See above.
- **Forgetting is exact text only.** It removes the stored value and the user's quoted words. A paraphrase elsewhere in chat stays.
- **Traces are not scrubbed.** Forgetting clears everything that reaches the model, but `traces/` files are an audit log and keep old values.
- **Evidence is a substring check.** A compromised model could quote a real user sentence to store a wrong value. It stops tool output from planting facts, not every misuse.
- **The reply guard is a pattern match.** It can miss an unusual false claim, or block an honest sentence. It is a backstop. Real outcomes are only reported by code.
- **Holds cannot be released.** The mock has no release call, so an abandoned hold simply expires after 10 minutes.
- **Unconfirmed outcomes wait.** An open op is checked again on the user's next message or at restart, not on a timer.
- **Provider names are not marked as untrusted.** Reviews and descriptions are. Names come from the catalog and are shown as they are.
- **One process, one user at a time.** The demo queues its work. Running several processes against one database is not handled.
- **Budget excludes tool schemas.** The 3,000-token budget covers the prompt, state, memories and chat. Tool definitions are a fixed cost on top. The local estimate is deliberately high.
- **India time only.** Slots and dates assume IST.
