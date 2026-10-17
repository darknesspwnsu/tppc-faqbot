#!/usr/bin/env python3
"""Find candidate words for TPPC-style pattern contests.

Searches across:
- Standard dictionary words from /usr/share/dict/words
- TPPC wiki page titles from data/wiki_titles.json
- TPPC/Pokemon names from local data files

Patterns use letters plus "_" or "?" as unknowns, for example:
  __M____
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]

DEFAULT_PATTERN = "__M____"
CUSTOM_WORDLIST = Path.home() / "dictionaries" / "contest-words-final.txt"
DEFAULT_WORDLIST = Path("/usr/share/dict/words")

EASTER_TERMS = (
    "april",
    "bloom",
    "bunny",
    "candy",
    "chick",
    "egg",
    "easter",
    "flower",
    "hare",
    "hop",
    "lamb",
    "lily",
    "pastel",
    "rabbit",
    "resurrect",
    "spring",
)

# Based on TPPC wiki event history snippets for Easter events plus obvious egg/bunny
# adjacent species that might appear in TPPC clues.
EASTER_POKEMON_HINTS = {
    "buneary",
    "bunnelby",
    "cherubi",
    "comfey",
    "exeggcute",
    "lopunny",
    "minccino",
    "munna",
    "scorbunny",
    "togepi",
}


@dataclass(frozen=True)
class Candidate:
    display: str
    normalized: str
    source: str


def normalize_letters(text: str) -> str:
    return re.sub(r"[^A-Za-z]", "", text).lower()


def normalize_pattern(pattern: str) -> str:
    cleaned = re.sub(r"[^A-Za-z_?]", "", pattern)
    if not cleaned:
        raise ValueError("pattern must contain letters and/or _ wildcards")
    return cleaned.upper()


def pattern_matches(pattern: str, candidate: str) -> bool:
    if len(pattern) != len(candidate):
        return False
    for want, got in zip(pattern, candidate.upper()):
        if want in {"_", "?"}:
            continue
        if want != got:
            return False
    return True


def easter_score(candidate: Candidate) -> int:
    score = 0
    text = candidate.normalized

    for term in EASTER_TERMS:
        if term in text:
            score += max(1, len(term) // 2)

    if text in EASTER_POKEMON_HINTS:
        score += 10

    if candidate.source.startswith("tppc"):
        score += 2
    if candidate.source == "pokemon":
        score += 2

    return score


def load_dictionary_words() -> list[Candidate]:
    source_path = CUSTOM_WORDLIST if CUSTOM_WORDLIST.exists() else DEFAULT_WORDLIST
    if not source_path.exists():
        return []

    out: list[Candidate] = []
    with source_path.open("r", errors="ignore") as handle:
        for raw in handle:
            word = raw.strip()
            if not re.fullmatch(r"[A-Za-z]+", word):
                continue
            out.append(Candidate(display=word.lower(), normalized=word.lower(), source="dictionary"))
    return out


def load_wiki_titles() -> list[Candidate]:
    path = ROOT / "data" / "wiki_titles.json"
    if not path.exists():
        return []
    titles = json.loads(path.read_text())
    return [
        Candidate(display=title, normalized=normalize_letters(title), source="tppc-wiki")
        for title in titles
        if isinstance(title, str) and normalize_letters(title)
    ]


def load_swap_status_names() -> list[Candidate]:
    path = ROOT / "data" / "swap_status.json"
    if not path.exists():
        return []

    data = json.loads(path.read_text())
    pokemon = data.get("pokemon", {})
    seen: dict[tuple[str, str], Candidate] = {}

    for entry in pokemon.values():
        display = entry.get("displayName")
        if not display:
            continue
        normalized = normalize_letters(display)
        if not normalized:
            continue
        key = (display, normalized)
        seen[key] = Candidate(display=display, normalized=normalized, source="pokemon")

    return sorted(seen.values(), key=lambda c: (c.normalized, c.display.lower()))


def load_evolution_species() -> list[Candidate]:
    path = ROOT / "data" / "pokemon_evolutions.json"
    if not path.exists():
        return []

    data = json.loads(path.read_text())
    names: set[str] = set()

    def walk(value: object) -> None:
        if isinstance(value, str):
            names.add(value)
            return
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if isinstance(value, dict):
            for key, nested in value.items():
                if isinstance(key, str):
                    names.add(key)
                walk(nested)

    walk(data)

    return [
        Candidate(display=name, normalized=normalize_letters(name), source="pokemon")
        for name in sorted(names)
        if normalize_letters(name)
    ]


def dedupe_candidates(candidates: Iterable[Candidate]) -> list[Candidate]:
    merged: dict[tuple[str, str], Candidate] = {}
    for candidate in candidates:
        key = (candidate.source, candidate.normalized)
        current = merged.get(key)
        if current is None or len(candidate.display) < len(current.display):
            merged[key] = candidate
    return list(merged.values())


def find_candidates(pattern: str) -> list[Candidate]:
    pattern = normalize_pattern(pattern)
    candidates = dedupe_candidates(
        [
            *load_dictionary_words(),
            *load_wiki_titles(),
            *load_swap_status_names(),
            *load_evolution_species(),
        ]
    )
    matched = [c for c in candidates if pattern_matches(pattern, c.normalized)]
    matched.sort(key=lambda c: (-easter_score(c), c.source, c.normalized, c.display.lower()))
    return matched


def print_group(title: str, rows: list[Candidate]) -> None:
    print(f"\n{title} ({len(rows)})")
    for candidate in rows:
        score = easter_score(candidate)
        suffix = f"  [score={score}]" if score else ""
        display = candidate.display
        if candidate.display.lower() != candidate.normalized:
            display = f"{candidate.display} -> {candidate.normalized.upper()}"
        print(f"- {display}{suffix}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pattern", nargs="?", default=DEFAULT_PATTERN, help="Pattern like __M____")
    parser.add_argument("--limit", type=int, default=25, help="Max results per section")
    args = parser.parse_args()

    pattern = normalize_pattern(args.pattern)
    matches = find_candidates(pattern)

    dictionary = [c for c in matches if c.source == "dictionary"][: args.limit]
    tppc = [c for c in matches if c.source == "tppc-wiki"][: args.limit]
    pokemon = [c for c in matches if c.source == "pokemon"][: args.limit]

    print(f"Pattern: {pattern}")
    print(f"Total matches: {len(matches)}")

    print_group("TPPC Wiki / item / page-title matches", tppc)
    print_group("Pokemon matches", pokemon)
    print_group("Dictionary matches", dictionary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
