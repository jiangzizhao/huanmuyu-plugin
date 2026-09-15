#!/usr/bin/env python3
"""Fail the build-time content check when Japanese study data is incomplete."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LEVELS = ("N5", "N4", "N3", "N2", "N1")
HAN_RE = re.compile(r"[\u3400-\u9fff]")
JAPANESE_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
LATIN_RE = re.compile(r"[A-Za-z]")
KANJI_RE = re.compile(r"[\u3400-\u9fff\u3005]")
FURIGANA_RE = re.compile(r"\{([^{}|]+)\|([^{}|]+)\}")


def embedded_json(path: Path) -> dict:
    source = path.read_text(encoding="utf-8")
    return json.loads(source[source.index("= ") + 2 : -2])


def main() -> None:
    cards = embedded_json(ROOT / "japanese-cards.ts")
    articles = json.loads((ROOT / "japanese-articles.json").read_text(encoding="utf-8"))
    errors: list[str] = []
    seen: set[str] = set()

    for level in LEVELS:
        words = json.loads((ROOT / "wordlists" / f"{level}.json").read_text(encoding="utf-8"))
        for word in words:
            if word in seen:
                errors.append(f"duplicate word across levels: {word}")
            seen.add(word)
            card = cards.get(word)
            if not isinstance(card, dict):
                errors.append(f"{level} missing card: {word}")
                continue
            meaning = str(card.get("翻译") or "").strip()
            if not meaning or not HAN_RE.search(meaning):
                errors.append(f"{level} missing Chinese meaning: {word}")
            if LATIN_RE.search(meaning):
                errors.append(f"{level} English leaked into meaning: {word} = {meaning}")
            examples = card.get("例句组") or []
            for index, example in enumerate(examples):
                japanese = str(example.get("例句") or "").strip()
                chinese = str(example.get("中译") or "").strip()
                if not japanese or not JAPANESE_RE.search(japanese):
                    errors.append(f"{level} invalid Japanese example: {word}#{index + 1}")
                if not chinese or not HAN_RE.search(chinese):
                    errors.append(f"{level} missing Chinese example: {word}#{index + 1}")

        library = articles.get(level)
        if not isinstance(library, list) or len(library) != 60:
            errors.append(f"{level} must contain exactly 60 bundled articles")
            continue
        if len({item.get("title") for item in library}) != 60:
            errors.append(f"{level} article titles are not unique")
        for index, article in enumerate(library):
            japanese = str(article.get("japanese") or "").strip()
            chinese = str(article.get("chinese") or "").strip()
            title_furigana = str(article.get("titleFurigana") or "").strip()
            if not japanese or not JAPANESE_RE.search(japanese):
                errors.append(f"{level} article {index + 1} has no Japanese text")
            if not chinese or not HAN_RE.search(chinese):
                errors.append(f"{level} article {index + 1} has no Chinese text")
            for field, value in (("title", title_furigana), ("body", japanese)):
                without_annotations = FURIGANA_RE.sub("", value)
                if KANJI_RE.search(without_annotations):
                    errors.append(f"{level} article {index + 1} has unannotated kanji in {field}")
                for base, reading in FURIGANA_RE.findall(value):
                    if not KANJI_RE.search(base) or not re.search(r"[\u3040-\u309f]", reading):
                        errors.append(f"{level} article {index + 1} has invalid furigana: {base}|{reading}")

    idea = cards.get("アイデア", {})
    if idea.get("翻译") != "想法；主意":
        errors.append("アイデア must use the reviewed Chinese meaning")

    if errors:
        raise SystemExit("\n".join(errors[:100]))
    print(
        json.dumps(
            {
                "levels": list(LEVELS),
                "words": len(seen),
                "cards": len(cards),
                "articles": sum(len(articles[level]) for level in LEVELS),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
