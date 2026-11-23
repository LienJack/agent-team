#!/usr/bin/env python3
"""Check t3-team's roles.json before a run (Python 3.9+ stdlib).

Static checks: every alias a role, fallback, pick or review list names exists in `models`; for every implementer
a tier can end up with (primary and fallbacks), its review list has a candidate from another model family (error)
and preferably two (warning); every paid primary has a subscription fallback; the file is not stale.

With --capabilities FILE (the JSON printed by T3's `orchestrator_capabilities`, saved by the leader, since a script
cannot call MCP): each alias's driver exists and can run child tasks, and its model id is listed. A model missing
from a provider's short list that has `omittedModels` is only a warning (look it up with `search`).

Prints one line per finding; exit 1 if there is any error, 0 otherwise.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

SPECIAL = {"leader", "same as implementer"}


def aliases_of(role: dict) -> list[str]:
    out = []
    for key in ("use", "fallback", "pick"):
        v = role.get(key)
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list):
            out.extend(v)
    return [a for a in out if a not in SPECIAL]


def check(data: dict, caps: dict | None = None, today: dt.date | None = None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    models = data.get("models", {})
    roles = data.get("roles", {})
    review = data.get("review", {})
    rules = data.get("rules", {})

    for name, m in models.items():
        for k in ("driver", "model", "family", "cost"):
            if not m.get(k):
                errors.append(f"model {name}: missing {k}")
    for name, role in roles.items():
        for a in aliases_of(role):
            if a not in models:
                errors.append(f"role {name}: unknown model alias {a!r}")
    for tier, cands in review.items():
        for a in cands:
            if a not in models:
                errors.append(f"review {tier}: unknown model alias {a!r}")

    # reviewers from another family for every implementer the tier can end up with
    for tier, cands in review.items():
        impl = roles.get(f"impl_{tier}")
        if not impl:
            warnings.append(f"review {tier}: no impl_{tier} role")
            continue
        for a in aliases_of(impl):
            if a not in models:
                continue
            fam = models[a]["family"]
            other = {models[c]["family"] for c in cands if c in models and models[c]["family"] != fam}
            if not other:
                errors.append(f"review {tier}: no reviewer outside family {fam} (implementer {a})")
            elif len(other) < 2:
                warnings.append(f"review {tier}: only one other family for implementer {a} ({', '.join(sorted(other))})")

    # paid primaries need a subscription fallback
    for name, role in roles.items():
        use = role.get("use")
        if use in models and models[use]["cost"] == "paid":
            fb = [f for f in role.get("fallback", []) if f in models and models[f]["cost"] == "subscription"]
            if not fb:
                errors.append(f"role {name}: paid primary {use} has no subscription fallback")

    # staleness
    try:
        updated = dt.date.fromisoformat(data.get("updated", ""))
        age = ((today or dt.date.today()) - updated).days
        if age > int(rules.get("stale_after_days", 30)):
            warnings.append(f"roles.json is {age} days old; re-check models against orchestrator_capabilities")
    except ValueError:
        warnings.append("roles.json: 'updated' is not an ISO date")

    if caps is not None:
        providers = {p.get("providerInstanceId"): p for p in caps.get("providers", [])}
        for name, m in models.items():
            p = providers.get(m["driver"])
            if p is None:
                errors.append(f"model {name}: driver {m['driver']} not in capabilities")
                continue
            if not p.get("canRunChildTask", False):
                errors.append(f"model {name}: driver {m['driver']} cannot run child tasks ({'; '.join(p.get('constraints', []))})")
                continue
            ids = {x.get("id") for x in p.get("models", [])}
            if m["model"] not in ids:
                if p.get("omittedModels"):
                    warnings.append(f"model {name}: {m['model']} not in {m['driver']}'s short list; confirm with orchestrator_capabilities search")
                else:
                    errors.append(f"model {name}: {m['model']} not offered by {m['driver']}")
                continue
            opts = {o.get("id") for x in p.get("models", []) if x.get("id") == m["model"] for o in x.get("options", [])}
            for k in m.get("options", {}):
                if opts and k not in opts:
                    errors.append(f"model {name}: option {k!r} not accepted by {m['model']} ({', '.join(sorted(opts))})")
    return errors, warnings


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Check t3-team roles.json")
    ap.add_argument("--roles", default=str(here / "roles.json"))
    ap.add_argument("--capabilities", help="JSON saved from orchestrator_capabilities")
    a = ap.parse_args(argv)
    data = json.loads(Path(a.roles).read_text())
    caps = json.loads(Path(a.capabilities).read_text()) if a.capabilities else None
    errors, warnings = check(data, caps)
    for e in errors:
        print(f"ERROR {e}")
    for w in warnings:
        print(f"WARN  {w}")
    if not errors and not warnings:
        print("OK")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
