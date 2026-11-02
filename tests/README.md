# Review regression baseline

Run `npm run typecheck`, `npm run test:review`, and `npm run validate:japanese` before building the review branch.

`review-regression.test.mjs` is a snapshot for the November 2026 review cleanup. It checks that the active speech methods, bundled speech assets, model configuration, and previously corrected Japanese data were preserved while unused code was removed. It does not download or run a model and does not prove audible playback or linguistic accuracy of the whole dataset.

The SHA-256 values intentionally include formatting, and the dataset count and compatibility fields are fixed baselines. A future intentional code, content, dependency, or compatibility change can require updating these snapshots after reviewing the change and its relevant tests. Never undo a correct translation or functional fix merely to retain an old snapshot.
