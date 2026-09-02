# Korean vocabulary data notice

The Korean vocabulary terms, ordering, Chinese glosses, and pronunciation
fields in `wordlists/TOPIK 1.json` through `wordlists/TOPIK 6.json` and
`korean-cards.ts` are adapted from:

> Open Yonsei Korean Vocabulary contributors, “Open Yonsei Korean Vocabulary
> dataset”, version 0.1.0, CC BY-SA 3.0.

Source: <https://github.com/sugalhjk-tech/yonsei-korean-vocabulary>

Changes made for Huanmuyu:

- mapped the six ordered learning volumes to six TOPIK-oriented ability bands;
- removed duplicate terms from later bands and kept each term at its earliest band;
- omitted unused dictionary, etymology, and editorial metadata;
- converted the remaining terms and glosses into Huanmuyu's embedded JSON/TypeScript formats.

These bands are designed for TOPIK-oriented study and are not an official
vocabulary list published or endorsed by NIIED, TOPIK, Yonsei University, or
the National Institute of Korean Language.

The adapted data remains available under CC BY-SA 3.0:
<https://creativecommons.org/licenses/by-sa/3.0/>.
