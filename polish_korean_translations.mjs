import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const outputPath = resolve(root, "korean-articles.json");
const progressPath = resolve(root, "korean-translation-progress.json");
const tempPath = `${outputPath}.translation.tmp`;
const levels = ["TOPIK 1", "TOPIK 2", "TOPIK 3", "TOPIK 4", "TOPIK 5", "TOPIK 6"];
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");

const articles = JSON.parse(await readFile(outputPath, "utf8"));
let progress = {};
try {
  progress = JSON.parse(await readFile(progressPath, "utf8"));
} catch {
  progress = {};
}

function validChinese(value) {
  const text = String(value ?? "").trim();
  const han = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  return han >= 10 && hangul <= 2 ? text : null;
}

async function translateBatch(level, start, batch, attempt = 1) {
  const input = batch.map((article, offset) => ({
    index: start + offset,
    title: article.title,
    korean: article.korean,
  }));
  const prompt = `请把下面 ${level} 韩语分级阅读逐篇翻译成忠实、自然、通顺的简体中文。\n要求：\n1. 不增删信息，不讲解语法，不保留韩文，不使用 Markdown。\n2. 人名、地名按中文习惯处理；句意要准确，避免逐词硬译。\n3. 只返回严格 JSON：{"translations":[{"index":数字,"chinese":"中文译文"}]}。\n4. index 必须与输入一致，translations 必须正好 ${input.length} 项。\n\n输入：${JSON.stringify(input)}`;
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是严谨的韩中出版翻译，只输出合法 JSON。" },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json();
    const parsed = JSON.parse(payload?.choices?.[0]?.message?.content ?? "{}");
    const list = Array.isArray(parsed.translations) ? parsed.translations : [];
    if (list.length !== input.length) throw new Error(`expected ${input.length}, got ${list.length}`);
    const translated = new Map();
    for (const item of list) {
      const text = validChinese(item?.chinese);
      if (!Number.isInteger(item?.index) || !text) throw new Error("invalid translated item");
      translated.set(item.index, text);
    }
    if (translated.size !== input.length) throw new Error("duplicate or missing indexes");
    return input.map((item) => translated.get(item.index));
  } catch (error) {
    if (attempt >= 4) throw error;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500 * 2 ** (attempt - 1)));
    return translateBatch(level, start, batch, attempt + 1);
  }
}

const jobs = [];
for (const level of levels) {
  progress[level] ??= [];
  for (let start = 0; start < articles[level].length; start += 10) {
    const marker = `${start}-${Math.min(start + 10, articles[level].length)}`;
    if (progress[level].includes(marker)) continue;
    jobs.push({ level, start, marker, batch: articles[level].slice(start, start + 10) });
  }
}

let nextJob = 0;
let completed = 0;
let saveSequence = Promise.resolve();
function save() {
  const articleSnapshot = `${JSON.stringify(articles, null, 2)}\n`;
  const progressSnapshot = `${JSON.stringify(progress, null, 2)}\n`;
  saveSequence = saveSequence.then(async () => {
    await writeFile(tempPath, articleSnapshot);
    await rename(tempPath, outputPath);
    await writeFile(progressPath, progressSnapshot);
  });
  return saveSequence;
}

async function worker() {
  while (nextJob < jobs.length) {
    const job = jobs[nextJob++];
    process.stdout.write(`${job.level} ${job.start + 1}-${job.start + job.batch.length} ... `);
    const translations = await translateBatch(job.level, job.start, job.batch);
    translations.forEach((chinese, offset) => {
      articles[job.level][job.start + offset].chinese = chinese;
    });
    progress[job.level].push(job.marker);
    await save();
    completed += 1;
    console.log(`ok (${completed}/${jobs.length})`);
  }
}

await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, () => worker()));
console.log("All Korean article translations polished.");
