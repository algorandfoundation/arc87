# arc-87-py

Algorand Python ([puyapy](https://github.com/algorandfoundation/puya)) implementation of the ARC-87 store contract. It
has the same ABI, box prefix and error messages as the TypeScript contract in `../arc-87-ts`, and is tested against
the vectors in `../conformance/vectors`.

Deployment is handled by the TypeScript `deploy()` helper. This project has no deploy script of its own.

## Commands

```bash
poetry install                   # once
algokit project run build        # compile arc87.py and arc87_reader.py to ARC-56 (AVM 13)
poetry run pytest                # contract tests + vector conformance
algokit project run audit-teal   # Tealer audit (build first)
```

## Contracts

| File | Role |
|------|------|
| `smart_contracts/arc87.py` | Store contract (ABI in the [workspace README](../../README.md#contract-abi-arc-56)) |
| `smart_contracts/arc87_reader.py` | Example consumer, the twin of the TypeScript `ARC87Reader` |

ABI method names are camelCase (`@abimethod(name="setBytes")`), so the ARC-56 output matches the TypeScript
contract.

## Testing notes

- `algorand-python-testing` does not implement the AVM 13 box and app-param ops yet, so `tests/conftest.py` emulates
  them against the test ledger. The TypeScript localnet tests cover the real behaviour.
- The testing library decodes `arc4.DynamicBytes` slowly, so the offline 4094-byte `Record` fixture keeps most of its
  bytes in `tags`.
