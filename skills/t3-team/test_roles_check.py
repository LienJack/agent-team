"""Tests for roles_check.py: `python3 -m unittest -v test_roles_check` from this directory."""
from __future__ import annotations

import copy
import datetime as dt
import json
import unittest
from pathlib import Path

import roles_check

HERE = Path(__file__).resolve().parent
TODAY = dt.date(2026, 11, 23)


def load() -> dict:
    return json.loads((HERE / "roles.json").read_text())


class RolesCheckTest(unittest.TestCase):
    def test_shipped_file_has_no_errors(self):
        errors, _ = roles_check.check(load(), today=TODAY)
        self.assertEqual(errors, [])

    def test_unknown_alias(self):
        d = load()
        d["roles"]["impl_B"]["fallback"] = ["nope"]
        errors, _ = roles_check.check(d, today=TODAY)
        self.assertTrue(any("unknown model alias 'nope'" in e for e in errors))

    def test_same_family_only_reviewers_is_an_error(self):
        d = load()
        d["review"]["A"] = ["sonnet", "haiku"]  # impl_A is opus: anthropic
        errors, _ = roles_check.check(d, today=TODAY)
        self.assertTrue(any("review A: no reviewer outside family anthropic" in e for e in errors))

    def test_paid_primary_needs_subscription_fallback(self):
        d = load()
        d["roles"]["impl_C"]["fallback"] = []
        errors, _ = roles_check.check(d, today=TODAY)
        self.assertTrue(any("paid primary deepseek" in e for e in errors))

    def test_stale_file_warns(self):
        _, warnings = roles_check.check(load(), today=TODAY + dt.timedelta(days=60))
        self.assertTrue(any("days old" in w for w in warnings))

    def test_capabilities(self):
        caps = {"providers": [
            {"providerInstanceId": "claudeAgent", "canRunChildTask": True, "omittedModels": 10,
             "models": [{"id": "claude-opus-5-5", "options": [{"id": "effort"}]}]},
            {"providerInstanceId": "codex", "canRunChildTask": True, "omittedModels": 0,
             "models": [{"id": "gpt-6.2-sol", "options": [{"id": "reasoningEffort"}]}]},
            {"providerInstanceId": "antigravity", "canRunChildTask": False, "constraints": ["Provider instance is disabled."],
             "models": []},
        ]}
        errors, warnings = roles_check.check(load(), caps, today=TODAY)
        self.assertTrue(any("gpt-6.2-astra not offered by codex" in e for e in errors))
        self.assertTrue(any("antigravity cannot run child tasks" in e for e in errors))
        self.assertTrue(any("driver opencode not in capabilities" in e for e in errors))
        self.assertTrue(any("claude-sonnet-5-5 not in claudeAgent's short list" in w for w in warnings))
        self.assertFalse(any("model opus:" in e for e in errors))

    def test_wrong_option_key(self):
        d = copy.deepcopy(load())
        d["models"]["opus"]["options"] = {"reasoningEffort": "high"}
        caps = {"providers": [{"providerInstanceId": "claudeAgent", "canRunChildTask": True,
                               "models": [{"id": "claude-opus-5-5", "options": [{"id": "effort"}]}]}]}
        errors, _ = roles_check.check(d, caps, today=TODAY)
        self.assertTrue(any("option 'reasoningEffort' not accepted" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
