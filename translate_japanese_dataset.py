#!/usr/bin/env python3
"""Build simplified-Chinese Japanese word cards for Huanmuyu.

The source vocabulary/examples come from OpenJLPT.  Exact Japanese-to-Chinese
Tatoeba pairs are preferred for examples; the remaining English glosses are
translated locally with Helsinki-NLP/opus-mt-en-zh.  No customer data or paid
API is involved.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Iterable

import torch
from opencc import OpenCC
from transformers import MarianMTModel, MarianTokenizer


ROOT = Path(__file__).resolve().parent
LEVELS = ("n5", "n4", "n3", "n2", "n1")
HAN_RE = re.compile(r"[\u3400-\u9fff]")
DEFINITION_PREFIX_RE = re.compile(r"^\s*(?:定义|释义)\s*[:：]\s*")
WORD_MEANING_OVERRIDES = {
    "あれ": "那个；那",
    "その": "那个；那",
    "それ": "那个；那",
    "十": "十",
    "百": "百",
    "あ": "啊",
    "女王": "女王",
    "片仮名": "片假名",
    "オーケー": "好；可以",
    "ヶ月": "……个月（计数单位）",
    "ワット": "瓦特",
    "葦": "芦苇",
    "貝殻": "贝壳",
    "歳": "岁（年龄）",
}
EXAMPLE_JA_OVERRIDES = {
    "何が原因ですか。": "原因是什么？",
    "君には参るよ。": "真拿你没办法。",
    "君は偉いことをやったね。": "你做得真棒！",
    "四字熟語とは四文字の熟語のことです。": "四字熟语就是由四个汉字组成的固定表达。",
    "分数b/aは1/aをb倍した数を意味する。": "分数 b/a 表示 b 乘以 1/a。",
    "この会の名称はＥ．Ｓ．Ｓ．とする。": "本协会名称定为 E.S.S.。",
}


def clean_chinese_meaning(value: str) -> str:
    """Remove upstream dictionary tags/transliteration debris from a gloss."""
    value = value.replace("OK", "可以").replace("Noes", "否决票")
    value = re.sub(r"\([^)]*[A-Za-z][^)]*\)", "", value)
    value = re.sub(r"[A-Za-z][A-Za-z0-9_.:'’`/+-]*", "", value)
    value = value.replace("()", "").replace("（）", "")
    parts: list[str] = []
    for part in re.split(r"[;；]+", value):
        part = re.sub(r"\s+", " ", part).strip(" ,，.。:：-—")
        if part and part not in parts:
            parts.append(part)
    return "；".join(parts)


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_tatoeba_map(directory: Path, simplify: OpenCC) -> dict[str, str]:
    japanese = {
        row[0]: row[2]
        for line in (directory / "jpn.tsv").read_text(encoding="utf-8").splitlines()
        if len(row := line.split("\t", 2)) == 3
    }
    chinese = {
        row[0]: simplify.convert(row[2]).strip()
        for line in (directory / "cmn.tsv").read_text(encoding="utf-8").splitlines()
        if len(row := line.split("\t", 2)) == 3
    }
    result: dict[str, str] = {}
    for line in (directory / "jpn-cmn-links.tsv").read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        ja = japanese.get(parts[0], "").strip()
        zh = chinese.get(parts[1], "").strip()
        if ja and zh and ja not in result:
            result[ja] = zh
    return result


def load_model(snapshot: Path) -> tuple[MarianTokenizer, MarianMTModel]:
    tokenizer = MarianTokenizer(
        str(snapshot / "source.spm"),
        str(snapshot / "target.spm"),
        str(snapshot / "vocab.json"),
        source_lang="eng",
        target_lang="zho",
    )
    model = MarianMTModel.from_pretrained(str(snapshot), local_files_only=True)
    model.eval()
    return tokenizer, model


def chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def translate_missing(
    texts: list[str],
    cache: dict[str, str],
    tokenizer: MarianTokenizer,
    model: MarianMTModel,
    simplify: OpenCC,
    cache_path: Path,
    *,
    definitions: bool,
    batch_size: int,
) -> None:
    missing = [text for text in texts if text not in cache]
    total = len(missing)
    for done, batch in enumerate(chunks(missing, batch_size), start=1):
        prompts = [f"Definition: {text}." for text in batch] if definitions else batch
        encoded = tokenizer(
            prompts,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=160,
        )
        with torch.inference_mode():
            generated = model.generate(
                **encoded,
                num_beams=1,
                max_new_tokens=160,
            )
        translated = tokenizer.batch_decode(generated, skip_special_tokens=True)
        for source, value in zip(batch, translated):
            value = simplify.convert(value).strip()
            if definitions:
                value = DEFINITION_PREFIX_RE.sub("", value).strip().rstrip("。.;；")
            cache[source] = value
        if done % 10 == 0 or done * batch_size >= total:
            write_json(cache_path, cache)
            print(f"{'meanings' if definitions else 'examples'}: {min(done * batch_size, total)}/{total}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("openjlpt", type=Path)
    parser.add_argument("tatoeba", type=Path)
    parser.add_argument("model_snapshot", type=Path)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()

    rows_by_word: dict[str, dict] = {}
    for level in LEVELS:
        rows = read_json(args.openjlpt / "data" / "json" / "vocab" / f"{level}.json")
        if not isinstance(rows, list):
            raise SystemExit(f"invalid OpenJLPT file for {level}")
        for row in rows:
            if not isinstance(row, dict):
                continue
            word = str(row.get("word") or "").strip()
            if word and word not in rows_by_word:
                rows_by_word[word] = row

    meanings = sorted(
        {
            "; ".join(str(item).strip() for item in row.get("meanings", []) if str(item).strip())
            for row in rows_by_word.values()
        }
        - {""}
    )
    examples = sorted(
        {
            str(example.get("en") or "").strip()
            for row in rows_by_word.values()
            for example in row.get("examples", [])[:5]
            if isinstance(example, dict) and str(example.get("en") or "").strip()
        }
    )

    simplify = OpenCC("t2s")
    exact_zh = load_tatoeba_map(args.tatoeba, simplify)
    meaning_cache_path = ROOT / "japanese-meaning-zh-cache.json"
    example_cache_path = ROOT / "japanese-example-zh-cache.json"
    meaning_cache = read_json(meaning_cache_path) if meaning_cache_path.exists() else {}
    example_cache = read_json(example_cache_path) if example_cache_path.exists() else {}
    if not isinstance(meaning_cache, dict) or not isinstance(example_cache, dict):
        raise SystemExit("translation cache is invalid")

    # Seed authentic Japanese-to-Chinese translations before local MT fallback.
    for row in rows_by_word.values():
        for example in row.get("examples", [])[:5]:
            if not isinstance(example, dict):
                continue
            ja = str(example.get("ja") or "").strip()
            en = str(example.get("en") or "").strip()
            if en and ja in exact_zh:
                example_cache[en] = exact_zh[ja]

    tokenizer, model = load_model(args.model_snapshot)
    translate_missing(
        meanings,
        meaning_cache,
        tokenizer,
        model,
        simplify,
        meaning_cache_path,
        definitions=True,
        batch_size=args.batch_size,
    )
    translate_missing(
        examples,
        example_cache,
        tokenizer,
        model,
        simplify,
        example_cache_path,
        definitions=False,
        batch_size=args.batch_size,
    )

    cards: dict[str, dict] = {}
    for word, row in rows_by_word.items():
        source_meaning = "; ".join(
            str(item).strip() for item in row.get("meanings", []) if str(item).strip()
        )
        card: dict = {
            "翻译": WORD_MEANING_OVERRIDES.get(
                word,
                clean_chinese_meaning(meaning_cache.get(source_meaning, "").strip()),
            )
        }
        translated_examples = []
        for example in row.get("examples", [])[:5]:
            if not isinstance(example, dict):
                continue
            ja = str(example.get("ja") or "").strip()
            en = str(example.get("en") or "").strip()
            if ja:
                translated_examples.append(
                    {
                        "场景": "开放例句",
                        "例句": ja,
                        "中译": EXAMPLE_JA_OVERRIDES.get(ja)
                        or exact_zh.get(ja)
                        or example_cache.get(en, "").strip(),
                    }
                )
        if translated_examples:
            card["例句组"] = translated_examples
        cards[word] = card

    empty_meanings = [word for word, card in cards.items() if not card.get("翻译")]
    empty_examples = [
        f"{word}:{example.get('例句', '')}"
        for word, card in cards.items()
        for example in card.get("例句组", [])
        if not example.get("中译")
    ]
    non_chinese_meanings = [
        word for word, card in cards.items() if card.get("翻译") and not HAN_RE.search(card["翻译"])
    ]
    if empty_meanings or empty_examples or non_chinese_meanings:
        raise SystemExit(
            json.dumps(
                {
                    "empty_meanings": empty_meanings[:20],
                    "empty_examples": empty_examples[:20],
                    "non_chinese_meanings": non_chinese_meanings[:20],
                },
                ensure_ascii=False,
            )
        )
    write_json(ROOT / "japanese-zh-cards.json", cards)
    print(
        json.dumps(
            {
                "cards": len(cards),
                "meanings": len(meaning_cache),
                "examples": len(example_cache),
                "tatoeba_exact": len(exact_zh),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
