"""Offline tests for the ``ARC87Reader`` contract (``smart_contracts/arc87_reader.py``).

Executed by ``algorand-python-testing`` against an ``ARC87`` store created in the same test
ledger: the reads return the store's box data through the AVM 13 ``app_box_*`` shims of
``conftest.py``, ``readUint64`` decodes an 8-byte leaf, slices are capped at the 1018 bytes
that fit a readonly log, ``maxValue`` reads the store's cap, ``readPacked`` / ``sumPacked``
/ ``readRecord`` decode whole ARC-4 struct leaves of up to 4094 bytes, and missing boxes,
bad ranges and leaves of the wrong size fail with a descriptive assert.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

import algopy
import pytest
from algopy_testing import AlgopyTestContext, algopy_testing_context
from algosdk.abi import ABIType

from smart_contracts.arc87 import ARC87
from smart_contracts.arc87_reader import ARC87Reader

ITOB_42 = (42).to_bytes(8, "big")
MAX_STRUCT_SIZE = 4094  # largest leaf a consumer can load whole onto the AVM stack

PACKED_TYPE = ABIType.from_string("(uint64,uint64)")
RECORD_TYPE = ABIType.from_string("(uint64,string,byte[])")


def encode_packed(a: int, b: int) -> bytes:
    """``PackedValue { a, b }`` encoded: 16 bytes."""
    return PACKED_TYPE.encode([a, b])


# ``algorand-python-testing`` decodes ``arc4.DynamicBytes`` one ``arc4.Byte`` object at a
# time (quadratic: ~25 s for 4 KiB), so the offline fixture carries most of its size in
# the ``string`` field; on chain the decode is a handful of opcodes whatever the split.
TAGS = ",".join(f"tag{i}" for i in range(560))  # 3 809 bytes


def encode_record(size: int, record_id: int = 7, tags: str = TAGS) -> tuple[bytes, bytes]:
    """``Record { id, tags, payload }`` encoded to exactly ``size`` bytes: the head is
    8 (id) + 2 + 2 (offsets), each dynamic field adds a 2-byte length.
    """
    payload = bytes(i % 251 for i in range(size - 16 - len(tags.encode())))
    encoded = RECORD_TYPE.encode([record_id, tags, payload])
    assert len(encoded) == size
    return encoded, payload


@pytest.fixture()
def context() -> Iterator[AlgopyTestContext]:
    with algopy_testing_context() as ctx:
        yield ctx


@pytest.fixture()
def store(context: AlgopyTestContext) -> ARC87:
    app = ARC87()
    with context.txn.create_group(active_txn_overrides={"on_completion": algopy.OnCompleteAction.NoOp}):
        app.on_create()
    app.set(algopy.String("name"), algopy.String("cat"))
    app.set_bytes(algopy.String("count"), algopy.Bytes(ITOB_42))
    return app


@pytest.fixture()
def store_id(context: AlgopyTestContext, store: ARC87) -> algopy.UInt64:
    return context.ledger.get_app(store).id


@pytest.fixture()
def reader(context: AlgopyTestContext) -> ARC87Reader:
    app = ARC87Reader()
    with context.txn.create_group(active_txn_overrides={"on_completion": algopy.OnCompleteAction.NoOp}):
        app.on_create()
    return app


def test_reads_store_boxes_directly(
    context: AlgopyTestContext, store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader
) -> None:
    assert reader.read_length(store_id, algopy.String("name")) == algopy.UInt64(3)
    assert reader.read_bytes(store_id, algopy.String("name"), algopy.UInt64(0), algopy.UInt64(3)) == algopy.Bytes(
        b"cat"
    )
    assert reader.read_bytes(store_id, algopy.String("name"), algopy.UInt64(1), algopy.UInt64(2)) == algopy.Bytes(
        b"at"
    )
    assert reader.read_bytes(store_id, algopy.String("name"), algopy.UInt64(3), algopy.UInt64(0)) == algopy.Bytes(b"")
    assert reader.read_uint64(store_id, algopy.String("count")) == algopy.UInt64(42)
    # The reader addresses the same `o_`-prefixed key the store writes.
    assert context.ledger.box_exists(store, b"o_count")


def test_anyone_reads(context: AlgopyTestContext, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    other = context.any.account()
    with context.txn.create_group(active_txn_overrides={"sender": other}):
        assert reader.read_uint64(store_id, algopy.String("count")) == algopy.UInt64(42)
        assert reader.read_length(store_id, algopy.String("name")) == algopy.UInt64(3)


def test_descriptive_failures(store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    missing = algopy.String("missing")
    for read in (
        lambda: reader.read_length(store_id, missing),
        lambda: reader.read_bytes(store_id, missing, algopy.UInt64(0), algopy.UInt64(1)),
        lambda: reader.read_uint64(store_id, missing),
    ):
        with pytest.raises(AssertionError, match="path not found in store"):
            read()
    with pytest.raises(AssertionError, match="extract out of range"):
        reader.read_bytes(store_id, algopy.String("name"), algopy.UInt64(1), algopy.UInt64(3))
    with pytest.raises(AssertionError, match="extract out of range"):
        reader.read_bytes(store_id, algopy.String("name"), algopy.UInt64(4), algopy.UInt64(0))
    with pytest.raises(AssertionError, match="leaf is not a uint64"):
        reader.read_uint64(store_id, algopy.String("name"))
    # The size is checked before the value is read, so a leaf too large for
    # ``app_box_get`` fails with the same assert instead of an AVM size error.
    chunk = algopy.Bytes(b"\x01" * 4094)
    store.set_bytes(algopy.String("big"), chunk)
    store.concat_bytes(algopy.String("big"), chunk)
    assert reader.read_length(store_id, algopy.String("big")) == algopy.UInt64(4094 * 2)
    with pytest.raises(AssertionError, match="leaf is not a uint64"):
        reader.read_uint64(store_id, algopy.String("big"))
    # A store that does not exist is an AVM failure, not a contract assert.
    with pytest.raises(ValueError, match="no app"):
        reader.read_length(store_id + algopy.UInt64(1_000), algopy.String("name"))


def test_read_bytes_capped_at_log_size(store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    """``readBytes`` refuses slices over 1018 bytes, the most that fits a readonly log."""
    big = algopy.String("big")
    store.set(big, algopy.String("a" * 4094))
    assert reader.read_bytes(store_id, big, algopy.UInt64(0), algopy.UInt64(1018)).length == algopy.UInt64(1018)
    assert reader.read_bytes(store_id, big, algopy.UInt64(4094 - 1018), algopy.UInt64(1018)).length == algopy.UInt64(
        1018
    )
    with pytest.raises(AssertionError, match="slice exceeds 1018 bytes"):
        reader.read_bytes(store_id, big, algopy.UInt64(0), algopy.UInt64(1019))
    with pytest.raises(AssertionError, match="slice exceeds 1018 bytes"):
        reader.read_bytes(store_id, algopy.String("missing"), algopy.UInt64(0), algopy.UInt64(1019))


# --- struct leaves ------------------------------------------------------------


def test_reads_max_value(context: AlgopyTestContext, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    assert reader.max_value(store_id) == algopy.UInt64(32_768)
    capped = ARC87()
    with context.txn.create_group(active_txn_overrides={"on_completion": algopy.OnCompleteAction.NoOp}):
        capped.create(algopy.UInt64(MAX_STRUCT_SIZE))
    assert reader.max_value(context.ledger.get_app(capped).id) == algopy.UInt64(MAX_STRUCT_SIZE)
    # An application without the global (the reader itself) is not an ARC-87 store.
    with pytest.raises(AssertionError, match="store has no maxValue"):
        reader.max_value(context.ledger.get_app(reader).id)


def test_decodes_packed_value(store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    packed = algopy.String("packed")
    store.set_bytes(packed, algopy.Bytes(encode_packed(40, 2)))
    value = reader.read_packed(store_id, packed)
    assert value.a.as_uint64() == algopy.UInt64(40)
    assert value.b.as_uint64() == algopy.UInt64(2)
    assert reader.sum_packed(store_id, packed) == algopy.UInt64(42)
    # Any other size is not a PackedValue: the 8-byte ``count`` and the 3-byte ``name``.
    with pytest.raises(AssertionError, match="leaf is not a PackedValue"):
        reader.read_packed(store_id, algopy.String("count"))
    with pytest.raises(AssertionError, match="leaf is not a PackedValue"):
        reader.sum_packed(store_id, algopy.String("name"))
    with pytest.raises(AssertionError, match="path not found in store"):
        reader.read_packed(store_id, algopy.String("missing"))


def test_decodes_4094_byte_record(store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    encoded, payload = encode_record(MAX_STRUCT_SIZE)
    record = algopy.String("record")
    store.set_bytes(record, algopy.Bytes(encoded))
    assert reader.read_length(store_id, record) == algopy.UInt64(MAX_STRUCT_SIZE)
    record_id, length, digest = reader.read_record(store_id, record)
    assert record_id == algopy.UInt64(7)
    assert length == algopy.UInt64(len(payload))
    assert digest.bytes == algopy.Bytes(hashlib.sha256(payload).digest())


def test_refuses_leaf_over_4094_bytes(store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader) -> None:
    encoded, _payload = encode_record(MAX_STRUCT_SIZE + 1)
    record = algopy.String("record")
    # The default store accepts it (maxValue 32 KiB) — in two writes, since one ABI
    # argument carries at most 4094 bytes; the reader will not decode it.
    store.set_bytes(record, algopy.Bytes(encoded[:MAX_STRUCT_SIZE]))
    store.concat_bytes(record, algopy.Bytes(encoded[MAX_STRUCT_SIZE:]))
    assert reader.read_length(store_id, record) == algopy.UInt64(MAX_STRUCT_SIZE + 1)
    with pytest.raises(AssertionError, match="leaf exceeds 4094 bytes"):
        reader.read_record(store_id, record)
    with pytest.raises(AssertionError, match="leaf exceeds 4094 bytes"):
        reader.read_packed(store_id, record)
    # A 4094-byte leaf is loaded but is not a PackedValue.
    store.set_bytes(record, algopy.Bytes(encode_record(MAX_STRUCT_SIZE)[0]))
    with pytest.raises(AssertionError, match="leaf is not a PackedValue"):
        reader.read_packed(store_id, record)
    with pytest.raises(AssertionError, match="path not found in store"):
        reader.read_record(store_id, algopy.String("missing"))


def test_rekey_rejected(
    context: AlgopyTestContext, store: ARC87, store_id: algopy.UInt64, reader: ARC87Reader
) -> None:
    rekey_to = context.any.account()
    name = algopy.String("name")
    packed = algopy.String("packed")
    store.set_bytes(packed, algopy.Bytes(encode_packed(1, 2)))
    for call in (
        lambda: reader.read_length(store_id, name),
        lambda: reader.read_bytes(store_id, name, algopy.UInt64(0), algopy.UInt64(1)),
        lambda: reader.read_uint64(store_id, algopy.String("count")),
        lambda: reader.max_value(store_id),
        lambda: reader.read_packed(store_id, packed),
        lambda: reader.sum_packed(store_id, packed),
        lambda: reader.read_record(store_id, packed),
    ):
        with (
            context.txn.create_group(active_txn_overrides={"rekey_to": rekey_to}),
            pytest.raises(AssertionError, match="rekey not allowed"),
        ):
            call()
