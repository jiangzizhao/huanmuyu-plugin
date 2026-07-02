# Huanmuyu (换母语)

**Huanmuyu** is a language self-study plugin for Obsidian. It gives you a daily check-in calendar, new-word cards (10 real-life example sentences each, reading annotations, and text-to-speech), spaced-repetition review, graded reading with per-word phonetics / furigana, sentence practice with AI correction, and a personal vocabulary book. It supports English, Japanese, Korean, French, Chinese, Spanish, and Arabic. All of your learning data stays inside your own vault — nothing is uploaded.

一个装在 [Obsidian](https://obsidian.md) 里的**语言自学插件**：打卡日历 + 今日新词(每词 10 句场景例句、读音标注、真人朗读) + 艾宾浩斯复习 + 分级阅读(逐词音标 / 振假名) + 造句 AI 批改 + 生词库。支持英/日/韩/法/中/西班牙/阿拉伯语。**学习进度全部存在你本机，不上传。**

📖 图文使用教程：<https://api.monoi.cn/nbp/native/guide>

## 它怎么工作

- **插件**(本仓库)：学习界面 + 本地进度。开源、MIT。
- **内容**(词卡 / 文章 / 批改)：由配套的 [换母语 skill](https://github.com/jiangzizhao/huanmuyu-skill) 用你自己的 Claude Code / Codex 生成，写进你的 Obsidian 库，插件读出来。
- **授权**：¥29.9 / 100 天，公众号购买；插件在线校验密钥(`api.monoi.cn`)，绑 1 台设备。

## 安装

- **社区插件市场**：搜「换母语」→ 安装 → 启用。
- **手动**：把 release 里的 `main.js` / `manifest.json` / `styles.css` 放进 `你的库/.obsidian/plugins/huanmuyu/`，再在第三方插件里启用。

## 网络使用 (Network use)

本插件在下列情况下会发起网络请求，除此之外**不联网、不上传你的学习数据**：

| 时机 | 请求 | 发送的数据 | 用途 |
|---|---|---|---|
| 你在设置里点「验证密钥」，或插件定期校验授权 | `POST https://api.monoi.cn/nbp/native/validate` | 你输入的密钥、一个本机随机生成的设备 ID | 校验付费授权是否有效、是否绑定当前设备 |
| 首次需要英文音标数据时 | `GET https://api.monoi.cn/nbp/native/ipa` | 无 | 下载一份英文音标词典缓存到本地，之后离线可用 |

- 你的**词卡、文章、打卡进度、生词库**全部只存在你自己的 Obsidian 库里，**不会上传到任何服务器**。
- 词卡 / 文章 / 批改内容由你自己的 Claude Code / Codex 在本地生成（见上方「它怎么工作」），本插件不代你调用任何 AI 接口。
- This plugin only contacts `api.monoi.cn` to (1) validate a paid license key and (2) download an English IPA dictionary. It never uploads your notes, progress, or vocabulary.

## 从源码构建

```bash
npm install
npm run build   # 产出 main.js
```

源码在 `main.ts`(TypeScript，esbuild 打包)。

## 许可

MIT。内容生成 skill 见 [huanmuyu-skill](https://github.com/jiangzizhao/huanmuyu-skill)。

—— [monoi.cn](https://monoi.cn)
