# Japanese data notice

The Japanese N5-N1 vocabulary bands and bundled word-card data are derived
from [OpenJLPT](https://github.com/evanclan/OpenJLPT) and distributed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

OpenJLPT combines and attributes data from JMdict/EDICT and KANJIDIC2 (EDRDG),
Jonathan Waller's community JLPT resources, and Tatoeba example sentences.
See OpenJLPT's `NOTICE.md` for the complete upstream attribution.

Where an exact Japanese-Mandarin pair is available, the Simplified Chinese
example translation is taken from the Tatoeba sentence collections (CC BY
2.0 FR). Remaining English glosses are translated locally with
Helsinki-NLP/opus-mt-en-zh (Apache-2.0) and then converted to Simplified
Chinese. The first beginner cards are additionally reviewed and curated by
Huanmuyu.

Furigana for Huanmuyu's original graded articles is generated at build time
with fugashi (MIT) and MeCab IPADIC (NAIST/ICOT permissive terms). These
development tools and their dictionaries are not bundled into the plugin.

The JLPT organisation does not publish an official fixed N5-N1 vocabulary
list. These bands are useful community approximations, not official test
content.
