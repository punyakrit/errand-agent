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
| `LIVE=1 npm run record` | Re-records the real Sonnet responses in `fixtures/recordings/`, with a spend cap |
| `LIVE=1 npm run record -- --smoke happy-path` | Cheap wiring check on Haiku. Saves nothing |
| `LIVE=1 npx tsx scripts/measure-tokens.ts` | Compares the local token estimate with real counts |
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

**Recorded evals** replay real `claude-sonnet-5-5` responses saved in `fixtures/recordings/`: a full booking, a prompt injection and a timeout after success. They prove the code handles real response shapes on those exact conversations. They do not prove the model would answer the same way today, and they only cover the conversations recorded.

**The invariants can fail.** `tests/eval/invariants.test.ts` plants a violation of each one and checks that it is caught.

**Neither kind of eval measures** how often a real model gets a conversation right. That would need many live runs scored for quality, which this project does not do.

**What live runs found that evals could not.** Four of the bugs in `docs/BUGS.md` (6 to 9) only appeared against a real model or the real token counter. Scripted tests share the assumptions of whoever wrote them.

## Measured on live runs

One full booking on `claude-sonnet-5-5`: 5 model calls, about 21,500 input and 800 output tokens, about $0.05, with no call over 3.6 seconds. Tool schemas cost 2,783 tokens per call. The local token estimate ran 1.11 to 1.42 times the real count on the measured conversation. `docs/traces/timeout-after-success.jsonl` holds one conversation as 3 runs in order, because a run is one user message.

**What has run on a real model.** On `claude-sonnet-5-5`: full booking, prompt injection, timeout after success, and a full booking through the demo server. On `claude-haiku-5-5`, as a cheap smoke check with nothing saved: moving the AC service, the same electrician as last time, cancelling, and remembering and forgetting from chat. **Not run on a real model:** picking a replacement after a provider cancels, a request that matches two bookings, and crash recovery. Each of those has scripted coverage only.

## Known gaps

- **Model quality is not measured.** See above.
- **Thinking blocks are only tested with scripted data.** Sonnet returned none on these simple recorded turns, so the rule for passing them back unchanged has never run against real blocks.
- **Forgetting is exact text only.** It removes the stored value and the user's quoted words. A paraphrase elsewhere in chat stays.
- **Traces are not scrubbed.** Forgetting clears everything that reaches the model, but `traces/` files are an audit log and keep old values.
- **Evidence is a substring check.** A compromised model could quote a real user sentence to store a wrong value. It stops tool output from planting facts, not every misuse.
- **The reply guard is a pattern match.** It can miss an unusual false claim, or block an honest sentence. It is a backstop. Real outcomes are only reported by code.
- **Holds cannot be released.** The mock has no release call, so an abandoned hold simply expires after 10 minutes.
- **Unconfirmed outcomes wait.** An open op is checked again on the user's next message or at restart, not on a timer.
- **Provider names are not marked as untrusted.** Reviews and descriptions are. Names come from the catalog and are shown as they are.
- **One process, one user at a time.** The demo queues its work. Running several processes against one database is not handled.
- **Budget excludes tool schemas.** The 3,000-token budget covers the prompt, state, memories and chat. Tool definitions add 2,783 tokens per call on top, so real input is about 4,000 to 5,000 tokens.
- **The token estimate is measured on one conversation.** It stayed above the real count there, but it is a ratio, not a tokenizer, and it leaves out thinking blocks.
- **The last two messages always go in.** This keeps what the user is replying to, so the base context can pass its target. The 3,000-token limit is still enforced in the loop.
- **Recorded fixtures do not check the prompt.** They replay responses in order, so a prompt change needs a new recording to mean anything.
- **India time only.** Slots and dates assume IST.
