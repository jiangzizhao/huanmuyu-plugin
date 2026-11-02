# Huanmuyu

[中文说明](README.zh-CN.md)

Huanmuyu is a desktop language-learning plugin for [Obsidian](https://obsidian.md). It combines a daily calendar, vocabulary cards, spaced-repetition review, graded reading, speech playback, sentence practice, and a personal vocabulary book. The learning interface and translations are designed primarily for Chinese-speaking learners.

## Requirements and paid access

- Obsidian desktop, version 1.4.0 or later. This plugin is **desktop-only**, not a mobile plugin.
- A **paid 100-day license** is required to unlock the learning features. Purchase is handled through the `monoi.cn` WeChat official account; enter the supplied key in the plugin and validate it online. The license is bound to one device.
- Internet access is needed for license validation, missing learning assets, and the speech operations described below. English and Japanese natural speech also need local storage and sufficient computer resources for a local model.

The plugin source is available under MIT; this does not make the hosted service or its paid license free. After a license expires, saved learning material and progress remain in the vault. Continuing licensed learning features requires a valid license.

## Install and start

1. Download `main.js`, `manifest.json`, and `styles.css` from a published release of this repository. Put them directly in `<vault>/.obsidian/plugins/huanmuyu/`.
2. In Obsidian, open **Settings → Community plugins** and enable Huanmuyu. Restart Obsidian if the newly installed plugin is not listed yet.
3. Enter your paid key in Huanmuyu's settings and click the validation button. Open its calendar using the calendar ribbon icon or the Huanmuyu command.
4. Choose a language, complete any required placement test, and open a date to start learning.

If Huanmuyu is listed in your community-plugin directory, installation and updates can use that listing instead. Manual installation does not require a community-directory listing.

[Illustrated installation and usage guide](https://api.monoi.cn/nbp/native/guide)

## Learning and speech

- The plugin supports study tracks for English, Japanese, Korean, French, Chinese, Spanish, and Arabic. Built-in graded content is provided for English, Japanese, and Korean; you can also import vocabulary and Markdown reading material.
- Korean content uses TOPIK 1–6 bands. Japanese uses N5–N1-oriented bands and a required placement test to recommend a starting point, with Chinese glosses and example translations.
- Progress, review records, imported material, and the personal vocabulary book are stored in your vault. This is local storage, not a cloud-sync service.
- English and Japanese natural speech is synthesized locally after the required assets are cached. English has female and male voice options; Japanese uses the fixed female voice labelled 02 in the interface.
- Selecting English or Japanese can automatically prepare speech assets in the background, including when reopening Obsidian with that language already selected. Missing assets are also prepared when speech is requested. **No separate manual voice-pack installation is required.** The first preparation can take longer and needs internet access; subsequent use reuses cached assets where available.
- Korean natural speech uses the remote service described below, then caches the returned audio locally. Other languages and speech fallbacks use the computer's speech facilities; voice availability and any operating-system network requirements depend on the selected system voice.

## Network use and privacy

The following describes the requests made by this source version. Download hosts receive normal connection metadata such as your IP address. A custom license endpoint, if configured, changes where validation is sent; the Korean speech URL is derived from a license URL ending in `/validate`, otherwise it uses the default URL below.

| Trigger | Destination and request | Data sent and purpose |
|---|---|---|
| You click the key-validation button in settings or on the locked calendar | `POST https://api.monoi.cn/nbp/native/validate` by default | The entered license key and a locally generated device ID (`deviceId`), to check access and device binding. |
| English pronunciation annotations need a dictionary that is not cached locally | `GET https://api.monoi.cn/nbp/native/ipa` | A request for the English IPA dictionary; this request does not include the article being read. The dictionary is cached locally. |
| A requested vocabulary batch lacks complete local cards | `GET https://api.monoi.cn/nbp/native/cards` | License key, device ID, language, and requested words in query parameters. This may apply to **English, Japanese, or Korean**, and fills missing card information or examples. |
| English or Japanese local speech is prepared and model files are missing | Downloads under `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/` | Requests for `config.json`, tokenizer files, and `onnx/model_quantized.onnx`. The model-download request does not contain the text being spoken or the plugin license key. Files are cached in the plugin directory. |
| Japanese local speech needs its pronunciation-processing assets | Downloads under `https://cdn.jsdelivr.net/npm/kokoro-js-jp@0.2.0/dist/` | Requests for the Open JTalk dictionary, voice, JavaScript worker/wrapper, and WASM files. The client checks their expected sizes and SHA-256 hashes before caching them. These download requests do not contain the text being spoken or the plugin license key. |
| You play Korean text whose audio is not cached locally | `POST https://api.monoi.cn/nbp/native/tts-v2` by default | License key, device ID (`device`), `language: "ko-KR"`, and the text to synthesize. **The Korean text being read is sent to the service**, including text from a reading passage or imported material if you choose to play it. The client normalizes and limits each request to 500 characters and caches returned audio for reuse. |
| Local English or Japanese speech is running | `http://127.0.0.1:<random-port>/` on your computer | A loopback-only server serves speech runtime, model, and voice assets from the plugin's `offline-tts` directory to a local renderer. It does not serve the vault's notes or send them to an external host. The listener is closed when the plugin unloads. |

The client does not provide a general upload or cloud backup of your vault, learning progress, or vocabulary book. This must not be confused with an assurance that no learning text leaves the computer: the card and Korean speech requests above deliberately send selected words or text. English/Japanese synthesis uses the local renderer; downloading its model is separate from sending text for remote synthesis.

This README describes client behavior, not the server operators' retention policies or the privacy behavior of operating-system voices and third-party download providers. Avoid requesting remote Korean speech for text you do not want to send to that service. Do not share your license key or an unredacted `data.json` file.

## Updating without losing your progress

1. Back up your vault and `<vault>/.obsidian/plugins/huanmuyu/data.json`.
2. Disable Huanmuyu. Replace **only** `main.js`, `manifest.json`, and `styles.css` with the files from the new release.
3. Keep `data.json`, your learning folders, and any existing speech caches. Do not delete the entire plugin folder as an update step.
4. Enable the plugin again, or restart Obsidian if necessary. Check the displayed version, key status, language, and saved progress before continuing.

Replacing installation files does not require buying another key. License validity is still determined by your existing entitlement.

## Troubleshooting

- **Key validation fails:** confirm the complete key, internet access, and device binding. Do not post the key in a public issue. Use the illustrated guide or contact the official account for an order or binding check.
- **First speech playback is slow or fails:** allow the initial asset download and local initialization to finish; confirm access to the download hosts above and sufficient local storage. A speech cache is not a separately purchased voice pack.
- **A Japanese or Korean level appears empty:** check the selected language and level, complete the required Japanese test, and consult the guide before deleting any learning files.

## Build from source

```bash
npm install
npm run build
```

The entry point is `main.ts`; esbuild produces `main.js`. Preserve the bundled third-party asset notices when redistributing a build. The source tree also contains the graded vocabulary and reading modules, `styles.css`, and `manifest.json`.

## License and data notices

Plugin code: [MIT](LICENSE). Vocabulary data and third-party speech assets have their own notices; the code license does not override those terms. See [Korean data notices](KOREAN-DATA-NOTICE.md), [Japanese data notices](JAPANESE-DATA-NOTICE.md), and the license/notices shipped with the speech assets under `offline-tts/`.

[monoi.cn](https://monoi.cn)
