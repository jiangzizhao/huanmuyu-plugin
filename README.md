# 换母语 (Native)

一个装在 [Obsidian](https://obsidian.md) 里的**语言自学插件**：打卡日历 + 今日新词(每词 10 句场景例句、读音标注、真人朗读) + 艾宾浩斯复习 + 分级阅读(逐词音标 / 振假名) + 造句 AI 批改 + 生词库。支持英/日/韩/法/中/西班牙/阿拉伯语。**学习进度全部存在你本机，不上传。**

📖 图文使用教程：<https://api.monoi.cn/nbp/native/guide>

## 它怎么工作

- **插件**(本仓库)：学习界面 + 本地进度。开源、MIT。
- **内容**(词卡 / 文章 / 批改)：由配套的 [换母语 skill](https://github.com/jiangzizhao/huanmuyu-skill) 用你自己的 Claude Code / Codex 生成，写进你的 Obsidian 库，插件读出来。
- **授权**：¥29.9 / 100 天，公众号购买；插件在线校验密钥(`api.monoi.cn`)，绑 1 台设备。

## 安装

- **社区插件市场**：搜「换母语」→ 安装 → 启用。
- **手动**：把 release 里的 `main.js` / `manifest.json` / `styles.css`(以及 `wordlists/`、`ipa-en.json` 等数据)放进 `你的库/.obsidian/plugins/native/`，再在第三方插件里启用。

## 从源码构建

```bash
npm install
npm run build   # 产出 main.js
```

源码在 `main.ts`(TypeScript，esbuild 打包)。

## 许可

MIT。内容生成 skill 见 [huanmuyu-skill](https://github.com/jiangzizhao/huanmuyu-skill)。

—— [monoi.cn](https://monoi.cn)
