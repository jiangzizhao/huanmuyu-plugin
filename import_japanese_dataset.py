#!/usr/bin/env python3
"""Import the openly licensed OpenJLPT vocabulary data into Huanmuyu.

JLPT does not publish official vocabulary lists. OpenJLPT's N5-N1 bands are
community-standard approximations. The generated data remains CC BY-SA 4.0;
see JAPANESE-DATA-NOTICE.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORDLIST_DIR = ROOT / "wordlists"
LEVELS = ["N5", "N4", "N3", "N2", "N1"]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: import_japanese_dataset.py /path/to/OpenJLPT")
    source = Path(sys.argv[1]).resolve()
    if not (source / "NOTICE.md").exists():
        raise SystemExit("OpenJLPT source repository not found")

    # Keep the old beginner list's friendly ordering (greetings, pronouns,
    # numbers...) wherever those terms really belong to N5.
    legacy_path = WORDLIST_DIR / "日语.json"
    legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
    legacy_rank = {str(word): index for index, word in enumerate(legacy)}

    used: set[str] = set()
    cards: dict[str, dict] = {}
    counts: dict[str, int] = {}
    level_words: dict[str, list[str]] = {}
    for level in LEVELS:
        path = source / "data" / "json" / "vocab" / f"{level.lower()}.json"
        rows = json.loads(path.read_text(encoding="utf-8"))
        current: list[str] = []
        for row in rows:
            word = str(row.get("word") or "").strip()
            if not word or word in used:
                continue
            used.add(word)
            current.append(word)

            card: dict = {}
            reading = str(row.get("reading") or "").strip()
            meanings = [str(item).strip() for item in row.get("meanings", []) if str(item).strip()]
            examples = []
            for example in row.get("examples", [])[:5]:
                ja = str(example.get("ja") or "").strip()
                en = str(example.get("en") or "").strip()
                if ja:
                    examples.append({"场景": "开放例句", "例句": ja, "中译": en})
            if reading:
                card["ipa"] = reading
            if meanings:
                card["翻译"] = "; ".join(meanings)
            if examples:
                card["例句组"] = examples
            if card:
                cards[word] = card

        if level == "N5":
            current.sort(key=lambda word: (0, legacy_rank[word]) if word in legacy_rank else (1, word))
        level_words[level] = current

    # The previous Huanmuyu list contains very basic greetings and everyday
    # expressions missing from the exam-oriented source. Keep them at the
    # beginning of N5 instead of silently deleting existing beginner content.
    legacy_words = [str(word) for word in legacy]
    legacy_set = set(legacy_words)
    for level in LEVELS:
        level_words[level] = [word for word in level_words[level] if word not in legacy_set]
    level_words["N5"] = legacy_words + level_words["N5"]
    used.update(legacy_words)

    chinese_path = ROOT / "japanese-zh-cards.json"
    if chinese_path.exists():
        translated = json.loads(chinese_path.read_text(encoding="utf-8"))
        for word, card in translated.items():
            if isinstance(card, dict):
                cards[str(word)] = {**cards.get(str(word), {}), **card}

    # Hand-curated cards are intentionally applied last, so their Chinese
    # wording and extra examples win over generated translations.
    curated_path = ROOT / "japanese-curated-cards.json"
    if curated_path.exists():
        curated = json.loads(curated_path.read_text(encoding="utf-8"))
        for word, card in curated.items():
            if isinstance(card, dict):
                cards[str(word)] = {**cards.get(str(word), {}), **card}

    overrides_path = ROOT / "japanese-chinese-overrides.json"
    if overrides_path.exists():
        overrides = json.loads(overrides_path.read_text(encoding="utf-8"))
        for word, card in overrides.items():
            if isinstance(card, dict):
                cards[str(word)] = {**cards.get(str(word), {}), **card}

    for level in LEVELS:
        current = level_words[level]
        (WORDLIST_DIR / f"{level}.json").write_text(
            json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        counts[level] = len(current)

    # Rebuild the complete embedded map: Obsidian community installation only
    # guarantees main.js/manifest/styles.css, so word lists must be bundled.
    wordlists: dict[str, list[str]] = {}
    for path in sorted(WORDLIST_DIR.glob("*.json"), key=lambda item: item.name):
        if path.name == "index.json":
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            wordlists[path.stem] = [str(item) for item in data]
    (WORDLIST_DIR / "index.json").write_text(
        json.dumps({key: len(value) for key, value in wordlists.items()}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (ROOT / "wordlists.ts").write_text(
        "// Generated by the Korean/Japanese dataset importers. Do not edit by hand.\n"
        "export const WORDLISTS: Record<string, string[]> = "
        + json.dumps(wordlists, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    (ROOT / "japanese-cards.ts").write_text(
        "// Derived from OpenJLPT; CC BY-SA 4.0. See JAPANESE-DATA-NOTICE.md.\n"
        "export const JAPANESE_CARDS: Record<string, { ipa?: string; 翻译?: string; 例句?: string; 例句中译?: string; 例句组?: Array<{ 场景?: string; 例句: string; 中译?: string }>; 近义词?: string }> = "
        + json.dumps(cards, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(json.dumps({"levels": counts, "total": len(used), "cards": len(cards)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
