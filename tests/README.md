# Review regression baseline

Run `npm run typecheck`, `npm run test:review`, and `npm run validate:japanese` before building the review branch.

`review-regression.test.mjs` is a snapshot for the November 2026 review cleanup. Ten unchanged speech methods, bundled speech assets, model configuration, and previously corrected Japanese data retain their original baselines. Only the two iframe listeners and one equivalent string literal have targeted, reviewed baseline updates for message validation and escape cleanup.

`review-tts-protocol.test.mjs` uses the actual sender scripts with fake engines and transferred PCM buffers, tests valid/invalid messages and receiver frame/request boundaries, and never loads a model. `review-ui.test.mjs` checks asynchronous callback completion/failure, the modal's Markdown component lifecycle, and filename sanitizing equivalence across UTF-16 code units. These are isolated unit tests, not an audible-playback or full Obsidian/Electron integration test, and do not prove linguistic accuracy of the whole dataset.

The SHA-256 values intentionally include formatting, and the dataset count and compatibility fields are fixed baselines. A future intentional code, content, dependency, or compatibility change can require updating these snapshots after reviewing the change and its relevant tests. Never undo a correct translation or functional fix merely to retain an old snapshot.
