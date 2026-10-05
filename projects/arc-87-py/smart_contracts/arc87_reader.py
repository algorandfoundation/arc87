import typing

from algopy import (
    ARC4Contract,
    Bytes,
    Global,
    String,
    Txn,
    UInt64,
    arc4,
    op,
    subroutine,
)
from algopy.arc4 import abimethod, baremethod

# This contract consumes the boxes of an ARC87 store from another application

PREFIX = b"o_"
UINT64_SIZE = 8  # bytes
MAX_EXTRACT = 1018  # bytes: 1024-byte log cap - 4-byte return prefix - 2-byte length
MAX_STRUCT_SIZE = 4094  # bytes: largest leaf loaded whole onto the stack (4096 - 2-byte ABI prefix)
PACKED_SIZE = 16  # bytes: two uint64 fields

Sha256 = arc4.StaticArray[arc4.Byte, typing.Literal[32]]


class PackedValue(arc4.Struct):
    """A static ARC-4 struct leaf: ``(uint64,uint64)``, 16 bytes."""

    a: arc4.UInt64
    b: arc4.UInt64


class Record(arc4.Struct):
    """A dynamic ARC-4 struct leaf: ``(uint64,string,byte[])``, sized by its two dynamic fields."""

    id: arc4.UInt64
    tags: arc4.String
    payload: arc4.DynamicBytes


class ARC87Reader(ARC4Contract):
    """Minimal consumer of an ``ARC87`` store deployed as a sibling application.

    Every read uses the AVM 13 ``app_box_*`` opcodes against the store's boxes (an
    ``ARC87`` store enables ``AppForeignBoxReads`` on create). Every method is public
    and ``readonly``; the slices returned through a log are capped at 1018 bytes,
    larger values are read in a loop of ``app_box_extract`` calls by the consuming
    contract itself.

    Leaves of at most ``MAX_STRUCT_SIZE`` (4094) bytes are loaded whole with
    ``app_box_get`` and decoded as ARC-4 structs (``readPacked``, ``readRecord``): a
    store whose ``maxValue`` global is ``<= 4094`` guarantees that for every leaf.
    """

    @subroutine
    def _assert_no_rekey(self) -> None:
        """Never while rekeying (every method)."""
        assert Txn.rekey_to == Global.zero_address, "rekey not allowed"

    @subroutine
    def _key(self, path: String) -> Bytes:
        """The full box key of ``path`` in the store (``o_`` + path)."""
        return PREFIX + path.bytes

    @subroutine
    def _leaf(self, store: UInt64, path: String) -> Bytes:
        """The whole leaf under ``path`` in ``store`` on the stack. The size is checked
        first so an oversized leaf fails with a descriptive assert instead of the AVM's
        ``box_get produced a too big byte-array``.
        """
        key = self._key(path)
        size, exists = op.AppBox.length(store, key)
        assert exists, "path not found in store"
        assert size <= MAX_STRUCT_SIZE, "leaf exceeds 4094 bytes"
        value, _exists = op.AppBox.get(store, key)
        return value

    @subroutine
    def _packed(self, store: UInt64, path: String) -> PackedValue:
        """The 16-byte leaf under ``path`` decoded as a ``PackedValue``."""
        raw = self._leaf(store, path)
        assert raw.length == PACKED_SIZE, "leaf is not a PackedValue"
        return PackedValue.from_bytes(raw)

    @baremethod(create="require")
    def on_create(self) -> None:
        """Create the contract; never while rekeying."""
        self._assert_no_rekey()

    @abimethod(name="readLength", readonly=True)
    def read_length(self, store: UInt64, path: String) -> UInt64:
        """Size in bytes of the value stored under ``path`` in application ``store``."""
        self._assert_no_rekey()
        length, exists = op.AppBox.length(store, self._key(path))
        assert exists, "path not found in store"
        return length

    @abimethod(name="readBytes", readonly=True)
    def read_bytes(self, store: UInt64, path: String, offset: UInt64, length: UInt64) -> Bytes:
        """A slice of the value stored under ``path`` in application ``store``; fails when
        the range is out of bounds or longer than 1018 bytes (the log cap of a readonly
        call).
        """
        self._assert_no_rekey()
        assert length <= MAX_EXTRACT, "slice exceeds 1018 bytes"
        key = self._key(path)
        size, exists = op.AppBox.length(store, key)
        assert exists, "path not found in store"
        assert offset + length <= size, "extract out of range"
        return op.AppBox.extract(store, key, offset, length)

    @abimethod(name="readUint64", readonly=True)
    def read_uint64(self, store: UInt64, path: String) -> UInt64:
        """The 8-byte big-endian (ARC-4 ``uint64``) leaf stored under ``path`` in
        application ``store``. The size is checked before the value is read, so a leaf
        of any other size (including boxes too large for ``app_box_get``) fails with a
        descriptive assert.
        """
        self._assert_no_rekey()
        key = self._key(path)
        size, exists = op.AppBox.length(store, key)
        assert exists, "path not found in store"
        assert size == UINT64_SIZE, "leaf is not a uint64"
        return op.btoi(op.AppBox.extract(store, key, UInt64(0), UInt64(UINT64_SIZE)))

    @abimethod(name="maxValue", readonly=True)
    def max_value(self, store: UInt64) -> UInt64:
        """The per-value size cap of application ``store`` (its ``maxValue`` global, set
        by the ``ARC87`` create). A cap of 4094 or less means every leaf of the store can
        be decoded whole by ``readPacked`` / ``readRecord``.
        """
        self._assert_no_rekey()
        value, exists = op.AppGlobal.get_ex_uint64(store, Bytes(b"maxValue"))
        assert exists, "store has no maxValue"
        return value

    @abimethod(name="readPacked", readonly=True)
    def read_packed(self, store: UInt64, path: String) -> PackedValue:
        """The 16-byte ``PackedValue { a, b }`` leaf under ``path`` in ``store``, decoded whole."""
        self._assert_no_rekey()
        return self._packed(store, path)

    @abimethod(name="sumPacked", readonly=True)
    def sum_packed(self, store: UInt64, path: String) -> UInt64:
        """``a + b`` of the ``PackedValue`` leaf under ``path``: arithmetic on decoded fields."""
        self._assert_no_rekey()
        value = self._packed(store, path)
        return value.a.as_uint64() + value.b.as_uint64()

    @abimethod(name="readRecord", readonly=True)
    def read_record(self, store: UInt64, path: String) -> tuple[UInt64, UInt64, Sha256]:
        """The dynamic ``Record { id, tags, payload }`` leaf under ``path`` in ``store`` (up
        to 4094 bytes) decoded whole on the stack; returns
        ``(id, payload.length, sha256(payload))`` — a 48-byte result that proves there is
        budget left for work on the decoded struct, instead of the struct itself, which
        could not fit the 1024-byte log cap.
        """
        self._assert_no_rekey()
        raw = self._leaf(store, path)
        record = Record.from_bytes(raw)
        payload = record.payload.native
        return record.id.as_uint64(), payload.length, Sha256.from_bytes(op.sha256(payload))
