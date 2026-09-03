#!/usr/bin/env python3
"""Generate five varied Korean examples and Chinese translations per word card.

The job is resumable and writes an atomic checkpoint after every completed
batch.  The API key is read from an environment file and is never printed or
included in generated assets.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import json
import os
import random
import re
import threading
import time
import urllib.request
from pathlib import Path


LEVELS = [f"TOPIK {number}" for number in range(1, 7)]
EXAMPLE_COUNT = 5
WRITE_LOCK = threading.Lock()


def load_env_value(path: Path, name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            match = re.match(rf"\s*{re.escape(name)}\s*=\s*(.+)", line)
            if match:
                return match.group(1).strip().strip('"').strip("'")
    raise RuntimeError(f"{name} is not configured")


def request_json(
    api_key: str,
    system: str,
    prompt: str,
    temperature: float,
    retries: int = 4,
) -> dict:
    body = json.dumps(
        {
            "model": "deepseek-chat",
            "temperature": temperature,
            "max_tokens": 8000,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                "https://api.deepseek.com/chat/completions",
                data=body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.loads(response.read().decode("utf-8"))
            content = payload["choices"][0]["message"]["content"]
            return json.loads(content)
        except Exception:
            if attempt + 1 == retries:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def request_examples(api_key: str, level: str, rows: list[dict]) -> dict:
    prompt = (
        f"请为下面 {level} 韩语词汇逐个写 {EXAMPLE_COUNT} 条自然、实用、符合韩国人表达习惯的例句，并给出准确简体中文翻译。输入中的 existing 是旧例句，仅供参考：自然的可以沿用，生硬或有语病的必须替换。\n"
        "要求：\n"
        f"1. word 必须原样返回，不遗漏、不增加；每个词严格返回 {EXAMPLE_COUNT} 个 examples，每个 sentence 都是完整韩语句子。\n"
        f"2. {EXAMPLE_COUNT} 条例句必须彼此不同，要覆盖不同人物、语境、语法和句式，scene 用 2～6 个中文字符概括场景。多样性指场景和句式多样，不要为凑五条强行扩展词义；宁可在输入词义内反复展示真实常用搭配。\n"
        "3. 每个 sentence 都必须实际包含该 word，或动词/形容词的正确自然活用形；不能只出现相关词，不能换成另一个词。例句要准确展示输入 translation 指定的词义，禁止借用同形活用去表达别的词义，不要使用‘我学习了这个词’之类的元语言模板。\n"
        "4. 输出前逐句做韩国母语语法审校，禁止连接词重复、搭配生硬、中韩混杂或翻译遗漏。\n"
        "5. 句子尽量简洁，难度不超过对应 TOPIK 等级；连接词、助词、语尾可用两个短句或简短对话展示真实位置；含斜杠或占位符的词可选常用形式自然造句。\n"
        "6. 只返回严格 JSON：{\"items\":[{\"word\":\"原词\",\"examples\":[{\"scene\":\"场景\",\"sentence\":\"韩语例句\",\"chinese\":\"中文翻译\"}]}]}。\n"
        f"输入：{json.dumps(rows, ensure_ascii=False, separators=(',', ':'))}"
    )
    return request_json(
        api_key,
        "你是严谨的韩国母语级 TOPIK 教材编辑，只输出合法 JSON。",
        prompt,
        0.2,
    )


def review_examples(api_key: str, level: str, rows: list[dict], draft: dict) -> dict:
    """Run an independent grammar/usage pass before accepting generated cards."""
    prompt = (
        f"请以韩国母语教材总编身份，逐项审校下面 {level} 的韩语例句草稿，并直接返回修正后的完整数据。\n"
        "重点检查：韩语拼写与不规则活用、助词和敬语、词语搭配、语义逻辑、中译准确性；删除中式韩语、重复句、为了凑数的句子。\n"
        "对每一条单独做硬性核对：(1) sentence 确实出现目标 word 或它的正确活用，若未出现必须重写；(2) 该用法表达的就是 translation 指定的词义，不是另一个同形词或只是相关词；不规则活用如果与另一个词的活用同形，必须根据宾语和搭配回溯到输入词的原义核对；(3) 韩国人在该场景下会自然这样说。任一项不满足必须换句。\n"
        "不要为了场景多样而扩大词义；可以在同一准确词义下换不同情境、主语和句式。例如‘\uAE0B다(划线)’虽可活用为‘그었어요’，但‘낙서를 그었어요’是错误搭配，因为涂鸦用的是另一个原形‘그리다’；遇到同形活用必须做这种回溯。\n"
        f"每个 word 必须原样保留并严格返回 {EXAMPLE_COUNT} 个彼此不同的 examples；scene 为 2～6 个中文字符。即使原稿没问题也要原样返回。只输出与原稿相同结构的严格 JSON。\n"
        f"词义参考：{json.dumps(rows, ensure_ascii=False, separators=(',', ':'))}\n"
        f"待审草稿：{json.dumps(draft, ensure_ascii=False, separators=(',', ':'))}"
    )
    return request_json(
        api_key,
        "你是韩国母语级 TOPIK 教材总编，专门纠正不自然韩语和错误活用，只输出合法 JSON。",
        prompt,
        0.0,
    )


def valid_text(value: object, pattern: str, minimum: int, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value.strip())
    if not (minimum <= len(text) <= maximum) or not re.search(pattern, text):
        return None
    return text


def existing_examples(card: dict) -> list[dict[str, str]]:
    """Normalize legacy and grouped examples without duplicating sentences."""
    examples: list[dict[str, str]] = []
    seen: set[str] = set()
    group = card.get("例句组")
    if isinstance(group, list):
        for item in group:
            if not isinstance(item, dict):
                continue
            sentence = valid_text(item.get("例句"), r"[가-힣]", 4, 140)
            chinese = valid_text(item.get("中译"), r"[\u4e00-\u9fff]", 1, 140)
            if sentence and chinese and sentence not in seen:
                scene = valid_text(item.get("场景"), r"[\u4e00-\u9fff]", 1, 12) or "常用"
                examples.append({"场景": scene, "例句": sentence, "中译": chinese})
                seen.add(sentence)
    legacy_sentence = valid_text(card.get("例句"), r"[가-힣]", 4, 140)
    legacy_chinese = valid_text(card.get("例句中译"), r"[\u4e00-\u9fff]", 1, 140)
    if legacy_sentence and legacy_chinese and legacy_sentence not in seen:
        examples.insert(0, {"场景": "常用", "例句": legacy_sentence, "中译": legacy_chinese})
    return examples[:EXAMPLE_COUNT]


def likely_contains_word(word: str, sentence: str) -> bool:
    """Reject obvious missing nouns while deferring predicates to the reviewer.

    Korean contraction and irregular conjugation are too rich for substring
    matching (for example 오다 -> 왔어요 and 사다 -> 샀어요).  Predicate
    semantics are therefore enforced by the independent review prompt.  Slash
    alternatives and parenthetical noun forms can still be checked exactly.
    """
    compact_word = re.sub(r"\s+", " ", word.strip())
    compact_sentence = re.sub(r"\s+", " ", sentence.strip())
    if compact_word in compact_sentence:
        return True
    if compact_word.endswith("다"):
        return True
    variants = {part.strip() for part in compact_word.split("/") if part.strip()}
    parenthetical = re.fullmatch(r"([^()]+)\(([^()]+)\)", compact_word)
    if parenthetical:
        variants.update({parenthetical.group(1).strip(), parenthetical.group(2).strip()})
    leading_parenthetical = re.fullmatch(r"\(([^()]+)\)(.+)", compact_word)
    if leading_parenthetical:
        tail = leading_parenthetical.group(2).strip()
        variants.update({tail, leading_parenthetical.group(1).strip() + tail})
    if compact_word.startswith("-"):
        variants.add(compact_word[1:])
    tilde_parts = [part.strip() for part in compact_word.split("~") if part.strip()]
    if len(tilde_parts) > 1 and all(part in compact_sentence for part in tilde_parts):
        return True
    # Some imported TOPIK entries contain a typo in one token.  The independent
    # reviewer sees the Chinese meaning; requiring one meaningful fixed token
    # still prevents accepting an unrelated sentence while allowing correction.
    variants.update(part for part in compact_word.split() if len(part) >= 2)
    return any(variant and variant in compact_sentence for variant in variants)


def generate_batch(api_key: str, level: str, words: list[str], cards: dict) -> dict[str, dict]:
    remaining = list(words)
    generated: dict[str, dict] = {}
    candidates: dict[str, list[dict[str, str]]] = {word: [] for word in words}
    seen_by_word: dict[str, set[str]] = {word: set() for word in words}
    for _ in range(3):
        if not remaining:
            break
        rows = []
        for word in remaining:
            current = existing_examples(cards[word])
            rows.append(
                {
                    "word": word,
                    "meaning": str(cards[word].get("翻译", "")),
                    "existing": current,
                }
            )
        payload = request_examples(api_key, level, rows)
        payload = review_examples(api_key, level, rows, payload)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        allowed = set(remaining)
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or item.get("word") not in allowed:
                continue
            word = item["word"]
            seen = seen_by_word[word]
            fresh = candidates[word]
            raw_examples = item.get("examples", [])
            for example in raw_examples if isinstance(raw_examples, list) else []:
                if not isinstance(example, dict):
                    continue
                scene = valid_text(example.get("scene"), r"[\u4e00-\u9fff]", 1, 12)
                sentence = valid_text(example.get("sentence"), r"[가-힣]", 4, 140)
                chinese = valid_text(example.get("chinese"), r"[\u4e00-\u9fff]", 1, 140)
                if (
                    scene
                    and sentence
                    and chinese
                    and sentence not in seen
                    and likely_contains_word(word, sentence)
                ):
                    fresh.append({"场景": scene, "例句": sentence, "中译": chinese})
                    seen.add(sentence)
            if len(fresh) >= EXAMPLE_COUNT and word not in generated:
                combined = fresh[:EXAMPLE_COUNT]
                generated[word] = {
                    "例句": combined[0]["例句"],
                    "例句中译": combined[0]["中译"],
                    "例句组": combined,
                }
        remaining = [word for word in remaining if word not in generated]
    return generated


def atomic_save(cards: dict, output: Path) -> None:
    temp = output.with_suffix(output.suffix + ".tmp")
    temp.write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--wordlists", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env", type=Path, default=Path("/data/nbp/.env"))
    parser.add_argument("--batch-size", type=int, default=18)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sample-per-level", type=int, default=0)
    args = parser.parse_args()

    api_key = load_env_value(args.env, "DEEPSEEK_API_KEY")
    base = json.loads(args.base.read_text(encoding="utf-8"))
    cards = json.loads(args.output.read_text(encoding="utf-8")) if args.output.exists() else base
    for word, card in base.items():
        cards[word] = {**card, **cards.get(word, {})}

    level_words: list[tuple[str, str]] = []
    for level in LEVELS:
        words = json.loads((args.wordlists / f"{level}.json").read_text(encoding="utf-8"))
        level_words.extend((level, str(word)) for word in words if str(word) in cards)

    pending = [
        (level, word)
        for level, word in level_words
        if len(existing_examples(cards[word])) < EXAMPLE_COUNT
    ]
    if args.sample_per_level > 0:
        sampled: list[tuple[str, str]] = []
        for index, level in enumerate(LEVELS):
            candidates = [item for item in pending if item[0] == level]
            count = min(args.sample_per_level, len(candidates))
            sampled.extend(random.Random(20260903 + index).sample(candidates, count))
        pending = sampled
    if args.limit > 0:
        pending = pending[: args.limit]
    jobs: list[tuple[str, list[str]]] = []
    for level in LEVELS:
        words = [word for item_level, word in pending if item_level == level]
        jobs.extend((level, words[i : i + args.batch_size]) for i in range(0, len(words), args.batch_size))
    print(f"pending={len(pending)} batches={len(jobs)} existing={len(cards)}", flush=True)

    def run(job: tuple[str, list[str]]) -> tuple[str, list[str], dict[str, dict]]:
        level, words = job
        return level, words, generate_batch(api_key, level, words, cards)

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(run, job) for job in jobs]
        for future in concurrent.futures.as_completed(futures):
            level, words, generated = future.result()
            with WRITE_LOCK:
                for word, extra in generated.items():
                    cards[word].update(extra)
                atomic_save(cards, args.output)
            completed += 1
            print(
                f"{completed}/{len(jobs)} {level} generated={len(generated)}/{len(words)} total="
                f"{sum(len(existing_examples(card)) >= EXAMPLE_COUNT for card in cards.values())}",
                flush=True,
            )

    missing = [
        word
        for _, word in level_words
        if len(existing_examples(cards[word])) < EXAMPLE_COUNT
    ]
    if missing and not args.limit and not args.sample_per_level:
        raise SystemExit(f"incomplete={len(missing)} first={missing[:20]}")
    gzip_path = args.output.with_suffix(args.output.suffix + ".gz")
    with gzip.open(gzip_path, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(cards, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"done cards={len(cards)} missing={len(missing)} gzip={gzip_path}", flush=True)


if __name__ == "__main__":
    main()
