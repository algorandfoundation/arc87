from algopy import (
    ARC4Contract,
    BoxMap,
    Bytes,
    Global,
    GlobalState,
    String,
    TemplateVar,
    Txn,
    UInt64,
    itxn,
    op,
    subroutine,
)
from algopy.arc4 import abimethod, baremethod

# This contract is a simple key-value store that allows you to set and get values from boxes

PREFIX = b"o_"
PREFIX_SIZE = 2  # len(PREFIX); puyapy does not support len() on bytes literals
MAX_KEY_SIZE = 64  # bytes, including the prefix
MAX_BOX_SIZE = 32_768  # bytes
MAX_EXTRACT = 1018  # bytes: 1024-byte log cap - 4-byte return prefix - 2-byte length


class ARC87(ARC4Contract):
    """Simple Contract for storing key-value pairs.

    Writes are creator-only. The boxes are exposed to other applications through
    AVM 13 foreign box reads (``AppForeignBoxReads``, always enabled on create) and
    to everyone off-chain through the algod box API; the public ``readonly`` methods
    ``length`` and ``extract`` cover what fits in a single log.

    Every value is capped at ``maxValue`` bytes, fixed at create (32 KiB by default,
    or the argument of ``create(uint64)``). Consumers read the cap with
    ``app_global_get_ex`` to know whether every leaf fits on the AVM stack.

    Attributes
    ----------
    public : BoxMap
        Boxes that store the public object (UTF-8 text via ``set``, raw bytes via ``setBytes``)
    max_value : GlobalState
        Immutable per-value size cap in bytes, set at create (global key ``maxValue``)
    """

    def __init__(self) -> None:
        self.public = BoxMap(String, Bytes, key_prefix=PREFIX)
        self.max_value = GlobalState(UInt64, key="maxValue")

    @subroutine
    def _assert_no_rekey(self) -> None:
        """Never while rekeying (every method, reads included)."""
        assert Txn.rekey_to == Global.zero_address, "rekey not allowed"

    @subroutine
    def _authorize(self) -> None:
        """Only the creator may call, and never while rekeying."""
        self._assert_no_rekey()
        assert Txn.sender == Global.creator_address, "creator only"

    @subroutine
    def _assert_key(self, path: String) -> None:
        """The full box key (prefix + path) must be non-empty and fit in 64 bytes."""
        length = path.bytes.length
        assert length > 0, "path must not be empty"
        assert length + PREFIX_SIZE <= MAX_KEY_SIZE, "key exceeds 64 bytes"

    @subroutine
    def _assert_value(self, length: UInt64) -> None:
        """A box value may not exceed the store's ``maxValue``."""
        assert length <= self.max_value.value, "value exceeds maxValue"

    @subroutine
    def _init(self, max_value: UInt64) -> None:
        """Shared create logic: never while rekeying, record the value cap and make
        the boxes readable by other applications from the start.
        """
        self._assert_no_rekey()
        assert max_value > 0 and max_value <= MAX_BOX_SIZE, "maxValue out of range"
        self.max_value.value = max_value
        op.AppParamsSet.app_foreign_box_reads(True)

    @subroutine
    def _put(self, path: String, value: Bytes) -> None:
        """Store ``value`` under ``path``, replacing any previous value."""
        self._assert_key(path)
        self._assert_value(value.length)
        self.public[path] = value

    @subroutine
    def _append(self, path: String, value: Bytes) -> None:
        """Append ``value`` to an existing box without loading the current contents
        onto the AVM stack (which is capped at 4096 bytes). ``op.Box.resize`` +
        ``op.Box.replace`` keep the full 32 KiB box-value ceiling reachable via
        chunked ``set``/``concat`` calls.
        """
        assert path in self.public, "path not found"
        key = self.public.key_prefix + path.bytes
        old_len = self.public.length(path)
        new_len = old_len + value.length
        self._assert_value(new_len)
        op.Box.resize(key, new_len)
        op.Box.replace(key, old_len, value)

    @baremethod(create="require")
    def on_create(self) -> None:
        """Create the contract (the sender becomes the creator) with the default
        32 KiB value cap.
        """
        self._init(UInt64(MAX_BOX_SIZE))

    @abimethod(create="require", name="create")
    def create(self, max_value: UInt64) -> None:
        """Create the contract with a custom value cap (``0 < maxValue <= 32768``).

        A cap of 4094 or less guarantees every leaf can be loaded whole onto the
        AVM stack and decoded as an ARC-4 struct by a consuming contract.
        """
        self._init(max_value)

    @baremethod(allow_actions=["DeleteApplication"])
    def on_delete(self) -> None:
        """Delete the contract."""
        self._authorize()
        assert TemplateVar[UInt64]("DELETABLE"), "not deletable"

    @baremethod(allow_actions=["UpdateApplication"])
    def on_update(self) -> None:
        """Update the contract."""
        self._authorize()
        assert TemplateVar[UInt64]("UPDATABLE"), "not updatable"

    @abimethod()
    def set(self, path: String, value: String) -> None:
        """Set a text value in the public object."""
        self._authorize()
        self._put(path, value.bytes)

    @abimethod(name="setBytes")
    def set_bytes(self, path: String, value: Bytes) -> None:
        """Set a raw bytes value (e.g. an ARC-4 encoded leaf) in the public object."""
        self._authorize()
        self._put(path, value)

    @abimethod()
    def concat(self, path: String, value: String) -> None:
        """Append text to an existing value."""
        self._authorize()
        self._append(path, value.bytes)

    @abimethod(name="concatBytes")
    def concat_bytes(self, path: String, value: Bytes) -> None:
        """Append raw bytes to an existing value."""
        self._authorize()
        self._append(path, value)

    @abimethod()
    def remove(self, path: String) -> None:
        """Remove a value from the public object."""
        self._authorize()
        assert path in self.public, "path not found"
        del self.public[path]

    @abimethod()
    def reclaim(self, amount: UInt64) -> None:
        """Reclaim any ALGO that was sent to the contract by the creator."""
        self._authorize()
        assert amount > 0, "amount must be positive"
        app = Global.current_application_address
        assert app.balance - amount >= app.min_balance, "cannot reclaim below minimum balance"
        itxn.Payment(
            sender=app,
            receiver=Global.creator_address,
            amount=amount,
            fee=0,
        ).submit()

    @abimethod(readonly=True)
    def length(self, path: String) -> UInt64:
        """Size in bytes of the value stored under ``path``."""
        self._assert_no_rekey()
        assert path in self.public, "path not found"
        return self.public.length(path)

    @abimethod(readonly=True)
    def extract(self, path: String, offset: UInt64, length: UInt64) -> Bytes:
        """A slice of the value stored under ``path``; fails when the range is out of
        bounds or longer than 1018 bytes, the most that fits the 1024-byte log cap of
        a readonly call (4-byte return prefix + 2-byte length). Larger reads go
        through ``app_box_extract`` on-chain or the algod box API off-chain.
        """
        self._assert_no_rekey()
        assert length <= MAX_EXTRACT, "slice exceeds 1018 bytes"
        assert path in self.public, "path not found"
        assert offset + length <= self.public.length(path), "extract out of range"
        key = self.public.key_prefix + path.bytes
        return op.Box.extract(key, offset, length)
