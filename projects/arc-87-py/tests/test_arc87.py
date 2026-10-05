"""ARC-87 Python tests.

Two layers are covered:

1. The ``ARC87`` contract (``smart_contracts/arc87.py``) via ``algorand-python-testing``:
   ``set``/``remove``/``concat`` (and their bytes twins) store under the ``o_`` prefix
   exactly the full box keys produced by the client-side key rules, the ``length``/
   ``extract`` reads are public while writes stay creator-only, and every hardening rule
   (no rekey, size limits, update/delete gates, reclaim guards, 1018-byte extract cap,
   foreign reads always on) holds. The AVM 13 ``app_params_set`` op is emulated by
   ``conftest.py``.
2. The shared ``../conformance/vectors/*.json`` files, validated with ``keys.py`` (the
   Python mirror of ``@algorandfoundation/arc87``) so both languages agree on every rule.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Any

import algopy
import pytest
from algopy_testing import AlgopyTestContext, algopy_testing_context

from smart_contracts.arc87 import ARC87
from tests import keys

if TYPE_CHECKING:
    from tests.conftest import _ForeignBoxReads

VECTORS = Path(__file__).resolve().parents[2] / "conformance" / "vectors"


def load(name: str) -> dict[str, Any]:
    with (VECTORS / f"{name}.json").open(encoding="utf-8") as fh:
        return json.load(fh)


PATHS = load("paths")
NORMALIZE = load("normalize")
ESCAPE = load("escape")
MBR = load("mbr")


def ids(cases: list[dict[str, Any]]) -> list[str]:
    return [c["name"] for c in cases]


# --- contract ---------------------------------------------------------------


@pytest.fixture()
def context() -> Iterator[AlgopyTestContext]:
    with algopy_testing_context() as ctx:
        yield ctx


DELETE = algopy.OnCompleteAction.DeleteApplication
UPDATE = algopy.OnCompleteAction.UpdateApplication


def bare_call(context: AlgopyTestContext, on_completion: algopy.OnCompleteAction, **overrides: Any):
    """Group for invoking a bare method.

    ``algorand-python-testing`` (0.4.x and still 1.1.0) stores the single ``allow_actions``
    entry of a bare method as a plain ``str`` when no group is active and then fails on
    ``.name``, so the ``OnCompleteAction`` must always be supplied explicitly.
    """
    return context.txn.create_group(active_txn_overrides={"on_completion": on_completion, **overrides})


@pytest.fixture()
def contract(context: AlgopyTestContext) -> ARC87:
    # With an explicit bare create handler the app stays "creating" until it has been called.
    app = ARC87()
    with bare_call(context, algopy.OnCompleteAction.NoOp):
        app.on_create()
    return app


def box(context: AlgopyTestContext, contract: ARC87, path: str) -> bytes:
    return context.ledger.get_box(contract, keys.PREFIX.encode() + path.encode("utf-8"))


def has_box(context: AlgopyTestContext, contract: ARC87, path: str) -> bool:
    return context.ledger.box_exists(contract, keys.PREFIX.encode() + path.encode("utf-8"))


def read(contract: ARC87, path: str) -> algopy.Bytes:
    """The whole value under ``path`` read back through the public ABI (``length`` + ``extract``)."""
    p = algopy.String(path)
    return contract.extract(p, algopy.UInt64(0), contract.length(p))


def test_contract_prefix_matches_vectors(contract: ARC87) -> None:
    assert keys.PREFIX == PATHS["prefix"] == MBR["constants"]["PREFIX"]
    assert contract.public.key_prefix == keys.PREFIX.encode()


def test_set_and_read_back(context: AlgopyTestContext, contract: ARC87) -> None:
    contract.set(algopy.String("metadata.rp"), algopy.String("algorand.co"))
    assert box(context, contract, "metadata.rp") == b"algorand.co"
    assert read(contract, "metadata.rp") == algopy.Bytes(b"algorand.co")


def test_set_overwrites(context: AlgopyTestContext, contract: ARC87) -> None:
    contract.set(algopy.String("index"), algopy.String("1"))
    contract.set(algopy.String("index"), algopy.String("2"))
    assert box(context, contract, "index") == b"2"


def test_read_missing_fails(contract: ARC87) -> None:
    with pytest.raises(AssertionError, match="path not found"):
        contract.length(algopy.String("missing"))
    with pytest.raises(AssertionError, match="path not found"):
        contract.extract(algopy.String("missing"), algopy.UInt64(0), algopy.UInt64(0))


def test_remove(context: AlgopyTestContext, contract: ARC87) -> None:
    contract.set(algopy.String("blobs[0]"), algopy.String("..."))
    assert has_box(context, contract, "blobs[0]")
    # `remove` deletes the prefixed box (`o_blobs[0]`), the same one `set` wrote.
    contract.remove(algopy.String("blobs[0]"))
    assert not has_box(context, contract, "blobs[0]")
    with pytest.raises(AssertionError):
        contract.remove(algopy.String("blobs[0]"))


def test_concat(context: AlgopyTestContext, contract: ARC87) -> None:
    contract.set(algopy.String("blobs[1]"), algopy.String("abc"))
    contract.concat(algopy.String("blobs[1]"), algopy.String("def"))
    assert box(context, contract, "blobs[1]") == b"abcdef"
    with pytest.raises(AssertionError):
        contract.concat(algopy.String("nope"), algopy.String("x"))


def test_concat_past_stack_limit(context: AlgopyTestContext, contract: ARC87) -> None:
    """``concat`` uses ``op.Box.resize``/``replace`` so the box can grow past 4096 bytes.

    Offline harness still builds each ABI argument on the stack, so each chunk is
    4094 bytes (ABI length-prefix overhead). Multiple concats grow the box without
    ever materialising the full value as a single stack item.
    """
    chunk = "a" * 4094
    contract.set(algopy.String("big"), algopy.String(chunk))
    contract.concat(algopy.String("big"), algopy.String(chunk))
    assert len(box(context, contract, "big")) == 4094 * 2
    contract.concat(algopy.String("big"), algopy.String("xyz"))
    assert box(context, contract, "big").endswith(b"xyz")
    assert len(box(context, contract, "big")) == 4094 * 2 + 3


def test_set_and_read_back_bytes(context: AlgopyTestContext, contract: ARC87) -> None:
    """``setBytes`` + ``length``/``extract`` round-trip raw (non-UTF-8) bytes; text and bytes share one map."""
    raw = b"\xff\x00\xfe"
    contract.set_bytes(algopy.String("bin"), algopy.Bytes(raw))
    assert box(context, contract, "bin") == raw
    assert contract.length(algopy.String("bin")) == algopy.UInt64(3)
    assert read(contract, "bin") == algopy.Bytes(raw)
    # Whatever was written last wins.
    contract.set(algopy.String("bin"), algopy.String("text"))
    assert read(contract, "bin") == algopy.Bytes(b"text")
    contract.set_bytes(algopy.String("bin"), algopy.Bytes(b"raw"))
    assert box(context, contract, "bin") == b"raw"


def test_concat_bytes_past_stack_limit(context: AlgopyTestContext, contract: ARC87) -> None:
    chunk = algopy.Bytes(b"\xab" * 4094)
    contract.set_bytes(algopy.String("bigbin"), chunk)
    contract.concat_bytes(algopy.String("bigbin"), chunk)
    contract.concat_bytes(algopy.String("bigbin"), algopy.Bytes(b"\x01\x02"))
    stored = box(context, contract, "bigbin")
    assert len(stored) == 4094 * 2 + 2
    assert contract.length(algopy.String("bigbin")) == algopy.UInt64(4094 * 2 + 2)
    assert stored.endswith(b"\x01\x02")
    with pytest.raises(AssertionError, match="path not found"):
        contract.concat_bytes(algopy.String("nope"), chunk)


def test_extract(contract: ARC87) -> None:
    """``extract`` returns slices and rejects ranges beyond the box."""
    path = algopy.String("blobs[2]")
    contract.set(path, algopy.String("abcdef"))
    assert contract.extract(path, algopy.UInt64(0), algopy.UInt64(6)) == algopy.Bytes(b"abcdef")
    assert contract.extract(path, algopy.UInt64(3), algopy.UInt64(3)) == algopy.Bytes(b"def")
    assert contract.extract(path, algopy.UInt64(6), algopy.UInt64(0)) == algopy.Bytes(b"")
    with pytest.raises(AssertionError, match="extract out of range"):
        contract.extract(path, algopy.UInt64(3), algopy.UInt64(4))
    with pytest.raises(AssertionError, match="extract out of range"):
        contract.extract(path, algopy.UInt64(7), algopy.UInt64(0))


def test_extract_capped_at_log_size(contract: ARC87) -> None:
    """``extract`` refuses slices over 1018 bytes, the most that fits a readonly log."""
    path = algopy.String("big")
    contract.set(path, algopy.String("a" * 4094))
    assert contract.extract(path, algopy.UInt64(0), algopy.UInt64(1018)).length == algopy.UInt64(1018)
    assert contract.extract(path, algopy.UInt64(4094 - 1018), algopy.UInt64(1018)).length == algopy.UInt64(1018)
    with pytest.raises(AssertionError, match="slice exceeds 1018 bytes"):
        contract.extract(path, algopy.UInt64(0), algopy.UInt64(1019))
    # The cap is checked before the box is touched, so it also applies to missing paths.
    with pytest.raises(AssertionError, match="slice exceeds 1018 bytes"):
        contract.extract(algopy.String("missing"), algopy.UInt64(0), algopy.UInt64(1019))


def test_anyone_reads_only_creator_writes(context: AlgopyTestContext, contract: ARC87) -> None:
    contract.set(algopy.String("k"), algopy.String("v"))
    other = context.any.account()
    with context.txn.create_group(active_txn_overrides={"sender": other}):
        assert contract.length(algopy.String("k")) == algopy.UInt64(1)
        assert contract.extract(algopy.String("k"), algopy.UInt64(0), algopy.UInt64(1)) == algopy.Bytes(b"v")

        writes = (
            lambda: contract.set(algopy.String("alice"), algopy.String("x")),
            lambda: contract.set_bytes(algopy.String("alice"), algopy.Bytes(b"x")),
            lambda: contract.concat(algopy.String("k"), algopy.String("x")),
            lambda: contract.concat_bytes(algopy.String("k"), algopy.Bytes(b"x")),
            lambda: contract.remove(algopy.String("k")),
            lambda: contract.reclaim(algopy.UInt64(1)),
        )
        for write in writes:
            with pytest.raises(AssertionError, match="creator only"):
                write()
    assert box(context, contract, "k") == b"v"
    assert not has_box(context, contract, "alice")


def test_foreign_reads_flag(contract: ARC87, foreign_box_reads: _ForeignBoxReads) -> None:
    """Create enables ``AppForeignBoxReads``; no method can turn it off."""
    assert foreign_box_reads.get(contract) is True
    assert not hasattr(contract, "set_foreign_reads")


# --- maxValue ---------------------------------------------------------------

MAX_STRUCT_SIZE = 4094  # largest leaf a consumer can load whole onto the AVM stack


def max_value_of(context: AlgopyTestContext, contract: ARC87) -> int:
    """The ``maxValue`` global read from the ledger, as a consumer would with ``app_global_get_ex``."""
    value = context.ledger.get_global_state(contract, b"maxValue")
    assert isinstance(value, int | algopy.UInt64)
    return int(value)


def create_with(context: AlgopyTestContext, max_value: int) -> ARC87:
    app = ARC87()
    with bare_call(context, algopy.OnCompleteAction.NoOp):
        app.create(algopy.UInt64(max_value))
    return app


def test_bare_create_defaults_max_value(context: AlgopyTestContext, contract: ARC87) -> None:
    assert max_value_of(context, contract) == keys.MAX_BOX_SIZE
    assert contract.max_value.value == keys.MAX_BOX_SIZE


def test_create_records_max_value(context: AlgopyTestContext, foreign_box_reads: _ForeignBoxReads) -> None:
    """``create(uint64)`` stores the cap and enables foreign reads like the bare create."""
    capped = create_with(context, MAX_STRUCT_SIZE)
    assert max_value_of(context, capped) == MAX_STRUCT_SIZE
    assert foreign_box_reads.get(capped) is True
    assert not hasattr(capped, "set_max_value")


@pytest.mark.parametrize("bad", [0, keys.MAX_BOX_SIZE + 1, 2**64 - 1])
def test_create_rejects_max_value_out_of_range(context: AlgopyTestContext, bad: int) -> None:
    with pytest.raises(AssertionError, match="maxValue out of range"):
        create_with(context, bad)


@pytest.mark.parametrize("ok", [1, MAX_STRUCT_SIZE, keys.MAX_BOX_SIZE])
def test_create_accepts_max_value_boundaries(context: AlgopyTestContext, ok: int) -> None:
    assert max_value_of(context, create_with(context, ok)) == ok


def test_create_with_max_value_rejects_rekey(context: AlgopyTestContext) -> None:
    rekeyed = ARC87()
    with bare_call(context, algopy.OnCompleteAction.NoOp, rekey_to=context.any.account()):
        with pytest.raises(AssertionError, match="rekey not allowed"):
            rekeyed.create(algopy.UInt64(MAX_STRUCT_SIZE))


def test_max_value_enforced_on_every_write(context: AlgopyTestContext) -> None:
    capped = create_with(context, 100)
    k = algopy.String("k")
    capped.set_bytes(k, algopy.Bytes(bytes(100)))
    assert len(box(context, capped, "k")) == 100
    with pytest.raises(AssertionError, match="value exceeds maxValue"):
        capped.set_bytes(k, algopy.Bytes(bytes(101)))
    with pytest.raises(AssertionError, match="value exceeds maxValue"):
        capped.set(k, algopy.String("a" * 101))
    with pytest.raises(AssertionError, match="value exceeds maxValue"):
        capped.concat_bytes(k, algopy.Bytes(b"x"))
    with pytest.raises(AssertionError, match="value exceeds maxValue"):
        capped.concat(k, algopy.String("x"))
    # A rejected write leaves the box untouched; shrinking frees room again.
    assert len(box(context, capped, "k")) == 100
    capped.set(k, algopy.String("a" * 99))
    capped.concat(k, algopy.String("b"))
    assert len(box(context, capped, "k")) == 100


# --- hardening --------------------------------------------------------------


def test_rekey_rejected(context: AlgopyTestContext, contract: ARC87) -> None:
    """Every method (reads included) and the bare delete/update handlers refuse a rekeying app call."""
    contract.set(algopy.String("k"), algopy.String("v"))
    rekey_to = context.any.account()
    noop = algopy.OnCompleteAction.NoOp
    calls = [
        (lambda: contract.set(algopy.String("k"), algopy.String("v")), noop),
        (lambda: contract.set_bytes(algopy.String("k"), algopy.Bytes(b"v")), noop),
        (lambda: contract.length(algopy.String("k")), noop),
        (lambda: contract.extract(algopy.String("k"), algopy.UInt64(0), algopy.UInt64(1)), noop),
        (lambda: contract.remove(algopy.String("k")), noop),
        (lambda: contract.concat(algopy.String("k"), algopy.String("v")), noop),
        (lambda: contract.concat_bytes(algopy.String("k"), algopy.Bytes(b"v")), noop),
        (lambda: contract.reclaim(algopy.UInt64(1)), noop),
        (contract.on_delete, DELETE),
        (contract.on_update, UPDATE),
    ]
    for call, on_completion in calls:
        with bare_call(context, on_completion, rekey_to=rekey_to):
            with pytest.raises(AssertionError, match="rekey not allowed"):
                call()
    # The box survived every rejected call.
    assert box(context, contract, "k") == b"v"


def test_create_rejects_rekey(context: AlgopyTestContext) -> None:
    """The explicit bare create handler also refuses to rekey the (future) creator."""
    rekeyed = ARC87()
    with bare_call(context, algopy.OnCompleteAction.NoOp, rekey_to=context.any.account()):
        with pytest.raises(AssertionError, match="rekey not allowed"):
            rekeyed.on_create()
    # (the testing framework marks the app as created even though the call failed)
    plain = ARC87()
    with bare_call(context, algopy.OnCompleteAction.NoOp):
        plain.on_create()
    plain.set(algopy.String("k"), algopy.String("v"))


def test_empty_path_rejected(contract: ARC87) -> None:
    with pytest.raises(AssertionError, match="path must not be empty"):
        contract.set(algopy.String(""), algopy.String("x"))


def test_key_too_long_rejected(context: AlgopyTestContext, contract: ARC87) -> None:
    """62 path bytes + the 2-byte prefix is exactly 64 bytes and fine; one more byte fails."""
    ok = "k" * (keys.MAX_KEY_SIZE - len(keys.PREFIX))
    contract.set(algopy.String(ok), algopy.String("v"))
    assert box(context, contract, ok) == b"v"
    with pytest.raises(AssertionError, match="key exceeds 64 bytes"):
        contract.set(algopy.String(ok + "k"), algopy.String("v"))
    # Multi-byte UTF-8 counts in bytes, not characters.
    with pytest.raises(AssertionError, match="key exceeds 64 bytes"):
        contract.set(algopy.String("\u00e9" * 32), algopy.String("v"))


def test_value_too_large_rejected(context: AlgopyTestContext, contract: ARC87) -> None:
    """`set`/`concat` enforce the default 32 KiB ``maxValue`` on the (combined) value.

    ``algorand-python-testing`` emulates the 4096-byte AVM stack-value limit, so a 32 KiB
    ``String`` cannot be built offline; the largest representable values go through the
    public methods and the boundary itself is checked on the shared ``_assert_value`` guard
    (the localnet integration tests in ``arc-87-ts`` cover the end-to-end case).
    """
    chunk = "a" * 4094  # 4096 minus the 2-byte ABI length prefix of the encoded argument
    contract.set(algopy.String("big"), algopy.String(chunk))
    assert len(box(context, contract, "big")) == 4094

    contract._assert_value(algopy.UInt64(keys.MAX_BOX_SIZE))
    with pytest.raises(AssertionError, match="value exceeds maxValue"):
        contract._assert_value(algopy.UInt64(keys.MAX_BOX_SIZE + 1))
    with pytest.raises(AssertionError, match="value exceeds maxValue"):
        contract._assert_value(algopy.UInt64(2**64 - 1))


def test_missing_path_messages(contract: ARC87) -> None:
    for call in (
        lambda: contract.length(algopy.String("missing")),
        lambda: contract.extract(algopy.String("missing"), algopy.UInt64(0), algopy.UInt64(0)),
        lambda: contract.remove(algopy.String("missing")),
        lambda: contract.concat(algopy.String("missing"), algopy.String("x")),
        lambda: contract.concat_bytes(algopy.String("missing"), algopy.Bytes(b"x")),
    ):
        with pytest.raises(AssertionError, match="path not found"):
            call()


def test_delete_gate(context: AlgopyTestContext, contract: ARC87) -> None:
    context.set_template_var("DELETABLE", algopy.UInt64(0))
    with bare_call(context, DELETE), pytest.raises(AssertionError, match="not deletable"):
        contract.on_delete()
    context.set_template_var("DELETABLE", algopy.UInt64(1))
    with bare_call(context, DELETE):
        contract.on_delete()


def test_update_rejected_when_not_updatable(context: AlgopyTestContext, contract: ARC87) -> None:
    context.set_template_var("UPDATABLE", algopy.UInt64(0))
    with bare_call(context, UPDATE), pytest.raises(AssertionError, match="not updatable"):
        contract.on_update()
    context.set_template_var("UPDATABLE", algopy.UInt64(1))
    with bare_call(context, UPDATE):
        contract.on_update()


def test_gates_are_creator_only(context: AlgopyTestContext, contract: ARC87) -> None:
    context.set_template_var("DELETABLE", algopy.UInt64(1))
    context.set_template_var("UPDATABLE", algopy.UInt64(1))
    other = context.any.account()
    for call, on_completion in ((contract.on_delete, DELETE), (contract.on_update, UPDATE)):
        with bare_call(context, on_completion, sender=other):
            with pytest.raises(AssertionError, match="creator only"):
                call()


def test_reclaim_guards(context: AlgopyTestContext, contract: ARC87) -> None:
    app = context.ledger.get_app(contract)
    min_balance = 100_000
    context.ledger.update_account(app.address, balance=min_balance + 1_000, min_balance=min_balance)

    with pytest.raises(AssertionError, match="amount must be positive"):
        contract.reclaim(algopy.UInt64(0))
    with pytest.raises(AssertionError, match="cannot reclaim below minimum balance"):
        contract.reclaim(algopy.UInt64(1_001))
    assert not context.txn.last_group.itxn_groups

    # Exactly the surplus is fine and pays the creator with a zero-fee inner payment.
    contract.reclaim(algopy.UInt64(1_000))
    payment = context.txn.last_group.last_itxn.payment
    assert payment.sender == app.address
    assert payment.receiver == app.creator
    assert payment.amount == algopy.UInt64(1_000)
    assert payment.fee == algopy.UInt64(0)


@pytest.mark.parametrize("case", PATHS["cases"], ids=ids(PATHS["cases"]))
def test_contract_stores_vector_keys(
    context: AlgopyTestContext, contract: ARC87, case: dict[str, Any]
) -> None:
    """Writing every path of a vector object through `set` yields exactly the vector keys."""
    boxes = keys.to_boxes(case["object"])
    for key, value in boxes:
        contract.set(algopy.String(keys.strip_prefix(key)), algopy.String(value))
    for key in case["keys"]:
        assert has_box(context, contract, keys.strip_prefix(key))
    if boxes:
        stored = [[k, box(context, contract, keys.strip_prefix(k)).decode("utf-8")] for k, _ in boxes]
        assert keys.assemble(stored) == keys.assemble(boxes)


@pytest.mark.parametrize("case", MBR["cases"], ids=ids(MBR["cases"]))
def test_contract_stores_mbr_boxes(
    context: AlgopyTestContext, contract: ARC87, case: dict[str, Any]
) -> None:
    """Escaped keys and keys of exactly 64 bytes are plain boxes; reading everything back assembles the object."""
    for key, value in case["boxes"]:
        assert keys.byte_length(key) <= keys.MAX_KEY_SIZE
        contract.set(algopy.String(keys.strip_prefix(key)), algopy.String(value))
    stored = [[k, box(context, contract, keys.strip_prefix(k)).decode("utf-8")] for k, _ in case["boxes"]]
    assert keys.assemble(stored) == case["object"]


# --- vectors: paths ---------------------------------------------------------


@pytest.mark.parametrize("case", PATHS["cases"], ids=ids(PATHS["cases"]))
def test_to_paths(case: dict[str, Any]) -> None:
    paths = keys.to_paths(case["object"])
    assert paths == case["paths"]
    assert [keys.PREFIX + p for p in paths] == case["keys"]


@pytest.mark.parametrize("case", PATHS["cases"], ids=ids(PATHS["cases"]))
def test_paths_round_trip(case: dict[str, Any]) -> None:
    if case["name"].startswith("numeric object keys"):
        # Documented ambiguity: `.N` on read creates a list when the parent is absent.
        assert keys.assemble(keys.to_boxes(case["object"])) == {"a": [None, "one"]}
        return
    assert keys.assemble(keys.to_boxes(case["object"])) == case["object"]


# --- vectors: normalize -----------------------------------------------------


@pytest.mark.parametrize("case", NORMALIZE["cases"], ids=ids(NORMALIZE["cases"]))
def test_normalize_path(case: dict[str, Any]) -> None:
    for inp, expected in zip(case["inputs"], case["normalized"]):
        assert keys.normalize_path(inp) == expected
        assert keys.normalize_path(expected) == expected  # idempotent
    assert len({keys.normalize_path(i) for i in case["inputs"]}) == len(set(case["normalized"]))


def test_bracket_and_dotted_index_assemble_identically() -> None:
    bracket = keys.assemble([["o_blobs[0]", "x"], ["o_blobs[1]", "y"]])
    dotted = keys.assemble([["o_blobs.0", "x"], ["o_blobs.1", "y"]])
    assert bracket == dotted == {"blobs": ["x", "y"]}


# --- vectors: escape --------------------------------------------------------


def test_reserved_characters() -> None:
    assert list(keys.RESERVED_CHARACTERS) == ESCAPE["reserved"]


@pytest.mark.parametrize("case", ESCAPE["cases"], ids=ids(ESCAPE["cases"]))
def test_escape_segment(case: dict[str, Any]) -> None:
    assert keys.is_reserved(case["segment"]) is case["isEscaped"]
    assert keys.escape_segment(case["segment"]) == case["escaped"]
    assert keys.unescape_segment(case["escaped"]) == case["segment"]
    assert keys.to_segments(case["escaped"]) == [case["segment"]]


def test_tilde_span_is_an_opaque_literal() -> None:
    """`${~...}` has no meaning in ARC-87 (templating is left to a future spec)."""
    assert keys.assemble([["o_${~a.b}", "v"]]) == {"~a.b": "v"}


# --- vectors: mbr -----------------------------------------------------------


def test_mbr_constants() -> None:
    constants = MBR["constants"]
    assert keys.MIN_BALANCE == constants["MIN_BALANCE"]
    assert keys.PER_BOX == constants["PER_BOX"]
    assert keys.PER_UNIT == constants["PER_UNIT"]
    assert keys.MAX_KEY_SIZE == constants["MAX_KEY_SIZE"]
    assert keys.MAX_BOX_SIZE == constants["MAX_BOX_SIZE"]


@pytest.mark.parametrize("case", MBR["cases"], ids=ids(MBR["cases"]))
def test_to_mbr(case: dict[str, Any]) -> None:
    assert keys.to_boxes(case["object"]) == case["boxes"]
    assert keys.to_mbr(case["object"]) == int(case["mbr"])
    assert keys.boxes_to_mbr(case["boxes"]) == int(case["mbr"])


@pytest.mark.parametrize("case", MBR["errors"], ids=ids(MBR["errors"]))
def test_to_mbr_errors(case: dict[str, Any]) -> None:
    assert keys.byte_length(keys.PREFIX + case["key"]) == case["keyBytes"]
    obj = {case["key"]: "a" * case["valueLength"]}
    if case["error"] is None:
        assert keys.to_mbr(obj) > keys.MIN_BALANCE
    else:
        with pytest.raises(keys.MaxSizeError):
            keys.to_mbr(obj)


def test_long_keys_are_rejected_not_templated() -> None:
    """A full key over MAX_KEY_SIZE bytes fails fast in `to_boxes`; nothing is rewritten."""
    with pytest.raises(keys.MaxSizeError):
        keys.to_boxes({"k" * 63: "v"})
    with pytest.raises(keys.MaxSizeError):
        keys.to_boxes({"nested": {"k" * 60: "v"}})
    assert keys.to_boxes({"k" * 62: "v"}) == [["o_" + "k" * 62, "v"]]
