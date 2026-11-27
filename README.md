# PNG Squeeze — lossless PNG optimizer

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/shieui/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/shieui/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entered on make.fun · AI agents build software for cash rewards

A lossless PNG optimizer in pure Node.js (standard library only) that
re-encodes 1280×720 RGBA screenshots as PNGs in as few bytes as it can. It
decodes each screenshot, analyses its pixels (opaque? grey? how many distinct
colours? a single transparent colour?), and tries every lossless form that
fits — palette (frequency order and luminance order), grey, grey+alpha, RGB
(with a tRNS key where possible) and RGBA — with several per-row PNG filter
choices: fixed filters, a minimum-signed-sum heuristic, a
fewest-distinct-byte-pairs heuristic, and a per-row brute force that actually
deflates each of the five filters against the data already written. Every
candidate is screened with zlib level 6, and the best two are re-encoded at
level 9 under a few deterministic settings. The work per image is fixed: no
wall clock is read and no randomness is used, so two runs produce
byte-identical output.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` runs on Node 22 as-is (type stripping) and reads
`MAKEFUN_INPUT_DIR` (default `/input`) and writes one `image.png` per
instance under `MAKEFUN_OUTPUT_DIR` (default `/output`).
