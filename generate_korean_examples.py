#!/usr/bin/env python3
"""Generate one concise Korean example and Chinese translation per word card.

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
import re
import threading
import time
import urllib.request
from pathlib import Path


LEVELS = [f"TOPIK {number}" for number in range(1, 7)]
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


def request_examples(api_key: str, level: str, rows: list[dict], retries: int = 4) -> dict:
    prompt = (
        f"请为下面 {level} 韩语词汇逐个写一条自然、实用、符合韩国人表达习惯的例句，并给出准确简体中文翻译。\n"
        "要求：\n"
        "1. word 必须原样返回，不遗漏、不增加；sentence 必须是完整韩语句子。\n"
        "2. 例句要真正展示该词的常见用法，不要使用‘我学习了这个词’之类的元语言模板。\n"
        "3. 输出前逐句做韩国母语语法审校，禁止连接词重复、搭配生硬、中韩混杂或翻译遗漏。\n"
        "4. 句子尽量简洁，难度不超过对应 TOPIK 等级；连接词、助词、语尾可用两个短句或简短对话展示真实位置；含斜杠或占位符的词可选常用形式自然造句。\n"
        "5. 只返回严格 JSON：{\"items\":[{\"word\":\"原词\",\"sentence\":\"韩语例句\",\"chinese\":\"中文翻译\"}]}。\n"
        f"输入：{json.dumps(rows, ensure_ascii=False, separators=(',', ':'))}"
    )
    body = json.dumps(
        {
            "model": "deepseek-chat",
            "temperature": 0.2,
            "max_tokens": 8000,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": "你是严谨的韩国母语级 TOPIK 教材编辑，只输出合法 JSON。",
                },
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


def valid_text(value: object, pattern: str, minimum: int, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value.strip())
    if not (minimum <= len(text) <= maximum) or not re.search(pattern, text):
        return None
    return text


def generate_batch(api_key: str, level: str, words: list[str], cards: dict) -> dict[str, dict]:
    remaining = list(words)
    generated: dict[str, dict] = {}
    for _ in range(3):
        if not remaining:
            break
        rows = [{"word": word, "meaning": str(cards[word].get("翻译", ""))} for word in remaining]
        payload = request_examples(api_key, level, rows)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        allowed = set(remaining)
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or item.get("word") not in allowed:
                continue
            sentence = valid_text(item.get("sentence"), r"[가-힣]", 4, 140)
            chinese = valid_text(item.get("chinese"), r"[\u4e00-\u9fff]", 1, 140)
            if sentence and chinese:
                generated[item["word"]] = {"例句": sentence, "例句中译": chinese}
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
    parser.add_argument("--batch-size", type=int, default=36)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
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
        if not str(cards[word].get("例句", "")).strip()
        or not str(cards[word].get("例句中译", "")).strip()
    ]
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
                f"{sum(bool(str(card.get('例句', '')).strip()) for card in cards.values())}",
                flush=True,
            )

    missing = [
        word
        for _, word in level_words
        if not str(cards[word].get("例句", "")).strip()
        or not str(cards[word].get("例句中译", "")).strip()
    ]
    if missing and not args.limit:
        raise SystemExit(f"incomplete={len(missing)} first={missing[:20]}")
    gzip_path = args.output.with_suffix(args.output.suffix + ".gz")
    with gzip.open(gzip_path, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(cards, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"done cards={len(cards)} missing={len(missing)} gzip={gzip_path}", flush=True)


if __name__ == "__main__":
    main()
