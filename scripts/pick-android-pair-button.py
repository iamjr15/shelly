#!/usr/bin/env python3
"""Return the center of the Android Pair button on the Enter-code tab from a uiautomator XML dump."""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pick-android-pair-button.py <uiautomator.xml>", file=sys.stderr)
        return 2

    text = open(sys.argv[1], encoding="utf-8").read()
    end = text.find("</hierarchy>")
    if end >= 0:
        text = text[: end + len("</hierarchy>")]
    root = ET.fromstring(text)

    payload_bottom = find_payload_bottom(root)
    if payload_bottom is None:
        print("pairing code field not found", file=sys.stderr)
        return 1

    candidates = []
    for node in root.iter("node"):
        bounds = parse_bounds(node.attrib.get("bounds", ""))
        if bounds is None:
            continue
        left, top, right, bottom = bounds
        width = right - left
        height = bottom - top
        if (
            node.attrib.get("clickable") == "true"
            and node.attrib.get("enabled") == "true"
            and width > 500
            and 48 <= height <= 240
            and top >= payload_bottom - 2
        ):
            candidates.append((top, left, right, bottom))

    if not candidates:
        print("pair button not found", file=sys.stderr)
        return 1

    top, left, right, bottom = sorted(candidates)[0]
    print((left + right) // 2, (top + bottom) // 2)
    return 0


def find_payload_bottom(root: ET.Element) -> int | None:
    for node in root.iter("node"):
        if node.attrib.get("class") != "android.widget.EditText":
            continue
        if any(child.attrib.get("text") == "Pairing code" for child in node.iter()):
            bounds = parse_bounds(node.attrib.get("bounds", ""))
            if bounds is not None:
                return bounds[3]

    for node in root.iter("node"):
        if node.attrib.get("text") == "Pairing code":
            bounds = parse_bounds(node.attrib.get("bounds", ""))
            if bounds is not None:
                return bounds[3]
    return None


def parse_bounds(bounds: str) -> tuple[int, int, int, int] | None:
    values = list(map(int, re.findall(r"\d+", bounds)))
    if len(values) != 4:
        return None
    return values[0], values[1], values[2], values[3]


if __name__ == "__main__":
    raise SystemExit(main())
