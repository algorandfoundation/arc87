"""Offline shims for the AVM 13 ops that ``algorand-python-testing`` 1.1.0 does not implement.

``algopy.op`` is a plain module (``from _algopy_testing.op import *``), so the missing
``AppBox`` / ``AppParamsSet`` namespaces can be monkeypatched in for every test. The fakes
are backed by the test ledger (``lazy_context.ledger``) and record the ``AppForeignBoxReads``
flag per app so tests can assert on it through the ``foreign_box_reads`` fixture.

Only the subset the ARC-87 contracts need is emulated: ``app_params_set AppForeignBoxReads``
(the store's create) and ``app_box_len`` / ``app_box_extract`` / ``app_box_get`` (the
reader's direct reads). Access-list budgets and flag enforcement are only verified on
localnet.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import algopy
import pytest
from _algopy_testing.context_helpers import lazy_context
from _algopy_testing.context_helpers.ledger_context import _get_app_id


MAX_AVM_BYTES = 4096  # largest AVM byte-string (``MaxStringSize``), the cap of ``app_box_get``


def _app_id(app: Any) -> int:
    return _get_app_id(app)


def _key(key: algopy.Bytes | bytes) -> bytes:
    return key.value if isinstance(key, algopy.Bytes) else bytes(key)


class _ForeignBoxReads:
    """Per-app ``AppForeignBoxReads`` flags (``False`` when never set, as on the AVM)."""

    def __init__(self) -> None:
        self.flags: dict[int, bool] = {}

    def get(self, app: Any) -> bool:
        return self.flags.get(_app_id(app), False)


def _box(app: Any, key: algopy.Bytes | bytes) -> tuple[bytes, bool]:
    app_id = _app_id(app)
    if not lazy_context.ledger.app_exists(app_id):
        raise ValueError(f"no app {app_id}")
    content = lazy_context.ledger.get_box(app_id, _key(key))
    return content, lazy_context.ledger.box_exists(app_id, _key(key))


class _AppBox:
    @staticmethod
    def length(a: Any, b: algopy.Bytes | bytes, /) -> tuple[algopy.UInt64, bool]:
        content, exists = _box(a, b)
        return algopy.UInt64(len(content)), exists

    @staticmethod
    def extract(a: Any, b: algopy.Bytes | bytes, c: Any, d: Any, /) -> algopy.Bytes:
        content, exists = _box(a, b)
        if not exists:
            raise ValueError("box does not exist")
        start, length = int(c), int(d)
        if start + length > len(content):
            raise ValueError("extract range beyond box size")
        return algopy.Bytes(content[start : start + length])

    @staticmethod
    def get(a: Any, b: algopy.Bytes | bytes, /) -> tuple[algopy.Bytes, bool]:
        content, exists = _box(a, b)
        # Like ``box_get``, the whole value must fit a single AVM byte-string.
        if len(content) > MAX_AVM_BYTES:
            raise ValueError(f"box_get produced a too big ({len(content)}) byte-array")
        return algopy.Bytes(content if exists else b""), exists


@pytest.fixture(autouse=True)
def foreign_box_reads(monkeypatch: pytest.MonkeyPatch) -> Iterator[_ForeignBoxReads]:
    state = _ForeignBoxReads()

    class _AppParamsSet:
        @staticmethod
        def app_foreign_box_reads(a: Any, /) -> None:
            state.flags[lazy_context.active_app_id] = bool(a)

    monkeypatch.setattr(algopy.op, "AppBox", _AppBox, raising=False)
    monkeypatch.setattr(algopy.op, "AppParamsSet", _AppParamsSet, raising=False)
    yield state
