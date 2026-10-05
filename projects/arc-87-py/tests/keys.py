"""Python mirror of the ARC-87 key-name logic implemented in ``typescript/src``.

This module exists so the shared ``vectors/*.json`` files can be validated from
Python with exactly the same rules the TypeScript library applies:

* ``to_paths``       – dotted paths, canonical ``[N]`` indices, ``${...}`` escaping
* ``normalize_path`` – ``[N]`` → ``.N`` outside of ``${...}`` spans
* ``to_boxes``       – full ``[key, value]`` list; a key longer than ``MAX_KEY_SIZE`` bytes
                       raises ``MaxSizeError`` (templatization is out of scope of ARC-87)
* ``assemble``       – the inverse of ``to_boxes``
* ``to_mbr``         – minimum balance requirement of the boxes
"""

from __future__ import annotations

import json
import re
from typing import Any

PREFIX = "o_"
RESERVED_CHARACTERS = (".", "[", "]", "$", "{")

MAX_KEY_SIZE = 64
MAX_BOX_SIZE = 32768
MIN_BALANCE = 100_000
PER_BOX = 2_500
PER_UNIT = 400

ESCAPED_SPAN = re.compile(r"\$\{[^}]*\}?")
BRACKET_INDEX = re.compile(r"\[(\d+)\]")
INTEGER = re.compile(r"^-?\d+$")


class MaxSizeError(ValueError):
    """Raised when a key or value exceeds the AVM box limits."""


def byte_length(text: str) -> int:
    return len(text.encode("utf-8"))


# --- segments ---------------------------------------------------------------


def is_reserved(segment: str) -> bool:
    return any(char in segment for char in RESERVED_CHARACTERS)


def escape_segment(segment: str) -> str:
    return "${" + segment + "}" if is_reserved(segment) else segment


def unescape_segment(segment: str) -> str:
    if segment.startswith("${") and segment.endswith("}"):
        return segment[2:-1]
    return segment


def _map_outside_spans(path: str, fn) -> str:
    result = ""
    last = 0
    for match in ESCAPED_SPAN.finditer(path):
        result += fn(path[last : match.start()]) + match.group(0)
        last = match.end()
    return result + fn(path[last:])


def normalize_path(path: str) -> str:
    return _map_outside_spans(path, lambda text: BRACKET_INDEX.sub(r".\1", text))


def to_segments(path: str) -> list[str]:
    normalized = normalize_path(path)
    segments: list[str] = []
    current = ""
    last = 0

    def push(text: str) -> None:
        nonlocal current
        parts = text.split(".")
        current += parts[0]
        for part in parts[1:]:
            segments.append(current)
            current = part

    for match in ESCAPED_SPAN.finditer(normalized):
        push(normalized[last : match.start()])
        current += match.group(0)
        last = match.end()
    push(normalized[last:])
    segments.append(current)
    return [unescape_segment(s) for s in segments]


def strip_prefix(key: str) -> str:
    return key[len(PREFIX) :] if key.startswith(PREFIX) else key


# --- paths ------------------------------------------------------------------


def to_paths(obj: Any, parent_key: str | None = None) -> list[str]:
    if isinstance(obj, list) and len(obj) > 0:
        return [
            path
            for idx, item in enumerate(obj)
            for path in to_paths(item, f"{parent_key or ''}[{idx}]")
        ]
    if isinstance(obj, dict) and len(obj) > 0:
        return [
            f"{parent_key}.{subkey}" if parent_key else subkey
            for key in obj
            for subkey in to_paths(obj[key], escape_segment(key))
        ]
    return [] if parent_key is None else [parent_key]


def get_path(obj: Any, path: str) -> Any:
    current = obj
    for segment in to_segments(path):
        if isinstance(current, list):
            current = current[int(segment)]
        else:
            current = current[segment]
    return current


# --- values -----------------------------------------------------------------


def serialize(value: Any) -> str:
    """Mirror of JavaScript ``String(value)`` for JSON leaves (compact JSON for containers)."""
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def deserialize(text: str) -> Any:
    if INTEGER.match(text):
        return int(text)
    literals = {"null": None, "true": True, "false": False}
    if text in literals:
        return literals[text]
    if text == "[]":
        return []
    if text == "{}":
        return {}
    return text


# --- boxes ------------------------------------------------------------------


def to_boxes(obj: Any) -> list[list[str]]:
    """One ``[PREFIX + path, value]`` box per leaf; long key names are rejected, not templated."""
    boxes: list[list[str]] = []
    for path in to_paths(obj):
        key = PREFIX + path
        if byte_length(key) > MAX_KEY_SIZE:
            raise MaxSizeError(f"Key exceeds {MAX_KEY_SIZE} bytes: {key}")
        boxes.append([key, serialize(get_path(obj, path))])
    return boxes


def _set_path(data: Any, segments: list[str], value: Any) -> None:
    """``lodash.set`` semantics: a numeric segment creates a list when the parent is absent."""
    current = data
    for idx, segment in enumerate(segments):
        last = idx == len(segments) - 1
        if isinstance(current, list):
            pos = int(segment)
            while len(current) <= pos:
                current.append(None)
            if last:
                current[pos] = value
            else:
                if current[pos] is None:
                    current[pos] = [] if segments[idx + 1].isdigit() else {}
                current = current[pos]
        else:
            if last:
                current[segment] = value
            else:
                if segment not in current:
                    current[segment] = [] if segments[idx + 1].isdigit() else {}
                current = current[segment]


def assemble(kvs: list[list[str]]) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for key, value in kvs:
        _set_path(data, to_segments(strip_prefix(key)), deserialize(value))
    return {k: data[k] for k in sorted(data)}


# --- payments ---------------------------------------------------------------


def boxes_to_mbr(boxes: list[list[str]]) -> int:
    total = MIN_BALANCE
    for key, value in boxes:
        key_bytes = byte_length(key)
        value_bytes = byte_length(value)
        if key_bytes > MAX_KEY_SIZE:
            raise MaxSizeError(f"Key exceeds {MAX_KEY_SIZE} bytes: {key}")
        if value_bytes > MAX_BOX_SIZE:
            raise MaxSizeError(f"Value exceeds {MAX_BOX_SIZE} bytes for key {key}")
        total += PER_BOX + PER_UNIT * (key_bytes + value_bytes)
    return total


def to_mbr(obj: Any) -> int:
    return boxes_to_mbr(to_boxes(obj))
