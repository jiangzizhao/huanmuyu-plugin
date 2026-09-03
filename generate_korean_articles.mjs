import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const outputPath = resolve(root, "korean-articles.json");
const outputTsPath = resolve(root, "korean-articles.ts");
const tempPath = `${outputPath}.tmp`;
const levels = ["TOPIK 1", "TOPIK 2", "TOPIK 3", "TOPIK 4", "TOPIK 5", "TOPIK 6"];
const targetPerLevel = 60;
const batchSize = 5;
const maxConcurrency = 3;
const apiUrl = "https://api.deepseek.com/chat/completions";

async function loadApiKey() {
  const fromEnvironment = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;

  // Reuse the existing Huanmuyu development credential without copying it into
  // this project or writing it into generated assets.
  const envPath = resolve(homedir(), "tools/huanmuyu-daily/.env");
  const env = await readFile(envPath, "utf8");
  const match = env.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/m);
  if (!match) throw new Error(`DEEPSEEK_API_KEY is missing from ${envPath}`);
  return match[1].trim().replace(/^['\"]|['\"]$/g, "");
}

let apiKey = "";

function stripFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function extractJson(text) {
  const cleaned = stripFence(text);
  const starts = [cleaned.indexOf("["), cleaned.indexOf("{")].filter((index) => index >= 0);
  if (!starts.length) throw new Error("response contains no JSON");
  const start = Math.min(...starts);
  const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  if (end < start) throw new Error("response JSON is incomplete");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function countMatches(text, regex) {
  return (text.match(regex) ?? []).length;
}

function normalizeArticle(raw) {
  const title = String(raw?.title ?? "").replace(/\s+/g, " ").trim();
  const korean = String(raw?.korean ?? "").replace(/\r/g, "").trim();
  const chinese = String(raw?.chinese ?? "").replace(/\r/g, "").trim();
  const koreanHangul = countMatches(korean, /[가-힣]/g);
  const koreanHan = countMatches(korean, /[\u4e00-\u9fff]/g);
  const chineseHan = countMatches(chinese, /[\u4e00-\u9fff]/g);
  const chineseHangul = countMatches(chinese, /[가-힣]/g);
  const unsuitableTopic = /(자살|자해|살인|성폭력|마약|도박|우울|自杀|自残|杀人|性暴力|毒品|赌博|抑郁)/;

  if (
    !/[가-힣]/.test(title) ||
    koreanHangul < 15 ||
    koreanHan > 1 ||
    chineseHan < 10 ||
    chineseHangul > 2 ||
    korean.length < 20 ||
    chinese.length < 15 ||
    unsuitableTopic.test(`${korean}\n${chinese}`)
  ) {
    return null;
  }
  return { title, korean, chinese };
}

function cleanSaved(raw) {
  const cleaned = {};
  for (const level of levels) {
    const seen = new Set();
    cleaned[level] = [];
    const candidates = Array.isArray(raw?.[level]) ? raw[level] : [];
    for (const candidate of candidates) {
      const article = normalizeArticle(candidate);
      const identity = article ? `${article.title}\u0000${article.korean}` : "";
      if (!article || seen.has(identity)) continue;
      seen.add(identity);
      cleaned[level].push(article);
      if (cleaned[level].length === targetPerLevel) break;
    }
  }
  return cleaned;
}

let saveSequence = Promise.resolve();
function saveArticles(saved) {
  const snapshot = `${JSON.stringify(saved, null, 2)}\n`;
  // Three API workers may finish together. Serialize atomic file replacement
  // so one worker cannot rename another worker's temporary file.
  saveSequence = saveSequence.then(async () => {
    await writeFile(tempPath, snapshot);
    await rename(tempPath, outputPath);
  });
  return saveSequence;
}

async function writeTypeScript(saved) {
  await writeFile(
    outputTsPath,
    "// Generated for Huanmuyu. Original TOPIK-graded reading content.\n" +
      "export interface KoreanArticleTemplate { title: string; korean: string; chinese: string }\n" +
      "export const KOREAN_ARTICLES: Record<string, KoreanArticleTemplate[]> = " +
      JSON.stringify(saved) +
      ";\n"
  );
}

async function requestBatch(level, start, count, keywords, attempt = 1) {
  if (!apiKey) apiKey = await loadApiKey();
  const difficulty = {
    "TOPIK 1": "绝对初级。每篇5个很短的句子，只使用生存韩语、日常场景和最基础语法。",
    "TOPIK 2": "初级进阶。每篇6个短句，使用常见连接词和生活场景表达。",
    "TOPIK 3": "中级起步。每篇7个句子，叙述连贯，包含原因、对比或经历描述。",
    "TOPIK 4": "中级进阶。每篇8个句子，涉及社会生活、学习、文化或职场。",
    "TOPIK 5": "高级。每篇9个句子，论述清楚，适度使用书面语和抽象表达。",
    "TOPIK 6": "高级进阶。每篇10个句子，逻辑严谨，用自然书面语讨论社会、文化或科技议题。",
  }[level];
  const prompt = `你是韩国母语水平的韩语教材编辑和中韩译者。请原创 ${count} 篇 ${level} 分级阅读短文。\n难度：${difficulty}\n\n硬性要求：\n1. 每篇包含自然的韩文标题、完整韩文正文、忠实自然的简体中文译文。\n2. korean 字段只能写韩文正文，不得出现中文；chinese 字段只能写简体中文译文，不得复制韩文。\n3. 韩文必须符合韩国人的真实表达，不能把参考词生硬拼接。\n4. 每篇主题不同，不包含政治敏感、成人、医疗或投资建议。\n5. 不要罗马音、讲解、Markdown、编号或代码围栏。\n6. 只返回严格 JSON：{"articles":[{"title":"韩文标题","korean":"韩文正文","chinese":"中文译文"}]}。articles 必须正好 ${count} 项。\n\n第 ${start + 1}-${start + count} 篇可参考的词组（只在自然时使用）：\n${keywords
    .map((group, index) => `${start + index + 1}. ${group.join("、")}`)
    .join("\n")}`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.35,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你编写无版权风险的原创 TOPIK 分级阅读，并提供准确简体中文翻译。韩文与中文字段绝不混用语言，只输出合法 JSON。",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`DeepSeek ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    const parsed = extractJson(String(payload?.choices?.[0]?.message?.content ?? ""));
    const list = Array.isArray(parsed) ? parsed : parsed.articles;
    const articles = Array.isArray(list) ? list.map(normalizeArticle).filter(Boolean) : [];
    if (articles.length !== count) {
      throw new Error(`expected ${count} valid articles, got ${articles.length}`);
    }
    return articles;
  } catch (error) {
    if (attempt >= 4) throw error;
    const delay = 1_500 * 2 ** (attempt - 1);
    process.stdout.write(`retry ${attempt}/3 (${String(error).slice(0, 100)}) ... `);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    return requestBatch(level, start, count, keywords, attempt + 1);
  }
}

function keywordGroups(words, count) {
  const groups = [];
  const span = Math.max(1, Math.floor(words.length / count));
  for (let index = 0; index < count; index++) {
    const offset = Math.min(words.length - 1, index * span);
    groups.push(words.slice(offset, offset + 6));
  }
  return groups;
}

let rawSaved = {};
try {
  rawSaved = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  rawSaved = {};
}
const saved = cleanSaved(rawSaved);
await saveArticles(saved);
console.log("Validated existing articles:", Object.fromEntries(levels.map((level) => [level, saved[level].length])));

if (process.argv.includes("--emit-only")) {
  await writeTypeScript(saved);
  console.log("Emitted current validated article library without API generation.");
  process.exit(0);
}

const jobs = [];
for (const level of levels) {
  const words = JSON.parse(await readFile(resolve(root, "wordlists", `${level}.json`), "utf8"));
  const groups = keywordGroups(words, targetPerLevel);
  const missing = targetPerLevel - saved[level].length;
  for (let offset = 0; offset < missing; offset += batchSize) {
    const count = Math.min(batchSize, missing - offset);
    const start = saved[level].length + offset;
    jobs.push({ level, start, count, keywords: groups.slice(start, start + count) });
  }
}

let nextJob = 0;
let completed = 0;
async function worker() {
  while (nextJob < jobs.length) {
    const job = jobs[nextJob++];
    process.stdout.write(`${job.level} ${job.start + 1}-${job.start + job.count} ... `);
    const batch = await requestBatch(job.level, job.start, job.count, job.keywords);
    saved[job.level].push(...batch);
    await saveArticles(saved);
    completed += 1;
    console.log(`ok (${completed}/${jobs.length})`);
  }
}

await Promise.all(Array.from({ length: Math.min(maxConcurrency, jobs.length) }, () => worker()));

const finalArticles = cleanSaved(saved);
for (const level of levels) {
  if (finalArticles[level].length !== targetPerLevel) {
    throw new Error(`${level}: expected ${targetPerLevel}, got ${finalArticles[level].length}`);
  }
}
await saveArticles(finalArticles);
await writeTypeScript(finalArticles);
console.log("Complete:", Object.fromEntries(levels.map((level) => [level, finalArticles[level].length])));
