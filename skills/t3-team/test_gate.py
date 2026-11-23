"""Tests for gate.py: `python3 -m unittest -v test_gate` from this directory. Temporary repos only."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import gate


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t3-gate-test-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        sh(self.repo, "init", "-q", "-b", "main")
        sh(self.repo, "config", "user.email", "t@example.invalid")
        sh(self.repo, "config", "user.name", "t")
        (self.repo / "src").mkdir()
        (self.repo / "src" / "a.py").write_text("a = 1\n")
        (self.repo / ".gitignore").write_text("*.log\n")
        sh(self.repo, "add", ".")
        sh(self.repo, "commit", "-q", "-m", "init")
        self.base = sh(self.repo, "rev-parse", "HEAD").strip()
        self.wt = self.tmp / "wt"
        sh(self.repo, "worktree", "add", "-q", "-b", "feature", str(self.wt))
        # a hook that would fail any commit: the gate must not run it
        hooks = self.repo / ".git" / "hooks"
        hooks.mkdir(exist_ok=True)
        (hooks / "pre-commit").write_text("#!/bin/sh\nexit 1\n")
        (hooks / "pre-commit").chmod(0o755)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_gate(self, **kw):
        a = SimpleNamespace(repo=str(self.repo), worktree=str(self.wt), base=self.base, base_branch="main",
                            paths="src/", check=[], message="team(T1): test", no_commit=False, timeout=60,
                            log_dir=str(self.tmp / "logs"))
        for k, v in kw.items():
            setattr(a, k, v)
        return gate.gate(a)

    def test_pass_commits_only_verified_files_without_hooks(self):
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        (self.wt / "src" / "new.py").write_text("b = 1\n")
        r = self.run_gate(check=["ok=true"])
        self.assertEqual(r["verdict"], "pass", r)
        self.assertTrue(r["committed"])
        self.assertEqual(r["files_changed"], ["src/a.py", "src/new.py"])
        self.assertEqual(sh(self.wt, "status", "--porcelain"), "")
        self.assertEqual(sh(self.wt, "log", "-1", "--format=%s").strip(), "team(T1): test")

    def test_out_of_scope_rejected(self):
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        (self.wt / "README.md").write_text("x\n")
        r = self.run_gate()
        self.assertEqual(r["verdict"], "rejected")
        self.assertEqual(r["out_of_scope"], ["README.md"])
        self.assertFalse(r["committed"])

    def test_untracked_counts_and_ignored_does_not(self):
        (self.wt / "src" / "x.log").write_text("ignored\n")
        r = self.run_gate()
        self.assertIn("no changes", " ".join(r["reasons"]))
        (self.wt / "src" / "u.py").write_text("u\n")
        self.assertEqual(self.run_gate(no_commit=True)["files_changed"], ["src/u.py"])

    def test_primary_checkout_rejected(self):
        (self.repo / "src" / "a.py").write_text("a = 3\n")
        r = self.run_gate(worktree=str(self.repo))
        self.assertIn("primary checkout", " ".join(r["reasons"]))

    def test_detached_head_rejected(self):
        sh(self.wt, "checkout", "-q", "--detach")
        r = self.run_gate()
        self.assertIn("detached", " ".join(r["reasons"]))

    def test_rename_from_outside_counts_both_paths(self):
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "x.md").write_text("doc\n" * 20)
        sh(self.repo, "add", ".")
        sh(self.repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "doc")
        self.base = sh(self.repo, "rev-parse", "HEAD").strip()
        sh(self.wt, "merge", "-q", "--ff-only", "main")
        sh(self.wt, "mv", "docs/x.md", "src/x.md")
        r = self.run_gate(no_commit=True)
        self.assertEqual(r["verdict"], "rejected", r)
        self.assertIn("docs/x.md", r["out_of_scope"])
        sh(self.wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "mv")
        r = self.run_gate(no_commit=True)
        self.assertIn("docs/x.md", r["out_of_scope"])

    def test_head_on_base_branch_rejected(self):
        sh(self.repo, "branch", "-q", "other")
        r = self.run_gate(base_branch="feature")
        self.assertIn("base branch", " ".join(r["reasons"]))

    def test_base_not_ancestor_rejected(self):
        (self.repo / "other.txt").write_text("o\n")
        sh(self.repo, "add", ".")
        sh(self.repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "other")
        newer = sh(self.repo, "rev-parse", "HEAD").strip()
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        r = self.run_gate(base=newer)
        self.assertIn("not an ancestor", " ".join(r["reasons"]))

    def test_failing_check_no_commit(self):
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        r = self.run_gate(check=["boom=echo broken; exit 3"])
        self.assertEqual(r["verdict"], "checks_failed")
        self.assertEqual(r["checks"][0]["result"], "fail")
        self.assertIn("broken", r["checks"][0]["tail"])
        self.assertFalse(r["committed"])
        self.assertNotEqual(sh(self.wt, "status", "--porcelain"), "")

    def test_file_created_by_check_rejected(self):
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        r = self.run_gate(check=["sneak=echo x > src/sneak.py"])
        self.assertEqual(r["verdict"], "rejected")
        self.assertIn("changed while the checks ran", " ".join(r["reasons"]))
        self.assertFalse(r["committed"])

    def test_rerun_after_commit_is_idempotent(self):
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        self.assertTrue(self.run_gate()["committed"])
        r = self.run_gate()
        self.assertEqual(r["verdict"], "pass")
        self.assertFalse(r["committed"])

    def test_checks_do_not_see_secret_env(self):
        import os
        os.environ["FAKE_API_KEY"] = "s3cret"
        try:
            (self.wt / "src" / "a.py").write_text("a = 2\n")
            r = self.run_gate(check=["env=env"], no_commit=True)
            self.assertNotIn("s3cret", r["checks"][0]["tail"])
        finally:
            del os.environ["FAKE_API_KEY"]

    def test_owned_path_rules(self):
        self.assertEqual(gate.normalize_owned(".gitignore"), ".gitignore")
        self.assertEqual(gate.normalize_owned("./src/"), "src")
        self.assertEqual(gate.normalize_owned("."), "")
        for bad in ["/abs", "a/../b", "a\\b", "a//b", ""]:
            with self.assertRaises(gate.GateError):
                gate.normalize_owned(bad)
        self.assertTrue(gate.is_owned("tests/test_cli_x.py", ["tests/test_cli*.py"], False))
        self.assertFalse(gate.is_owned("tests/other.py", ["tests/test_cli*.py"], False))
        self.assertTrue(gate.is_owned("src/a/b/c.py", ["src/*"], False))
        self.assertTrue(gate.is_owned("anything", [""], False))
        self.assertTrue(gate.is_owned("SRC/A.py", ["src/"], True))

    def test_cli_json_and_exit_code(self):
        (self.wt / "src" / "a.py").write_text("a = 2\n")
        p = subprocess.run(["python3", str(Path(gate.__file__)), "--repo", str(self.repo), "--worktree", str(self.wt),
                            "--base", self.base, "--paths", "src/", "--no-commit"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["verdict"], "pass")


if __name__ == "__main__":
    unittest.main()
