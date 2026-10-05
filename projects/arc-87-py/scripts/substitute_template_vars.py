"""Write a Tealer-friendly copy of the approval program with template variables substituted.

Tealer refuses to analyze TEAL that still contains ``TMPL_*`` placeholders, so ``audit-teal``
substitutes the values the demo deploys with (``DELETABLE=1``, ``UPDATABLE=0``) into
``smart_contracts/artifacts/audit/ARC87.approval.teal`` before running the analysis.
"""

from __future__ import annotations

import sys
from pathlib import Path

ARTIFACTS = Path(__file__).resolve().parents[1] / "smart_contracts" / "artifacts"
TEMPLATE_VARS = {"TMPL_DELETABLE": "1", "TMPL_UPDATABLE": "0"}


def main() -> int:
    source = ARTIFACTS / "ARC87.approval.teal"
    if not source.exists():
        print(f"{source} not found - run `algokit project run build` first", file=sys.stderr)
        return 1
    teal = source.read_text(encoding="utf-8")
    for name, value in TEMPLATE_VARS.items():
        teal = teal.replace(name, value)
    target = ARTIFACTS / "audit" / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(teal, encoding="utf-8")
    print(f"wrote {target.relative_to(ARTIFACTS.parents[1])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
