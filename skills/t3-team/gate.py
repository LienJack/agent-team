#!/usr/bin/env python3
"""t3-team gate: verify a worker's worktree before anything is committed.

Standalone (Python 3.9+ stdlib, no service). The Team Leader runs it instead of trusting a worker's report:

1. Identity: the worktree is a linked worktree of --repo (not the primary checkout), HEAD is on a branch that is
   not --base-branch, and --base is an ancestor of HEAD.
2. Changed files = base..HEAD  ∪ uncommitted  ∪ untracked-not-ignored. Empty -> rejected. Any file outside
   --paths (owned paths: repo-relative POSIX paths or globs, `.` = whole repo) -> rejected.
3. Every --check runs in the worktree (shell, timeout, environment without obvious secrets). Any failure ->
   checks_failed. Full output goes to --log-dir, the result keeps the last 20 lines.
4. The changed-file list and HEAD are recomputed; any difference -> rejected (a check created or removed files).
5. Unless --no-commit: `git add` only the verified files and commit with hooks disabled.

Output: JSON on stdout ({verdict: pass|rejected|checks_failed, reasons, files_changed, out_of_scope, checks,
head_sha, committed}). Exit 0 on pass, 1 otherwise, 2 on usage errors.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TAIL_LINES = 20
SECRET_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)", re.I)
KEEP_ENV = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"}


class GateError(Exception):
    pass


def git(cwd: Path, *args: str, check: bool = True) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    p = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=env)
    if check and p.returncode != 0:
        raise GateError(f"git {' '.join(args)} failed: {p.stderr.strip()}")
    return p.stdout


# ---- owned paths (same rules as agent-team's core/util/paths.ts) -------------------------------------------

def normalize_owned(path: str) -> str:
    p = path.strip()
    if not p or p.startswith("/") or "\\" in p or "//" in p.strip("/") or ".." in p.split("/"):
        raise GateError(f"invalid owned path: {path!r}")
    if p.startswith("./"):
        p = p[2:]
    if p in (".", ""):
        return ""
    return p.rstrip("/")


def glob_to_re(pattern: str) -> re.Pattern:
    out = []
    for seg in pattern.split("/"):
        if seg == "**":
            out.append("(?:[^/]+/)*")
            continue
        r = ""
        for ch in seg:
            r += "[^/]*" if ch == "*" else "[^/]" if ch == "?" else re.escape(ch)
        out.append(r + "/")
    rx = "".join(out)
    rx = rx[:-1] if rx.endswith("/") else rx
    return re.compile(f"^{rx}(?:/.*)?$")


def is_owned(file: str, owned: list[str], ignore_case: bool) -> bool:
    f = file.lower() if ignore_case else file
    if ".." in f.split("/"):
        return False
    for raw in owned:
        o = (raw.lower() if ignore_case else raw).rstrip("/")
        o = "" if o == "." else o
        if o == "":
            return True
        if any(c in o for c in "*?["):
            if glob_to_re(o).match(f):
                return True
        elif f == o or f.startswith(o + "/"):
            return True
    return False


# ---- git facts --------------------------------------------------------------------------------------------

def check_identity(repo: Path, wt: Path, base: str, base_branch: str) -> tuple[str, str]:
    if not wt.is_dir():
        raise GateError(f"worktree is not a directory: {wt}")
    if wt.resolve() == repo.resolve():
        raise GateError("worktree is the primary checkout")
    if not (wt / ".git").is_file():
        raise GateError("worktree .git is not a gitdir file (not a linked worktree)")
    top = Path(git(wt, "rev-parse", "--show-toplevel").strip()).resolve()
    if top != wt.resolve():
        raise GateError(f"worktree top level is {top}, not {wt}")
    common = Path(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()).resolve()
    repo_common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()).resolve()
    if common != repo_common:
        raise GateError("worktree belongs to another repository")
    listed = [Path(l[9:]).resolve() for l in git(repo, "worktree", "list", "--porcelain").splitlines() if l.startswith("worktree ")]
    if wt.resolve() not in listed:
        raise GateError("repository does not list this worktree")
    branch = git(wt, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).strip()
    if not branch:
        raise GateError("HEAD is detached; the worktree must be on a branch")
    if branch == base_branch:
        raise GateError(f"HEAD is on the base branch {base_branch}")
    base_sha = git(wt, "rev-parse", "--verify", f"{base}^{{commit}}").strip()
    if subprocess.run(["git", "-C", str(wt), "merge-base", "--is-ancestor", base_sha, "HEAD"]).returncode != 0:
        raise GateError(f"base {base_sha[:12]} is not an ancestor of HEAD")
    return branch, base_sha


def changed_files(wt: Path, base_sha: str) -> list[str]:
    files = set(git(wt, "diff", "--no-renames", "--name-only", "-z", f"{base_sha}..HEAD").split("\0"))
    files |= set(git(wt, "diff", "--no-renames", "--name-only", "-z", "HEAD").split("\0"))
    files |= set(git(wt, "ls-files", "--others", "--exclude-standard", "-z").split("\0"))
    return sorted(f for f in files if f)


def uncommitted(wt: Path) -> list[str]:
    files = set(git(wt, "diff", "--no-renames", "--name-only", "-z", "HEAD").split("\0"))
    files |= set(git(wt, "ls-files", "--others", "--exclude-standard", "-z").split("\0"))
    return sorted(f for f in files if f)


# ---- checks -----------------------------------------------------------------------------------------------

def check_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV or (k.startswith("LC_") and not SECRET_ENV.search(k))}
    env.update({"CI": "1", "GIT_TERMINAL_PROMPT": "0"})
    return env


def run_checks(wt: Path, checks: list[str], log_dir: Path, timeout: int) -> list[dict]:
    log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    results = []
    for i, spec in enumerate(checks, 1):
        name, _, cmd = spec.partition("=")
        if not cmd:
            name, cmd = f"check{i}", spec
        log = log_dir / f"{i}-{re.sub(r'[^A-Za-z0-9_-]+', '-', name)[:40]}.log"
        start = time.time()
        try:
            p = subprocess.run(cmd, shell=True, cwd=wt, env=check_env(), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
            out, ok, note = p.stdout, p.returncode == 0, f"exit {p.returncode}"
        except subprocess.TimeoutExpired as e:
            out = e.stdout if isinstance(e.stdout, str) else (e.stdout or b"").decode(errors="replace")
            ok, note = False, f"timeout after {timeout}s"
        log.write_text(out)
        results.append({"name": name, "cmd": cmd, "result": "pass" if ok else "fail", "note": note,
                        "seconds": round(time.time() - start, 1), "log": str(log),
                        "tail": "\n".join(out.splitlines()[-TAIL_LINES:])})
    return results


# ---- main -------------------------------------------------------------------------------------------------

def gate(a: argparse.Namespace) -> dict:
    repo, wt = Path(a.repo).expanduser().resolve(), Path(a.worktree).expanduser()
    res = {"verdict": "rejected", "reasons": [], "files_changed": [], "out_of_scope": [], "checks": [],
           "head_sha": None, "committed": False, "worktree": str(wt)}
    try:
        owned = [normalize_owned(p) for p in re.split(r"[,\s]+", a.paths) if p]
        if not owned:
            raise GateError("no owned paths")
        branch, base_sha = check_identity(repo, wt, a.base, a.base_branch)
        res["branch"], res["base_sha"] = branch, base_sha
        ignore_case = git(repo, "config", "--bool", "core.ignorecase", check=False).strip() == "true"
        files = changed_files(wt, base_sha)
        res["files_changed"] = files
        if not files:
            raise GateError(f"no changes since {base_sha[:12]}")
        res["out_of_scope"] = [f for f in files if not is_owned(f, owned, ignore_case)]
        if res["out_of_scope"]:
            raise GateError(f"{len(res['out_of_scope'])} file(s) outside the owned paths")
        head_before = git(wt, "rev-parse", "HEAD").strip()
        log_dir = Path(a.log_dir) if a.log_dir else Path(tempfile.mkdtemp(prefix="t3-gate-"))
        if not a.check:
            res["reasons"].append("no machine checks")
        res["checks"] = run_checks(wt, a.check, log_dir, a.timeout)
        if any(c["result"] != "pass" for c in res["checks"]):
            res["verdict"] = "checks_failed"
            res["reasons"].append("a check failed")
            return res
        if changed_files(wt, base_sha) != files or git(wt, "rev-parse", "HEAD").strip() != head_before:
            raise GateError("files or HEAD changed while the checks ran")
        to_commit = uncommitted(wt)
        if to_commit and not a.no_commit:
            git(wt, "add", "--", *to_commit)
            msg = a.message or f"team(gate): {branch}"
            git(wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg)
            res["committed"] = True
            if uncommitted(wt):
                raise GateError("worktree not clean after the commit")
        res["head_sha"] = git(wt, "rev-parse", "HEAD").strip()
        res["verdict"] = "pass"
    except GateError as e:
        res["reasons"].append(str(e))
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True, help="primary checkout of the project")
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--base", required=True, help="commit the work started from")
    ap.add_argument("--base-branch", default="main")
    ap.add_argument("--paths", required=True, help="owned paths, comma or space separated")
    ap.add_argument("--check", action="append", default=[], help='"name=cmd", repeatable')
    ap.add_argument("--message")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per check")
    ap.add_argument("--log-dir")
    a = ap.parse_args(argv)
    res = gate(a)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0 if res["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
