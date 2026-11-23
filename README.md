# agent-team → t3-team

Multi-agent development led by a Team Leader, running inside [T3 Code](https://github.com/pingdotgg/t3code).
This repository used to be a self-built service (Node server, SQLite, own runners, board, CLI, MCP). That service
is retired (see `docs/adr/0027-retire-the-service.md`); T3 Code now runs the agents, and this repo keeps only the
Leader as a skill.

## What it does

One T3 thread in the target project becomes the Team Leader and runs five phases:

1. **需求訪談**: it reads the code, asks only the questions whose answer changes scope, architecture, cost or
   "done" (usually 1-3, each with a recommended answer), and plays back a summary with its assumptions.
2. **架構選型**: for decisions with a real trade-off it researches and shows 2-3 options; you pick; the decision and
   the rejected options are recorded.
3. **規格與工單**: large changes get a PRD, design and task list in the OpenSpec layout; tasks become tickets with
   owned paths and acceptance criteria.
4. **派工**: each ticket goes to a T3 delegate in its own git worktree, on the model its role and tier call for
   (`roles.json`).
5. **協作與把關**: workers run in parallel; `gate.py` verifies each result (real git changes inside the owned
   paths, the project's checks, commit of only the verified files); a reviewer from another model family checks it,
   with proofs the Leader reruns; at most two fix rounds; you approve every merge.

## Files

| file | what |
| --- | --- |
| `skills/t3-team/SKILL.md` | the Leader's instructions |
| `skills/t3-team/roles.json` | which model does which job, with fallbacks and the evidence for each choice |
| `skills/t3-team/roles_check.py` | validates `roles.json`, optionally against a saved `orchestrator_capabilities` output |
| `skills/t3-team/gate.py` | deterministic verifier for a worker's worktree (Python 3 stdlib) |
| `skills/t3-team/test_*.py` | unit tests (temporary git repos only) |
| `docs/adr/` | design history, including the retired service's decisions |

## Install

```sh
ln -s "$PWD/skills/t3-team" ~/.claude/skills/t3-team    # Claude Code
ln -s "$PWD/skills/t3-team" ~/.codex/skills/t3-team     # Codex
```

Needs T3 Code with its orchestrator MCP, Python 3.9+ and git. No server, no database, no Node.

## Use

In T3 Code, open a thread **in the target project** (`delegate_task` only makes worktrees of the calling thread's
project) and type:

```
/t3-team <what you want built>
```

Say 無人值班 / unattended when you step away: the Leader then takes its recommended choice on each decision, logs it,
and only does local, reversible things (no push, no PR, no deleting data, no paid models).

## Test

```sh
cd skills/t3-team && python3 -m unittest -v
```

## History

The service lives on in git history (`main` before the retirement commit) and in the ADRs. The first real run of
t3-team built learn-anything's teaching and Q&A modes and wrote a 9-chapter textbook (2026-11-23); its per-ticket
metrics are in `~/RanoLabs/research/agent-team/t3-team-metrics/`.
