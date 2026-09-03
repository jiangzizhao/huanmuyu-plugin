#!/usr/bin/env python3
"""Apply reviewed, deterministic corrections to the generated Korean cards."""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path


REPAIRS = {
    ("이름", "제 이름은 이에요."): ("제 이름은 이민수예요.", "我的名字是李民秀。"),
    ("제", "제 이름은 이에요."): ("제 이름은 김민수예요.", "我的名字是金民秀。"),
    ("악기", "저는 기타를 배우고 싶어서 악기를 시작했어요."): (
        "저는 기타를 배우고 싶어서 악기 수업을 시작했어요.",
        "我想学吉他，所以开始上乐器课了。",
    ),
    ("무조건", "아이들은 무조건 사탕을 좋아해요."): (
        "부모는 자녀를 무조건 사랑해요.",
        "父母无条件地爱子女。",
    ),
    ("도움을 청하다", "문제가 생기면 선생님께 도움을 청했어요."): (
        "문제가 생겼을 때 선생님께 도움을 청했어요.",
        "出现问题时，我向老师求助了。",
    ),
    ("발견되다", "길을 가다가 지갑이 발견되어 경찰에 신고했어요."): (
        "길에서 잃어버린 지갑이 발견되어 경찰서에 보관되었어요.",
        "丢在路上的钱包被发现后，保管在了警察局。",
    ),
    ("충실하다", "자신의 임무에 충실하는 것이 중요하다."): (
        "자신의 임무에 충실한 태도가 중요하다.",
        "忠于自己职责的态度很重要。",
    ),
    ("선의", "그의 말은 선의로 들리지만 실제로는 계산이 있다."): (
        "그의 말은 선의에서 나온 것처럼 들리지만 실제로는 계산이 있다.",
        "他的话听起来像是出于善意，但实际上却有所算计。",
    ),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    cards = json.loads(args.path.read_text(encoding="utf-8"))
    applied = 0
    for word, card in cards.items():
        examples = card.get("例句组", [])
        for index, example in enumerate(examples):
            key = (word, example.get("例句"))
            replacement = REPAIRS.get(key)
            if not replacement:
                continue
            example["例句"], example["中译"] = replacement
            if index == 0:
                card["例句"], card["例句中译"] = replacement
            applied += 1
    if applied != len(REPAIRS):
        raise SystemExit(f"expected {len(REPAIRS)} repairs, applied {applied}")
    temp = args.path.with_suffix(args.path.suffix + ".tmp")
    temp.write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(args.path)
    gzip_path = args.path.with_suffix(args.path.suffix + ".gz")
    gzip_temp = gzip_path.with_suffix(gzip_path.suffix + ".tmp")
    with gzip.open(gzip_temp, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(cards, handle, ensure_ascii=False, separators=(",", ":"))
    gzip_temp.replace(gzip_path)
    print(f"applied={applied} cards={len(cards)} gzip={gzip_path}")


if __name__ == "__main__":
    main()
