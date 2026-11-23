# AGENTS.md — t3-team

For agents working in this repository (`CLAUDE.md` links here). The repository is one skill: `skills/t3-team/`.
The old agent-team service was removed (docs/adr/0027); do not bring back servers, databases or Node tooling.

## Rules

- `SKILL.md` is instructions for a Leader running in T3 Code. Keep it concrete and testable; every rule should come
  from a real run or a cited source, and say so in the commit message.
- `roles.json` is the only place models are named for roles. After editing it run `python3 roles_check.py`.
- `gate.py` and `roles_check.py` use only the Python 3.9+ standard library. Change behaviour → add a test in
  `test_gate.py` / `test_roles_check.py`. Tests use temporary git repos and never touch `~/RanoLabs`, the network or
  real models.
- No secrets in files, tests, logs or commit messages; never read or print `.env`.
- No `git commit --amend`, `--no-verify` or `push --force`.

## Check

```sh
cd skills/t3-team && python3 -m unittest -v && python3 roles_check.py
```
