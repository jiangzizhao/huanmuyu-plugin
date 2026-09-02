# Huanmuyu (换母语)

**Huanmuyu** is a language self-study plugin for Obsidian. It gives you a daily check-in calendar, new-word cards, spaced-repetition review, graded reading, text-to-speech, sentence practice, and a personal vocabulary book. It supports English, Japanese, Korean, French, Chinese, Spanish, and Arabic. Korean vocabulary and reading folders are organized into TOPIK 1–6 bands. All learning progress stays inside your own vault.

一个装在 [Obsidian](https://obsidian.md) 里的**语言自学插件**：打卡日历 + 今日新词 + 艾宾浩斯复习 + 分级阅读 + 自然朗读 + 造句练习 + 生词库。支持英/日/韩/法/中/西班牙/阿拉伯语；韩语词汇和阅读按 **TOPIK 1—6** 分级。**学习进度全部存在你本机，不上传。**

📖 图文使用教程：<https://api.monoi.cn/nbp/native/guide>

## 它怎么工作

- **插件**(本仓库)：学习界面、内置分级词表、词卡基础信息和本地进度。开源、MIT。
- **内容**：装好插件并验证授权后即可使用内置内容；也可以在插件内导入自己的单词和 Markdown 文章。
- **朗读**：英语自然声模型在电脑本地运行；其他语言使用系统语音，全程不上传朗读文字。
- **授权**：公众号购买 100 天权益；插件在线校验密钥(`api.monoi.cn`)，绑 1 台设备。

## 安装

- **社区插件市场**：搜「换母语」→ 安装 → 启用。
- **手动**：把 release 里的 `main.js` / `manifest.json` / `styles.css` 放进 `你的库/.obsidian/plugins/huanmuyu/`，再在第三方插件里启用。

## 网络使用 (Network use)

本插件在下列情况下会发起网络请求，除此之外**不联网、不上传你的学习数据**：

| 时机 | 请求 | 发送的数据 | 用途 |
|---|---|---|---|
| 你在设置里点「验证密钥」，或插件定期校验授权 | `POST https://api.monoi.cn/nbp/native/validate` | 你输入的密钥、一个本机随机生成的设备 ID | 校验付费授权是否有效、是否绑定当前设备 |
| 首次需要英文音标数据时 | `GET https://api.monoi.cn/nbp/native/ipa` | 无 | 下载一份英文音标词典缓存到本地，之后离线可用 |
| 英语词卡本机尚未缓存时 | `GET https://api.monoi.cn/nbp/native/cards` | 授权码、设备 ID、所需单词 | 只返回当天需要的英语词卡并缓存到本机 |

- 你的**词卡、文章、打卡进度、生词库**全部只存在你自己的 Obsidian 库里，**不会上传到任何服务器**。
- 本插件不会替你调用第三方 AI 接口，也不会上传笔记、文章、打卡进度或生词库。
- The plugin contacts `api.monoi.cn` only for license validation and official English learning assets. It never uploads notes, progress, or the personal vocabulary book.

## 从源码构建

```bash
npm install
npm run build   # 产出 main.js
```

源码在 `main.ts`(TypeScript，esbuild 打包)。

## 许可

插件代码使用 MIT 许可。韩语词汇数据的来源和 CC BY-SA 3.0 说明见 [`KOREAN-DATA-NOTICE.md`](KOREAN-DATA-NOTICE.md)。

—— [monoi.cn](https://monoi.cn)
