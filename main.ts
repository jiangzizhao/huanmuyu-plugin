import {
  App,
  Component,
  Editor,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
  setIcon,
} from "obsidian";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { createServer, Server } from "http";
import { dirname, extname, normalize, resolve } from "path";
import { WORDLISTS } from "./wordlists";
import { KOREAN_CARDS } from "./korean-cards";
import {
  KOREAN_ARTICLES,
  type KoreanArticleTemplate,
} from "./korean-articles";
import KOKORO_WEB_JS from "embedded-asset:offline-tts/kokoro.web.js";
import KOKORO_LICENSE from "embedded-asset:offline-tts/LICENSE-KOKORO.txt";
import ORT_MJS from "embedded-asset:offline-tts/ort/ort-wasm-simd-threaded.mjs";
import ORT_WASM from "embedded-asset:offline-tts/ort/ort-wasm-simd-threaded.wasm";
import VOICE_HEART from "embedded-asset:offline-tts/voices/af_heart.bin";
import VOICE_MICHAEL from "embedded-asset:offline-tts/voices/am_michael.bin";

/* ============================================================
 *  Constants
 * ========================================================== */

export const VIEW_TYPE_NATIVE = "native-calendar";

const DAY_MS = 86_400_000;
const PROGRAM_DAYS = 100;
const TRAIL_WEEKS = 8; // weeks of perpetual real-date cells after milestone

/** Word-list levels available for the plan (matches wordlists/<level>.json). */
const LEVELS: readonly string[] = [
  "小学",
  "初中",
  "高中",
  "CET4",
  "CET6",
  "雅思",
];

/** Korean proficiency bands; independent from the English level setting. */
const KOREAN_LEVELS: readonly string[] = [
  "TOPIK 1",
  "TOPIK 2",
  "TOPIK 3",
  "TOPIK 4",
  "TOPIK 5",
  "TOPIK 6",
];

/**
 * Build the DEFAULT daily task list. Tasks 1 and 3 reference the plan numbers
 * (newPerDay / articlesPerDay); the rest are fixed plain wording.
 */
function defaultTasks(newPerDay: number, articlesPerDay: number): string[] {
  return [
    `学 ${newPerDay} 个新词`,
    "复习到期单词",
    `读 ${articlesPerDay} 篇文章`,
    "自己造句 + AI 批改",
    "导入单词",
    "导入文章",
  ];
}

/**
 * Classify a task label as an import action so the DayModal can attach the
 * right inline 导入 button. Matches the 导入单词 / 导入文章 wording.
 */
function importKind(label: string): "words" | "article" | null {
  if (label.includes("导入") && label.includes("单词")) return "words";
  if (label.includes("导入") && label.includes("文章")) return "article";
  return null;
}

interface Phase {
  numeral: string;
  name: string;
  start: number; // 1-based day, inclusive
  end: number; // 1-based day, inclusive
}

const PHASES: readonly Phase[] = [
  { numeral: "I", name: "拨开关", start: 1, end: 7 },
  { numeral: "II", name: "造小气候", start: 8, end: 30 },
  { numeral: "III", name: "密度爬坡", start: 31, end: 70 },
  { numeral: "IV", name: "换声", start: 71, end: 100 },
];

interface LegendEntry {
  cls: string;
  label: string;
}

/** An article note under 换母语/<lang>/阅读/, with its resolved date. */
interface Article {
  file: TFile;
  /** Display title (frontmatter 篇目 → basename). */
  title: string;
  /** Resolved date string (YYYY-MM-DD) or "" if none found. */
  date: string;
}

const LEGEND: readonly LegendEntry[] = [
  { cls: "native-c0", label: "新的一天" },
  { cls: "native-broken", label: "明天再来" },
  { cls: "native-c1", label: "起步啦" },
  { cls: "native-c2", label: "在状态" },
  { cls: "native-c34", label: "过半咯" },
  { cls: "native-c5", label: "就差一点" },
  { cls: "native-c6", label: "满分啦" },
];

/* ============================================================
 *  Settings
 * ========================================================== */

interface LicenseState {
  valid: boolean;
  expiresAt: number | null;
  /** Human-readable reason when invalid (过期 / 设备数超限 / 密钥不存在 …). */
  reason?: string;
}

/** data[language][YYYY-MM-DD] = boolean[] sized to the task list. */
type ProgressData = Record<string, Record<string, boolean[]>>;

/** Per-day measured counters that drive the per-task progress bars. */
interface DayMetrics {
  /** New words pressed 学会了 today. */
  learned: number;
  /** Words graded in 今日复习 today (记住了 or 没记住). */
  reviewed: number;
  /** Articles marked read today (reader opened or 读完 toggled). */
  articlesRead: number;
}

/** metrics[language][YYYY-MM-DD] = DayMetrics. */
type MetricsData = Record<string, Record<string, DayMetrics>>;

interface NativeSettings {
  licenseKey: string;
  deviceId: string;
  /** 授权验证端点(Supabase Edge Function 全地址)。 */
  licenseApi: string;
  mockLicense: boolean;
  currentLanguage: string;
  languages: string[];
  startDate: string;
  /** 当前季(第几个 100 天计划),从 1 开始;每续费开启新季 +1。 */
  season: number;
  /** 当前季的开始日期(ISO);开启新季时置为当天。 */
  seasonStart: string;
  /** 每一季的开始日期(ISO),下标 = 季号-1;用于回看往季日历。 */
  seasonStarts: string[];
  license: LicenseState;
  data: ProgressData;
  /** Per-day measured counters (learned / reviewed / articlesRead). */
  metrics: MetricsData;
  /** Show IPA phonetics above English words in the reader. */
  showIPA: boolean;
  /** TTS playback rate for the article reader (0.5–1.25). */
  speechRate: number;
  /** Preferred TTS voice name; "" → auto-pick a clear default by language. */
  voiceName: string;
  /** 英语离线朗读音色(Kokoro):af_heart(女)/ am_michael(男)。 */
  ttsVoice: string;
  /** Customizable daily task list (drives the DayModal checklist). */
  tasks: string[];
  /** Plan: new words to learn per day. */
  newPerDay: number;
  /** Plan: articles to read per day. */
  articlesPerDay: number;
  /** Plan: total target vocabulary. */
  totalTarget: number;
  /** Plan: total days. */
  totalDays: number;
  /** Plan: word-list level (one of LEVELS). */
  level: string;
  /** Current Korean TOPIK band (one of KOREAN_LEVELS). */
  koreanLevel: string;
  /** First study date for each TOPIK band, so a newly selected band starts at word 1. */
  koreanLevelStarts: Record<string, string>;
  /** Words already learned (entered Ebbinghaus), keyed by level. */
  learned: Record<string, string[]>;
  /** Today's fixed 今日新词 batch (so learned words stay visible + bookmarked). */
  newWordPlan?: { date: string; level: string; words: string[] };
  /** True once the placement test (分级测试) has been taken or skipped. */
  placementDone: boolean;
}

/** One scenario example sentence inside a word card's 例句组. */
interface WordExample {
  ["场景"]?: string;
  ["例句"]: string;
  ["中译"]?: string;
}

/** An expansion card for a new word, from 换母语/<lang>/词卡.json. */
interface WordCard {
  ipa?: string;
  ["翻译"]?: string;
  /** Legacy single example (kept for back-compat with old cards). */
  ["例句"]?: string;
  ["例句中译"]?: string;
  /** New: up to 10 scenario sentences. Preferred over the single 例句 above. */
  ["例句组"]?: WordExample[];
  ["近义词"]?: string;
}

/** Optional structured fields seeded into a new vocab entry by appendWord. */
interface AppendExtra {
  ipa?: string;
  translation?: string;
  example?: string;
  synonyms?: string;
}

function todayISO(): string {
  return isoFromDate(new Date());
}

function isoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Midnight-normalized date from an ISO yyyy-mm-dd string. */
function dateFromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DEFAULT_SETTINGS: NativeSettings = {
  licenseKey: "",
  deviceId: "",
  licenseApi: "https://api.monoi.cn/nbp/native/validate",
  mockLicense: false,
  currentLanguage: "英语",
  languages: ["英语", "日语", "韩语", "法语", "中文", "西班牙语", "阿拉伯语"],
  startDate: todayISO(),
  season: 1,
  seasonStart: todayISO(),
  seasonStarts: [todayISO()],
  license: { valid: false, expiresAt: null },
  data: {},
  metrics: {},
  showIPA: true,
  speechRate: 0.95,
  voiceName: "",
  ttsVoice: "af_heart",
  tasks: defaultTasks(50, 3),
  newPerDay: 50,
  articlesPerDay: 3,
  totalTarget: 5000,
  totalDays: 100,
  level: "高中",
  koreanLevel: "TOPIK 1",
  koreanLevelStarts: {},
  learned: {},
  placementDone: false,
};

/* ============================================================
 *  Text-to-speech (built-in Web Speech API) for the reader
 * ========================================================== */

/**
 * Preferred English voices, best first. The platform default is often an
 * unclear / "old man" voice, so we steer toward clear natural ones by name.
 */
const PREFERRED_EN_VOICES: readonly string[] = [
  "Samantha",
  "Allison",
  "Ava",
  "Susan",
  "Karen",
  "Serena",
  "Moira",
  "Tessa",
  "Zoe",
  "Daniel",
  "Alex",
];

/** Natural Korean voices, avoiding macOS novelty/character voices. */
const PREFERRED_KO_VOICES: readonly string[] = [
  "Yuna",
  "Microsoft SunHi Online (Natural) - Korean (Korea)",
  "Microsoft InJoon Online (Natural) - Korean (Korea)",
  "Microsoft Heami Desktop - Korean",
  "Google 한국의",
  "Google Korean",
];

/** Character voices can sound playful or distorted when reading study text. */
const KOREAN_CHARACTER_VOICE = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)(\s|$)/i;

/** Short language code (e.g. "en") used to filter speechSynthesis voices. */
function ttsCodeFor(language: string): string | null {
  const full = ttsLangFor(language);
  return full ? full.split("-")[0].toLowerCase() : null;
}

/** BCP-47 lang code for a program language; null → use the platform default. */
function ttsLangFor(language: string): string | null {
  switch (language) {
    case "英语":
      return "en-US";
    case "日语":
      return "ja-JP";
    case "韩语":
      return "ko-KR";
    case "法语":
      return "fr-FR";
    case "中文":
      return "zh-CN";
    case "西班牙语":
      return "es-ES";
    case "阿拉伯语":
      return "ar-SA";
    default:
      return null; // custom language → leave the default voice/lang
  }
}

/**
 * Split clean article text into speakable sentences on .!?。！？,
 * keeping the terminating punctuation and dropping empty fragments.
 */
function splitSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    if (/[.!?。！？]/.test(flat[i])) {
      const seg = flat.slice(start, i + 1).trim();
      if (seg) out.push(seg);
      start = i + 1;
    }
  }
  const tail = flat.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

interface SpeechSegment {
  text: string;
  sentenceIndex: number;
}

/**
 * A Korean article sounds noticeably more natural when the synthesizer sees a
 * little context.  Keep two neighbouring sentences together (within a safe
 * length) instead of restarting the voice after every full stop.  One-off word
 * and example buttons do not use this path.
 */
function naturalSpeechSegments(
  sentences: string[],
  language: string,
  useNaturalVoice: boolean
): SpeechSegment[] {
  if (language !== "韩语" || !useNaturalVoice) {
    return sentences.map((text, sentenceIndex) => ({ text, sentenceIndex }));
  }
  const result: SpeechSegment[] = [];
  const maxChars = 130;
  const maxSentences = 2;
  let text = "";
  let start = 0;
  let count = 0;
  const flush = (): void => {
    if (text) result.push({ text, sentenceIndex: start });
    text = "";
    count = 0;
  };
  sentences.forEach((sentence, index) => {
    const clean = sentence.trim();
    if (!clean) return;
    if (!text) {
      text = clean;
      start = index;
      count = 1;
      return;
    }
    if (count < maxSentences && text.length + clean.length + 1 <= maxChars) {
      text += ` ${clean}`;
      count++;
      return;
    }
    flush();
    text = clean;
    start = index;
    count = 1;
  });
  flush();
  return result;
}

/** Clamp a rate to the slider's supported range. */
function clampRate(rate: number): number {
  if (Number.isNaN(rate)) return 0.95;
  return Math.min(1.5, Math.max(0.5, rate));
}

/**
 * Drives window.speechSynthesis sentence-by-sentence for one reader.
 * Speaks one utterance per sentence (onend → next) for reliability, picks a
 * voice matching the language, and reports the active sentence index so the
 * reader can highlight it. Caller MUST call stop() on article switch / close.
 */
class SpeechController {
  private sentences: string[] = [];
  /** Source sentence to highlight for each synthesized speech segment. */
  private highlightIndices: number[] = [];
  private idx = -1;
  private lang: string | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private active = false;
  private paused = false;
  /** While true, an utterance's onend/onerror must NOT advance the queue
   *  (used when we deliberately cancel to re-speak at a new rate). */
  private suppressAdvance = false;
  /** 本地神经网络朗读音频;非空表示走本地模型而非系统语音。 */
  private audio: HTMLAudioElement | null = null;
  private useNls = false;
  /** 预取的下一句音频(边播边抓,消除句间停顿)。 */
  private prefetched: { idx: number; p: Promise<string | null> } | null = null;

  constructor(
    private getRate: () => number,
    private onSentence: (index: number) => void,
    private onState: () => void,
    private getVoiceName: () => string,
    /** 返回本地语音生成器则走自然声；返回 null 走系统语音。 */
    private getNls: () => ((text: string) => Promise<string | null>) | null = () => null
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private synth(): SpeechSynthesis | null {
    return typeof window !== "undefined" ? window.speechSynthesis ?? null : null;
  }

  /** Load voices, awaiting the async `voiceschanged` event when needed. */
  private async loadVoices(): Promise<SpeechSynthesisVoice[]> {
    const synth = this.synth();
    if (!synth) return [];
    const now = synth.getVoices();
    if (now.length) return now;
    return new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve(synth.getVoices());
      };
      synth.addEventListener("voiceschanged", finish, { once: true });
      // Fallback in case the event never fires on this platform.
      window.setTimeout(finish, 1000);
    });
  }

  /**
   * Choose a voice for `code` (BCP-47), preferring in order:
   *   1. the user's saved voiceName (if available),
   *   2. for English, the first available PREFERRED_EN_VOICES name,
   *   3. an exact lang match, then a language-prefix match.
   */
  private pickVoice(
    voices: SpeechSynthesisVoice[],
    code: string,
    language: string
  ): SpeechSynthesisVoice | null {
    // One auto-picked clear voice, no UI. macOS doesn't expose Siri to the Web
    // Speech API, so we steer to the best available: an installed Siri/Enhanced/
    // Premium voice if present, otherwise Samantha-class clear voices — never the
    // robotic "old man" (Fred) default.
    if (!voices.length) return null;
    const prefix = code.split("-")[0].toLowerCase();
    const languagePool = prefix
      ? voices.filter((v) => v.lang.toLowerCase().startsWith(prefix))
      : voices;
    const saved = this.getVoiceName().trim();
    if (saved) {
      const chosen = languagePool.find(
        (v) => v.name === saved || v.name.startsWith(saved + " ")
      );
      if (chosen) return chosen;
    }

    const isEn =
      language === "英语" || code.toLowerCase().startsWith("en");
    if (isEn) {
      const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
      const pool = en.length ? en : voices;
      const fancy = pool.find((v) => /siri|enhanced|premium|neural/i.test(v.name));
      if (fancy) return fancy;
      for (const name of PREFERRED_EN_VOICES) {
        const hit = pool.find(
          (v) => v.name === name || v.name.startsWith(name + " ")
        );
        if (hit) return hit;
      }
      return pool.find((v) => v.default) ?? pool[0] ?? null;
    }

    if (language === "韩语" || prefix === "ko") {
      const pool = languagePool.length ? languagePool : voices;
      const natural = pool.find((v) => /natural|neural|premium|enhanced|siri/i.test(v.name));
      if (natural && !KOREAN_CHARACTER_VOICE.test(natural.name)) return natural;
      for (const name of PREFERRED_KO_VOICES) {
        const hit = pool.find(
          (v) => v.name === name || v.name.startsWith(name + " ")
        );
        if (hit) return hit;
      }
      const plain = pool.find((v) => !KOREAN_CHARACTER_VOICE.test(v.name));
      return plain ?? pool[0] ?? null;
    }

    const pool = languagePool;
    return pool[0] ?? voices.find((v) => v.default) ?? null;
  }

  /**
   * Begin (or resume) reading. `language` is the program language used to pick
   * the voice/lang; `sentences` is the pre-split clean text.
   */
  async play(sentences: string[], language: string): Promise<void> {
    const nls = this.getNls();
    const synth = this.synth();
    if (!nls && !synth) {
      new Notice("此环境不支持朗读（Web Speech API 不可用）");
      return;
    }

    // Resume a paused session without restarting.
    if (this.active && this.paused) {
      if (this.useNls) void this.audio?.play().catch(() => {});
      else synth?.resume();
      this.paused = false;
      this.onState();
      return;
    }
    if (this.active) return; // already speaking

    this.useNls = !!nls;
    const segments = naturalSpeechSegments(sentences, language, this.useNls);
    this.sentences = segments.map((segment) => segment.text);
    this.highlightIndices = segments.map((segment) => segment.sentenceIndex);
    if (this.sentences.length === 0) return;

    this.lang = ttsLangFor(language);
    this.voice = null;
    if (!this.useNls && this.lang) {
      const voices = await this.loadVoices();
      this.voice = this.pickVoice(voices, this.lang, language);
    }

    // A new play() may have been superseded while awaiting voices.
    this.active = true;
    this.paused = false;
    this.idx = 0;
    this.onState();
    this.speakCurrent();
  }

  private speakCurrent(): void {
    if (!this.active) return;
    if (this.idx >= this.sentences.length) {
      this.finish();
      return;
    }
    if (this.useNls) {
      void this.playNlsCurrent();
      return;
    }
    const synth = this.synth();
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(this.sentences[this.idx]);
    u.rate = clampRate(this.getRate());
    if (this.lang) u.lang = this.lang;
    if (this.voice) u.voice = this.voice;
    u.onstart = (): void => {
      this.onSentence(this.highlightIndices[this.idx] ?? this.idx);
    };
    u.onend = (): void => {
      if (!this.active || this.suppressAdvance) return;
      this.idx++;
      this.speakCurrent();
    };
    u.onerror = (): void => {
      if (!this.active || this.suppressAdvance) return;
      this.idx++;
      this.speakCurrent();
    };
    synth.speak(u);
  }

  /** 本地模型合成 WAV → blob URL。失败返回 null，自动回退系统语音。 */
  private async fetchAudioUrl(text: string): Promise<string | null> {
    const build = this.getNls();
    if (!build) return null;
    try {
      return await build(text);
    } catch {
      return null;
    }
  }

  /** NLS 音频逐句朗读:抓该句 mp3(blob)→ 播 → onended 下一句。变速用 playbackRate(保音高)。 */
  private async playNlsCurrent(): Promise<void> {
    if (!this.active) return;
    const idx = this.idx;
    this.onSentence(this.highlightIndices[idx] ?? idx);
    // 本句:优先用已预取的,否则现抓。
    let url: string | null;
    if (this.prefetched && this.prefetched.idx === idx) {
      url = await this.prefetched.p;
      this.prefetched = null;
    } else {
      url = await this.fetchAudioUrl(this.sentences[idx]);
    }
    // 边播边预取下一句 → 句间不卡顿。
    const nx = idx + 1;
    if (nx < this.sentences.length) {
      this.prefetched = { idx: nx, p: this.fetchAudioUrl(this.sentences[nx]) };
    }
    if (!this.active || this.idx !== idx) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    if (!url) {
      // NLS 失败 → 回退系统语音读这句、继续。
      this.useNls = false;
      this.speakCurrent();
      return;
    }
    const audio = new Audio(url);
    audio.preservesPitch = true;
    audio.playbackRate = clampRate(this.getRate());
    this.audio = audio;
    const advance = (): void => {
      URL.revokeObjectURL(url);
      if (!this.active || this.suppressAdvance) return;
      this.idx++;
      this.speakCurrent();
    };
    audio.onended = advance;
    audio.onerror = advance;
    void audio.play().catch(advance);
  }

  pause(): void {
    if (!this.active || this.paused) return;
    if (this.useNls) {
      this.audio?.pause();
      this.paused = true;
      this.onState();
      return;
    }
    const synth = this.synth();
    if (!synth) return;
    synth.pause();
    this.paused = true;
    this.onState();
  }

  /**
   * Re-apply the current rate to an in-progress reading: cancel the active
   * utterance and re-speak from the current sentence onward. Each rebuilt
   * utterance reads getRate() at build time, so the new speed takes effect
   * immediately on the remaining sentences. No-op when not actively speaking.
   */
  reapplyRate(): void {
    if (this.useNls) {
      if (this.audio) this.audio.playbackRate = clampRate(this.getRate());
      if (this.paused) {
        this.paused = false;
        void this.audio?.play().catch(() => {});
      }
      this.onState();
      return;
    }
    const synth = this.synth();
    if (!synth || !this.active || this.idx < 0) return;
    // cancel() fires onend on the live utterance; guard re-entry by cancelling
    // first, then re-speaking the current sentence with a fresh utterance.
    this.suppressAdvance = true;
    synth.cancel();
    this.suppressAdvance = false;
    if (this.paused) {
      // Resume semantics: a paused reading restarts at the current sentence.
      this.paused = false;
    }
    this.speakCurrent();
    this.onState();
  }

  /**
   * Speak ONE piece of text once (resolved voice + current rate), independent
   * of the sentence queue. Used by tile speaker icons and the detail 读 button.
   * Cancels any in-progress queue reading first.
   */
  async speakOnce(text: string, language: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    // Stop any queue reading so the one-off does not overlap / get cut.
    if (this.active) this.stop();

    // 英语 + 有密钥 → NLS 自然声(单词/单句,原速最自然)。
    const url = await this.fetchAudioUrl(clean);
    if (url) {
      const audio = new Audio(url);
      audio.preservesPitch = true;
      this.audio = audio;
      audio.onended = (): void => URL.revokeObjectURL(url);
      void audio.play().catch(() => URL.revokeObjectURL(url));
      return;
    }

    const synth = this.synth();
    if (!synth) {
      new Notice("此环境不支持朗读（Web Speech API 不可用）");
      return;
    }
    synth.cancel();

    const lang = ttsLangFor(language);
    let voice: SpeechSynthesisVoice | null = null;
    if (lang) {
      const voices = await this.loadVoices();
      voice = this.pickVoice(voices, lang, language);
    }
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = clampRate(this.getRate());
    if (lang) u.lang = lang;
    if (voice) u.voice = voice;
    synth.speak(u);
  }

  /** Cancel speech and clear the active highlight. */
  stop(): void {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.prefetched) {
      void this.prefetched.p.then((u) => u && URL.revokeObjectURL(u));
      this.prefetched = null;
    }
    const synth = this.synth();
    if (synth) synth.cancel();
    const wasActive = this.active;
    this.active = false;
    this.paused = false;
    this.idx = -1;
    if (wasActive) {
      this.onSentence(-1);
      this.onState();
    }
  }

  private finish(): void {
    this.active = false;
    this.paused = false;
    this.idx = -1;
    this.onSentence(-1);
    this.onState();
  }
}

/**
 * Load speechSynthesis voices (awaiting the async `voiceschanged` event when
 * the list is not yet populated), optionally filtered to a language prefix
 * (e.g. "en"). Returns [] when Web Speech is unavailable. Used by the voice
 * dropdowns in settings and the reader header.
 */
async function loadVoicesFor(code: string | null): Promise<SpeechSynthesisVoice[]> {
  const synth =
    typeof window !== "undefined" ? window.speechSynthesis ?? null : null;
  if (!synth) return [];
  const all = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    const now = synth.getVoices();
    if (now.length) {
      resolve(now);
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", finish, { once: true });
    window.setTimeout(finish, 1000);
  });
  if (!code) return all;
  const prefix = code.toLowerCase();
  return all.filter((v) => v.lang.toLowerCase().startsWith(prefix));
}

/* ============================================================
 *  English IPA dictionary (loaded lazily from ipa-en.json)
 * ========================================================== */

/** Strip leading/trailing punctuation from a token for dictionary lookup. */
function cleanWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z'’-]+/, "")
    .replace(/[^a-z'’-]+$/, "")
    .replace(/[’]/g, "'");
}

/** Fallback IPA map (~300 common English words) if ipa-en.json is missing. */
const FALLBACK_IPA: Readonly<Record<string, string>> = {
  the: "ðə", be: "bi", to: "tu", of: "ʌv", and: "ænd", a: "ə", in: "ɪn",
  that: "ðæt", have: "hæv", i: "aɪ", it: "ɪt", for: "fɔr", not: "nɑt",
  on: "ɑn", with: "wɪð", he: "hi", as: "æz", you: "ju", do: "du", at: "æt",
  this: "ðɪs", but: "bʌt", his: "hɪz", by: "baɪ", from: "frʌm", they: "ðeɪ",
  we: "wi", say: "seɪ", her: "hɜr", she: "ʃi", or: "ɔr", an: "æn",
  will: "wɪl", my: "maɪ", one: "wʌn", all: "ɔl", would: "wʊd", there: "ðɛr",
  their: "ðɛr", what: "wʌt", so: "soʊ", up: "ʌp", out: "aʊt", if: "ɪf",
  about: "əˈbaʊt", who: "hu", get: "ɡɛt", which: "wɪtʃ", go: "ɡoʊ",
  me: "mi", when: "wɛn", make: "meɪk", can: "kæn", like: "laɪk", time: "taɪm",
  no: "noʊ", just: "dʒʌst", him: "hɪm", know: "noʊ", take: "teɪk",
  people: "ˈpipəl", into: "ˈɪntu", year: "jɪr", your: "jɔr", good: "ɡʊd",
  some: "sʌm", could: "kʊd", them: "ðɛm", see: "si", other: "ˈʌðər",
  than: "ðæn", then: "ðɛn", now: "naʊ", look: "lʊk", only: "ˈoʊnli",
  come: "kʌm", its: "ɪts", over: "ˈoʊvər", think: "θɪŋk", also: "ˈɔlsoʊ",
  back: "bæk", after: "ˈæftər", use: "juz", two: "tu", how: "haʊ",
  our: "aʊr", work: "wɜrk", first: "fɜrst", well: "wɛl", way: "weɪ",
  even: "ˈivən", new: "nu", want: "wɑnt", because: "bɪˈkɔz", any: "ˈɛni",
  these: "ðiz", give: "ɡɪv", day: "deɪ", most: "moʊst", us: "ʌs",
  hello: "həˈloʊ", world: "wɜrld", beautiful: "ˈbjutəfəl", love: "lʌv",
  life: "laɪf", water: "ˈwɔtər", fire: "ˈfaɪər", earth: "ɜrθ", air: "ɛr",
  light: "laɪt", dark: "dɑrk", night: "naɪt", read: "rid", write: "raɪt",
  word: "wɜrd", book: "bʊk", learn: "lɜrn", speak: "spik", listen: "ˈlɪsən",
  language: "ˈlæŋɡwɪdʒ", english: "ˈɪŋɡlɪʃ", today: "təˈdeɪ", tomorrow: "təˈmɑroʊ",
  fox: "fɑks", grape: "ɡreɪp", grapes: "ɡreɪps", thank: "θæŋk", please: "pliz",
};

/* ============================================================
 *  Offline English TTS (Kokoro, bundled with this plugin)
 * ========================================================== */

type KokoroModule = {
  KokoroTTS: {
    from_pretrained: (
      id: string,
      options: Record<string, unknown>
    ) => Promise<{
      generate: (
        text: string,
        options: { voice: string; speed: number }
      ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
    }>;
  };
  env: { wasmPaths: { mjs: string; wasm: string } };
  transformersEnv: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
  };
};

type KokoroInstance = {
  generate: (
    text: string,
    options: { voice: string; speed: number }
  ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
};

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_VOICE_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/";
const KOKORO_MODEL_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
const KOKORO_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
] as const;
const KOKORO_LOCAL_VOICE_JS = KOKORO_WEB_JS.replace(
  `${KOKORO_VOICE_URL}\${e}.bin`,
  "\${globalThis.__HUANMUYU_TTS_BASE__}voices/\${e}.bin"
);
const KOKORO_CLASSIC_SCRIPT = KOKORO_LOCAL_VOICE_JS
  .replaceAll(
    "import.meta",
    "({ url: globalThis.__HUANMUYU_TTS_MODULE_URL__, dirname: '' })"
  )
  .replace(
    /export\{Ef as KokoroTTS,kf as TextSplitterStream,Mf as env,Wg as transformersEnv\};\s*$/,
    "return { KokoroTTS: Ef, env: Mf, transformersEnv: Wg };"
  );
const OFFLINE_TTS_MIME: Record<string, string> = {
  ".bin": "application/octet-stream",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".wasm": "application/wasm",
};

/** Runtime files compiled into main.js so the Obsidian updater delivers them too. */
const OFFLINE_TTS_ASSETS: Readonly<Record<string, { content: string; binary: boolean }>> = {
  "LICENSE-KOKORO.txt": { content: KOKORO_LICENSE, binary: false },
  "kokoro.web.js": { content: KOKORO_LOCAL_VOICE_JS, binary: false },
  "ort/ort-wasm-simd-threaded.mjs": { content: ORT_MJS, binary: false },
  "ort/ort-wasm-simd-threaded.wasm": { content: ORT_WASM, binary: true },
  "voices/af_heart.bin": { content: VOICE_HEART, binary: true },
  "voices/am_michael.bin": { content: VOICE_MICHAEL, binary: true },
};

/**
 * Serves only files that ship inside this plugin, on localhost. The renderer
 * needs HTTP URLs for browser WASM/model loading; no request reaches Tina's
 * server and the listener is closed when Obsidian unloads the plugin.
 */
class OfflineTtsEngine {
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private initPromise: Promise<KokoroModule> | null = null;
  private modelReadyPromise: Promise<void> | null = null;
  /** Keep the ONNX session warm between sentences. */
  private ttsPromise: Promise<KokoroInstance> | null = null;
  private runner: HTMLIFrameElement | null = null;
  private runnerReady: Promise<void> | null = null;
  private runnerRequests = new Map<string, {
    resolve: (value: { audio: ArrayBuffer; sampleRate: number }) => void;
    reject: (reason: Error) => void;
  }>();

  constructor(private plugin: NativePlugin) {}

  private pluginAssetRoot(): string | null {
    const basePath = (this.plugin.app.vault.adapter as unknown as {
      getBasePath?: () => string;
    }).getBasePath?.();
    const dir = this.plugin.manifest.dir;
    if (!basePath || !dir) return null;
    return resolve(basePath, dir, "offline-tts");
  }

  /** Write the bundled assets once, invisibly, when local English TTS is first used. */
  private ensureAssets(root: string): void {
    for (const [relativePath, asset] of Object.entries(OFFLINE_TTS_ASSETS)) {
      const target = resolve(root, relativePath);
      const prefix = root.endsWith("/") ? root : `${root}/`;
      if (!target.startsWith(prefix)) throw new Error("本地语音文件路径异常");
      // Refresh the loader after a plugin update. Earlier builds depended on
      // the browser Cache API and therefore fell back to the system voice.
      if (existsSync(target) && relativePath !== "kokoro.web.js") continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, asset.binary ? Buffer.from(asset.content, "base64") : asset.content);
    }
  }

  private async startServer(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const root = this.pluginAssetRoot();
    if (!root) throw new Error("当前设备不支持本地英语语音");
    this.ensureAssets(root);
    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    const server = createServer((req, res) => {
      try {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === "/runner.html") {
          const html = `<!doctype html><meta charset="utf-8"><script>globalThis.__HUANMUYU_TTS_BASE__=location.href.replace(/runner\\.html$/,"")</script><script type="module">import{KokoroTTS,env,transformersEnv}from"./kokoro.web.js";let tts;const ensure=()=>tts??=(env.wasmPaths={mjs:location.origin+"/ort/ort-wasm-simd-threaded.mjs",wasm:location.origin+"/ort/ort-wasm-simd-threaded.wasm"},transformersEnv.allowRemoteModels=true,transformersEnv.allowLocalModels=true,transformersEnv.localModelPath=location.origin+"/model/",KokoroTTS.from_pretrained("${KOKORO_MODEL_ID}",{dtype:"q8",device:"wasm"}));ensure().then(()=>parent.postMessage({source:"huanmuyu-tts",type:"ready"},"*")).catch(err=>parent.postMessage({source:"huanmuyu-tts",type:"init-error",error:err instanceof Error?err.message:String(err)},"*"));addEventListener("message",async e=>{const d=e.data;if(!d||d.source!=="huanmuyu-tts"||d.type!=="synthesize")return;try{const r=await(await ensure()).generate(d.text,{voice:d.voice,speed:d.rate});parent.postMessage({source:"huanmuyu-tts",type:"audio",id:d.id,audio:r.audio.buffer,sampleRate:r.sampling_rate},"*",[r.audio.buffer])}catch(err){parent.postMessage({source:"huanmuyu-tts",type:"error",id:d.id,error:err instanceof Error?err.message:String(err)},"*")}})</script>`;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
          return;
        }
        const modelPrefix = `/model/${KOKORO_MODEL_ID}/`;
        const requested = pathname.startsWith(modelPrefix)
          ? `model/${pathname.slice(modelPrefix.length)}`
          : pathname.replace(/^\//, "");
        const file = resolve(root, normalize(decodeURIComponent(requested)));
        if (
          !file.startsWith(rootPrefix) ||
          !existsSync(file) ||
          statSync(file).isDirectory()
        ) {
          res.writeHead(404).end();
          return;
        }
        const size = statSync(file).size;
        res.writeHead(200, {
          "Content-Type": OFFLINE_TTS_MIME[extname(file)] ?? "application/octet-stream",
          "Content-Length": String(size),
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
      } catch {
        res.writeHead(400).end();
      }
    });
    const address = await new Promise<{ port: number }>((resolveAddress, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("本地语音服务未能启动"));
          return;
        }
        resolveAddress({ port: address.port });
      });
    });
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${address.port}/`;
    return this.baseUrl;
  }

  private async ensureRunner(): Promise<void> {
    if (this.runnerReady) return this.runnerReady;
    this.runnerReady = (async () => {
      const root = this.pluginAssetRoot();
      if (!root) throw new Error("当前设备不支持本地英语语音");
      // The iframe is only marked ready after every model file has been written.
      // This prevents the old race where the first click queried a missing config.json.
      await this.ensureModel(root);
      const base = await this.startServer();
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "display:none;width:0;height:0;border:0";
      this.runner = frame;
      const ready = new Promise<void>((resolveReady, rejectReady) => {
        // First initialization can take longer on older computers while the
        // local WASM runtime opens the model. Do not mistake that for failure.
        const timeout = window.setTimeout(() => rejectReady(new Error("本地语音引擎启动超时")), 60_000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.data?.source !== "huanmuyu-tts") return;
          if (event.data.type === "ready") { window.clearTimeout(timeout); resolveReady(); return; }
          if (event.data.type === "init-error") { window.clearTimeout(timeout); rejectReady(new Error(event.data.error || "本地语音引擎未能启动")); return; }
          if (event.data.type === "audio") {
            const request = this.runnerRequests.get(event.data.id);
            if (request) { this.runnerRequests.delete(event.data.id); request.resolve({ audio: event.data.audio, sampleRate: event.data.sampleRate }); }
          }
          if (event.data.type === "error") {
            const request = this.runnerRequests.get(event.data.id);
            if (request) { this.runnerRequests.delete(event.data.id); request.reject(new Error(event.data.error)); }
          }
        };
        window.addEventListener("message", onMessage);
      });
      document.body.appendChild(frame);
      frame.src = `${base}runner.html`;
      await ready;
    })().catch((error) => { this.runnerReady = null; throw error; });
    return this.runnerReady;
  }

  /**
   * Download the model once directly to the plugin folder, then only serve it
   * from localhost. requestUrl avoids renderer/CORS restrictions in Obsidian.
   */
  private async ensureModel(root: string): Promise<void> {
    if (this.modelReadyPromise) return this.modelReadyPromise;
    this.modelReadyPromise = (async () => {
      const missing = KOKORO_MODEL_FILES.filter(
        (relativePath) => !existsSync(resolve(root, "model", relativePath))
      );
      if (missing.length === 0) return;
      for (const relativePath of missing) {
        const response = await requestUrl({
          url: `${KOKORO_MODEL_URL}${relativePath}`,
          method: "GET",
          throw: false,
        });
        if (response.status !== 200 || !response.arrayBuffer) {
          throw new Error(`英语语音模型下载失败：${relativePath}`);
        }
        const target = resolve(root, "model", relativePath);
        const prefix = root.endsWith("/") ? root : `${root}/`;
        if (!target.startsWith(prefix)) throw new Error("本地语音模型路径异常");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(response.arrayBuffer));
      }
    })().catch((error) => {
      this.modelReadyPromise = null;
      throw error;
    });
    return this.modelReadyPromise;
  }

  private async module(): Promise<KokoroModule> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const base = await this.startServer();
      const root = this.pluginAssetRoot();
      if (!root) throw new Error("当前设备不支持本地英语语音");
      await this.ensureModel(root);
      (globalThis as typeof globalThis & { __HUANMUYU_TTS_BASE__?: string }).__HUANMUYU_TTS_BASE__ = base;
      // Obsidian blocks dynamic ES module imports from both HTTP and file URLs.
      // Execute the bundled engine as a classic plugin script instead.
      (globalThis as typeof globalThis & { __HUANMUYU_TTS_MODULE_URL__?: string }).__HUANMUYU_TTS_MODULE_URL__ = `${base}kokoro.web.js`;
      const mod = new Function(KOKORO_CLASSIC_SCRIPT)() as KokoroModule;
      // All runtime files, voices, and the model are read locally from the
      // plugin folder. No speech request reaches Tina's server or Aliyun.
      mod.transformersEnv.allowRemoteModels = true;
      mod.transformersEnv.allowLocalModels = true;
      mod.transformersEnv.localModelPath = `${base}model/`;
      mod.env.wasmPaths = {
        mjs: `${base}ort/ort-wasm-simd-threaded.mjs`,
        wasm: `${base}ort/ort-wasm-simd-threaded.wasm`,
      };
      return mod;
    })().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  /** Prepare silently after Obsidian starts so the first tap does not show a loader. */
  async warmup(): Promise<void> {
    try {
      await this.ensureRunner();
    } catch (error) {
      console.warn("Native: silent offline English TTS warmup failed", error);
    }
  }

  private getTts(): Promise<KokoroInstance> {
    if (!this.ttsPromise) {
      this.ttsPromise = this.module().then((mod) =>
        mod.KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
          dtype: "q8",
          device: "wasm",
        })
      ).catch((error) => {
        this.ttsPromise = null;
        throw error;
      });
    }
    return this.ttsPromise;
  }

  async synthesize(text: string, voice: string, rate: number): Promise<string | null> {
    const clean = text.trim().slice(0, 480);
    if (!clean) return null;
    const normalizedVoice = voice === "andy" ? "am_michael" : voice === "abby" ? "af_heart" : voice;
    const selectedVoice = normalizedVoice === "am_michael" ? "am_michael" : "af_heart";
    try {
      await this.ensureRunner();
      if (!this.runner?.contentWindow) throw new Error("本地语音引擎未就绪");
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await new Promise<{ audio: ArrayBuffer; sampleRate: number }>((resolveAudio, rejectAudio) => {
        this.runnerRequests.set(id, { resolve: resolveAudio, reject: rejectAudio });
        this.runner!.contentWindow!.postMessage({
          source: "huanmuyu-tts", type: "synthesize", id, text: clean,
          voice: selectedVoice, rate: Math.min(1.3, Math.max(0.75, rate)),
        }, "*");
      });
      return URL.createObjectURL(new Blob([this.wav(new Float32Array(result.audio), result.sampleRate)], {
        type: "audio/wav",
      }));
    } catch (error) {
      console.warn("Native: offline English TTS failed, falling back to system voice", error);
      const reason = error instanceof Error ? error.message : String(error);
      new Notice(`英语自然朗读未能启动：${reason}`, 12_000);
      return null;
    }
  }

  private wav(audio: Float32Array, sampleRate: number): ArrayBuffer {
    const output = new ArrayBuffer(44 + audio.length * 2);
    const view = new DataView(output);
    const write = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, "RIFF"); view.setUint32(4, 36 + audio.length * 2, true);
    write(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, "data"); view.setUint32(40, audio.length * 2, true);
    for (let i = 0; i < audio.length; i++) {
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, audio[i])) * 0x7fff, true);
    }
    return output;
  }

  stop(): void {
    if (this.server) this.server.close();
    this.server = null;
    this.baseUrl = null;
    this.initPromise = null;
    this.ttsPromise = null;
    this.runner?.remove();
    this.runner = null;
    this.runnerReady = null;
    for (const request of this.runnerRequests.values()) request.reject(new Error("本地语音引擎已关闭"));
    this.runnerRequests.clear();
  }
}

/**
 * Korean neural speech is generated once by the licensed Native endpoint and
 * cached both on Tina's server and in this plugin folder. Users never download
 * or run a Korean model, and replaying a sentence does not make another request.
 */
class RemoteKoreanTtsEngine {
  private inflight = new Map<string, Promise<Uint8Array | null>>();

  constructor(private plugin: NativePlugin) {}

  private cacheRoot(): string | null {
    const basePath = (this.plugin.app.vault.adapter as unknown as {
      getBasePath?: () => string;
    }).getBasePath?.();
    const dir = this.plugin.manifest.dir;
    if (!basePath || !dir) return null;
    return resolve(basePath, dir, "audio-cache", "ko-natural-female-v2");
  }

  private endpoint(): string {
    const validateUrl = this.plugin.settings.licenseApi.trim();
    return validateUrl.endsWith("/validate")
      ? `${validateUrl.slice(0, -"/validate".length)}/tts-v2`
      : "https://api.monoi.cn/nbp/native/tts-v2";
  }

  private async bytes(text: string): Promise<Uint8Array | null> {
    const hash = createHash("sha256")
      .update(`ko-natural-female-v2|${text}`, "utf8")
      .digest("hex");
    const root = this.cacheRoot();
    const file = root ? resolve(root, `${hash}.mp3`) : null;
    if (file && file.startsWith(`${root}/`) && existsSync(file) && statSync(file).size > 512) {
      return new Uint8Array(readFileSync(file));
    }

    const active = this.inflight.get(hash);
    if (active) return active;
    const task = (async (): Promise<Uint8Array | null> => {
      try {
        const response = await requestUrl({
          url: this.endpoint(),
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({
            key: this.plugin.settings.licenseKey.trim(),
            device: this.plugin.settings.deviceId,
            language: "ko-KR",
            text,
          }),
          throw: false,
        });
        if (response.status !== 200 || !response.arrayBuffer || response.arrayBuffer.byteLength <= 512) {
          return null;
        }
        const audio = new Uint8Array(response.arrayBuffer);
        if (file && root && file.startsWith(`${root}/`)) {
          try {
            mkdirSync(root, { recursive: true });
            writeFileSync(file, audio);
          } catch (error) {
            // A read-only vault must not prevent the current playback.
            console.warn("Native: could not persist Korean audio cache", error);
          }
        }
        return audio;
      } catch (error) {
        console.warn("Native: Korean natural speech request failed", error);
        return null;
      } finally {
        this.inflight.delete(hash);
      }
    })();
    this.inflight.set(hash, task);
    return task;
  }

  async synthesize(text: string): Promise<string | null> {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!clean) return null;
    const audio = await this.bytes(clean);
    return audio
      ? URL.createObjectURL(new Blob([audio], { type: "audio/mpeg" }))
      : null;
  }
}

/* ============================================================
 *  License manager
 * ========================================================== */

interface ValidateResponse {
  valid: boolean;
  expiresAt: number | null;
  reason?: string;
}

class LicenseManager {
  constructor(private plugin: NativePlugin) {}

  async validate(): Promise<LicenseState> {
    const s = this.plugin.settings;

    if (s.mockLicense) {
      s.license = s.licenseKey.trim()
        ? { valid: true, expiresAt: Date.now() + PROGRAM_DAYS * DAY_MS }
        : { valid: false, expiresAt: null, reason: "未填写密钥" };
      await this.plugin.saveSettings();
      return s.license;
    }

    if (!s.licenseKey.trim()) {
      s.license = { valid: false, expiresAt: null, reason: "未填写密钥" };
      await this.plugin.saveSettings();
      return s.license;
    }

    try {
      const res = await requestUrl({
        url: s.licenseApi,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ key: s.licenseKey.trim(), deviceId: s.deviceId }),
        throw: false,
      });
      const json = res.json as ValidateResponse;
      s.license = {
        valid: Boolean(json?.valid),
        expiresAt: json?.expiresAt ?? null,
        reason: json?.valid ? undefined : (json?.reason ?? "验证失败"),
      };
    } catch (e) {
      // Network error → fall back to cached license state.
      console.error("Native license validate failed, using cache", e);
    }

    await this.plugin.saveSettings();
    return s.license;
  }

  isUnlocked(): boolean {
    const lic = this.plugin.settings.license;
    return (
      lic.valid && (lic.expiresAt == null || lic.expiresAt > Date.now())
    );
  }
}

/* ============================================================
 *  Plugin
 * ========================================================== */

export default class NativePlugin extends Plugin {
  settings!: NativeSettings;
  license!: LicenseManager;
  /** English natural voice runs locally in the user's Obsidian app. */
  private offlineTts = new OfflineTtsEngine(this);
  /** Korean natural voice is fetched once and then played from the local cache. */
  private koreanTts = new RemoteKoreanTtsEngine(this);

  /** Lazily-loaded IPA map (word → ipa); null until first load attempt. */
  private ipaMap: Record<string, string> | null = null;
  /** True once a load has been attempted (success or fallback). */
  private ipaLoaded = false;

  /**
   * Load ipa-en.json from the plugin dir on first use; cache in memory.
   * Falls back to a small built-in map if the file is missing/invalid.
   */
  async loadIPA(): Promise<void> {
    if (this.ipaLoaded) return;
    this.ipaLoaded = true;
    const dir = this.manifest.dir;
    if (!dir) {
      console.warn("Native: manifest.dir unavailable, using fallback IPA map");
      this.ipaMap = { ...FALLBACK_IPA };
      return;
    }
    const path = normalizePath(`${dir}/ipa-en.json`);
    // 1) 先读本地(手动装 / 之前下载过的)。
    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        this.ipaMap = parsed;
        return;
      }
    } catch {
      /* 本地没有(商店只装 main.js)→ 下一步下载 */
    }
    // 2) 从服务器下载一次(3.3MB 太大不打进代码),存进插件目录,下次直接读本地。
    try {
      const res = await requestUrl({
        url: "https://api.monoi.cn/nbp/native/ipa",
        method: "GET",
        throw: false,
      });
      const parsed = JSON.parse(res.text) as Record<string, string>;
      if (res.status === 200 && parsed && typeof parsed === "object") {
        this.ipaMap = parsed;
        try {
          await this.app.vault.adapter.write(path, res.text);
        } catch {
          /* 存不下也不影响本次使用 */
        }
        return;
      }
    } catch (e) {
      console.warn("Native: ipa 下载失败,用内置简版", e);
    }
    // 3) 都不行 → 内置简版(~300 常用词),英文阅读仍可用。
    this.ipaMap = { ...FALLBACK_IPA };
  }

  /** Look up the IPA for a single word; returns null when not found. */
  lookupIPA(word: string): string | null {
    if (!this.ipaMap) return null;
    const key = cleanWord(word);
    if (!key) return null;
    return this.ipaMap[key] ?? null;
  }

  /** Licensed English/Korean natural voices; other languages use system speech. */
  ttsUrlBuilder(): ((text: string) => Promise<string | null>) | null {
    const s = this.settings;
    const key = s.licenseKey;
    const dev = s.deviceId;
    if (!key || !dev) return null;
    if (s.currentLanguage === "韩语") {
      return (text: string): Promise<string | null> =>
        this.koreanTts.synthesize(text);
    }
    if (s.currentLanguage !== "英语") return null;
    const voice = s.ttsVoice || "af_heart";
    return (text: string): Promise<string | null> =>
      this.offlineTts.synthesize(text, voice, s.speechRate);
  }

  /** Cached wordlists by level (the bundled wordlists/<level>.json arrays). */
  private wordlistCache = new Map<string, string[]>();
  /** Cached 词卡.json maps by language. */
  private cardCache = new Map<string, Record<string, WordCard>>();

  /**
   * Load the bundled wordlist for `level` from the plugin dir; cache it.
   * Returns [] if the file is missing/unreadable/malformed.
   */
  async loadWordlist(level: string): Promise<string[]> {
    const cached = this.wordlistCache.get(level);
    if (cached) return cached;
    // 内置词表(打进代码)——商店只装 main.js,靠这个装上就有词。
    const bundled = WORDLISTS[level];
    if (bundled && bundled.length) {
      this.wordlistCache.set(level, bundled);
      return bundled;
    }
    // 回退:读插件目录里的 wordlists/<level>.json(兼容自定义/新增词表)。
    const dir = this.manifest.dir;
    if (!dir) return [];
    try {
      const path = normalizePath(`${dir}/wordlists/${level}.json`);
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed.map((w) => String(w)).filter((w) => w.length > 0)
        : [];
      this.wordlistCache.set(level, list);
      return list;
    } catch (e) {
      console.warn(`Native: failed to load wordlists/${level}.json`, e);
      this.wordlistCache.set(level, []);
      return [];
    }
  }

  /**
   * Load 换母语/<lang>/词卡.json (word → expansion card) from the vault; cache
   * it. Returns {} if the file is absent/unreadable/malformed.
   */
  async loadWordCards(
    lang = this.settings.currentLanguage
  ): Promise<Record<string, WordCard>> {
    const cached = this.cardCache.get(lang);
    if (cached) return cached;
    const path = normalizePath(`换母语/${lang}/词卡.json`);
    // Korean ships compact pronunciation/translation cards in main.js so it
    // works immediately, while local richer cards can override these fields.
    let map: Record<string, WordCard> =
      lang === "韩语" ? { ...KOREAN_CARDS } : {};
    try {
      if (await this.app.vault.adapter.exists(path)) {
        const raw = await this.app.vault.adapter.read(path);
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const local = parsed as Record<string, WordCard>;
          for (const [word, card] of Object.entries(local)) {
            map[word] = { ...(map[word] ?? {}), ...card };
          }
        }
      }
    } catch (e) {
      console.warn(`Native: failed to load 词卡.json for ${lang}`, e);
    }
    this.cardCache.set(lang, map);
    return map;
  }

  /** Drop the cached 词卡.json for a language (after an external edit). */
  invalidateWordCards(lang = this.settings.currentLanguage): void {
    this.cardCache.delete(lang);
  }

  /**
   * 英语/韩语:把给定这批词里"本地还没有完整卡"的,从服务器按需拉回来、合并进 词卡.json(密钥闸)。
   * → 用户装上插件、填了密钥就有词卡,不需要额外配置。
   */
  async ensureCards(
    words: string[],
    lang = this.settings.currentLanguage
  ): Promise<void> {
    if ((lang !== "英语" && lang !== "韩语") || words.length === 0) return;
    const key = this.settings.licenseKey;
    const dev = this.settings.deviceId;
    if (!key || !dev) return;
    const cards = await this.loadWordCards(lang);
    const missing = words.filter((w) => {
      const c = cards[w];
      const ex = c?.["例句组"];
      const hasExample = Boolean(ex?.length || c?.["例句"]?.trim());
      return !c || !c["翻译"]?.trim() || !hasExample;
    });
    if (missing.length === 0) return;
    try {
      const url =
        `https://api.monoi.cn/nbp/native/cards?key=${encodeURIComponent(key)}` +
        `&device=${encodeURIComponent(dev)}` +
        `&lang=${encodeURIComponent(lang)}` +
        `&words=${encodeURIComponent(missing.join(","))}`;
      const res = await requestUrl({ url, method: "GET", throw: false });
      if (res.status !== 200) return;
      const got = res.json as Record<string, WordCard>;
      if (got && typeof got === "object" && !Array.isArray(got)) {
        Object.assign(cards, got);
        this.cardCache.set(lang, cards);
        await this.saveWordCards(lang, cards);
      }
    } catch (e) {
      console.warn("Native: ensureCards fetch failed", e);
    }
  }

  /** 持久化词卡到 换母语/<lang>/词卡.json(供插件下次直接读本地)。 */
  async saveWordCards(
    lang: string,
    cards: Record<string, WordCard>
  ): Promise<void> {
    const dir = normalizePath(`换母语/${lang}`);
    const path = normalizePath(`换母语/${lang}/词卡.json`);
    try {
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(path, JSON.stringify(cards));
    } catch (e) {
      console.warn("Native: saveWordCards failed", e);
    }
  }

  /**
   * The wordlist key for the current language. English uses school/exam levels,
   * Korean uses TOPIK 1–6, and other languages use one list named by language.
   */
  levelKey(): string {
    if (this.settings.currentLanguage === "英语") return this.settings.level;
    if (this.settings.currentLanguage === "韩语") return this.settings.koreanLevel;
    return this.settings.currentLanguage;
  }

  /**
   * 打卡/进度(data/metrics)的存储键 = **按级别**:英语用 level(小学…雅思),
   * 韩语用 TOPIK 级别,其它语言用语言名。→ 切级别就换一套日历进度。
   */
  private progressKey(language: string): string {
    if (language === "英语") return this.settings.level;
    if (language === "韩语") return `韩语:${this.settings.koreanLevel}`;
    return language;
  }

  /**
   * 学过(learned)的存储键 = **按语言全局**:英语各级别共用 "英语",
   * 其它语言用语言名。→ 一个词学过了,切级别仍算学过,不用重学。
   */
  private learnedKey(levelOrLang: string): string {
    if (LEVELS.includes(levelOrLang)) return "英语";
    if (KOREAN_LEVELS.includes(levelOrLang)) return "韩语";
    return levelOrLang;
  }

  /** Learned-word set for a level (case-insensitive membership). 全局按语言。 */
  learnedSet(level: string): Set<string> {
    const arr = this.settings.learned[this.learnedKey(level)] ?? [];
    return new Set(arr.map((w) => w.toLowerCase()));
  }

  /** Mark a word learned (idempotent) and persist. 全局按语言。 */
  async markLearned(level: string, word: string): Promise<void> {
    const k = this.learnedKey(level);
    const arr = this.settings.learned[k] ?? (this.settings.learned[k] = []);
    if (!arr.some((w) => w.toLowerCase() === word.toLowerCase())) {
      arr.push(word);
      await this.saveSettings();
    }
  }

  /**
   * 今日新词: the next `newPerDay` words from the level wordlist that are not
   * yet learned. Caps the count at the words remaining.
   */
  /**
   * 某一天的新词:按"开课日 startDate 起第几天"切分级词表,每天一批、各不相同、永久固定。
   * 第 0 天(=startDate)取词表 [0, newPerDay)，第 1 天取 [newPerDay, 2·newPerDay)，依此类推。
   * 这样点开任意一天看到的都是那一天专属的新词,不再"每天都一样"。学会的词在格子里贴书签。
   */
  async newWordsForDay(iso: string): Promise<string[]> {
    const level = this.levelKey();
    const list = await this.loadWordlist(level);
    const n = Math.max(1, this.settings.newPerDay);
    let globalDay: number;
    if (this.settings.currentLanguage === "韩语") {
      // TOPIK bands are separate courses. A user choosing Korean months after
      // starting another language must still receive TOPIK's first batch.
      const bandStart = dateFromISO(await this.ensureKoreanLevelStart(level));
      const within = Math.round(
        (dateFromISO(iso).getTime() - bandStart.getTime()) / DAY_MS
      );
      if (within < 0) return [];
      globalDay = within;
    } else {
      // 当前季内第几天(0..99) → 全局天 = (季-1)*100 + 季内天 → 词表按全局天累加切片。
      const seasonStart = dateFromISO(this.settings.seasonStart || this.settings.startDate);
      const within = Math.max(
        0,
        Math.round((dateFromISO(iso).getTime() - seasonStart.getTime()) / DAY_MS)
      );
      globalDay =
        (Math.max(1, this.settings.season) - 1) * PROGRAM_DAYS + within;
    }
    return list.slice(globalDay * n, globalDay * n + n);
  }

  /** Ensure a TOPIK band has its own stable day-zero date. */
  async ensureKoreanLevelStart(level = this.settings.koreanLevel): Promise<string> {
    const existing = this.settings.koreanLevelStarts[level];
    if (typeof existing === "string" && /^\d{4}-\d{2}-\d{2}$/.test(existing)) {
      return existing;
    }
    const start = todayISO();
    this.settings.koreanLevelStarts[level] = start;
    await this.saveSettings();
    return start;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.license = new LicenseManager(this);
    if (this.settings.currentLanguage === "英语") {
      this.registerInterval(window.setTimeout(() => {
        void this.offlineTts.warmup();
      }, 1200));
    }

    this.registerView(
      VIEW_TYPE_NATIVE,
      (leaf) => new NativeView(leaf, this)
    );

    this.addRibbonIcon("calendar", "打开 Native 日历", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open",
      name: "打开 Native 日历",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "store-word",
      name: "存入生词库",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.storeWord(editor, view.file);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        const file = this.app.workspace.getActiveFile();
        menu.addItem((item) => {
          item
            .setTitle("存入生词库")
            .setIcon("book-marked")
            .onClick(() => {
              void this.storeWord(editor, file);
            });
        });
      })
    );

    // 库里的内容变了(外部生成词卡·文章·批改,或同步进来)→ 清缓存 + 刷新已打开的
    // 视图,用户不用重载插件、也不用手动刷新,内容自己就出来了。
    const onContentChange = (file: TAbstractFile): void => {
      const p = file?.path ?? "";
      if (!p.includes("换母语/")) return;
      if (p.endsWith("词卡.json")) {
        for (const lang of this.settings.languages) {
          if (p.includes(`换母语/${lang}/`)) this.invalidateWordCards(lang);
        }
        this.invalidateWordCards();
      }
      this.refreshViews();
    };
    this.registerEvent(this.app.vault.on("modify", onContentChange));
    this.registerEvent(this.app.vault.on("create", onContentChange));
    this.registerEvent(this.app.vault.on("delete", onContentChange));

    this.addSettingTab(new NativeSettingTab(this.app, this));
  }

  /** Re-render any open Native calendar view (called after content changes). */
  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NATIVE)) {
      const v = leaf.view;
      if (v instanceof NativeView) v.refresh();
    }
  }

  async onunload(): Promise<void> {
    this.offlineTts.stop();
    // Leaves are detached automatically by Obsidian on plugin unload.
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<NativeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    // Ensure nested objects are not shared with the default literal.
    this.settings.languages = (loaded?.languages ?? [
      ...DEFAULT_SETTINGS.languages,
    ]).slice();
    this.settings.license = Object.assign(
      { valid: false, expiresAt: null },
      loaded?.license
    );
    this.settings.data = loaded?.data ?? {};
    this.settings.metrics = loaded?.metrics ?? {};
    this.settings.learned = loaded?.learned ?? {};
    this.settings.koreanLevelStarts = { ...(loaded?.koreanLevelStarts ?? {}) };
    if (!KOREAN_LEVELS.includes(this.settings.koreanLevel)) {
      this.settings.koreanLevel = "TOPIK 1";
    }
    this.migrateProgressKeys();
    // 季节(B):老用户没这两个字段 → season=1、seasonStart=他的开课日(不是今天)。
    this.settings.season = loaded?.season ?? 1;
    this.settings.seasonStart = loaded?.seasonStart ?? this.settings.startDate;
    // 每季开始日历史(回看往季):老用户没有 → 用当前季开始日兜底补齐到当前季长度。
    this.settings.seasonStarts = Array.isArray(loaded?.seasonStarts)
      ? loaded.seasonStarts.slice()
      : [];
    while (this.settings.seasonStarts.length < this.settings.season) {
      this.settings.seasonStarts.unshift(this.settings.seasonStart);
    }
    // 当前季开始日以 seasonStart 为准,保持一致。
    this.settings.seasonStarts[this.settings.season - 1] = this.settings.seasonStart;
    // Tasks: keep a fresh array; fall back to the plan-derived default.
    const loadedTasks = loaded?.tasks;
    this.settings.tasks =
      Array.isArray(loadedTasks) && loadedTasks.length > 0
        ? loadedTasks.map((t) => String(t))
        : defaultTasks(this.settings.newPerDay, this.settings.articlesPerDay);
    if (!this.settings.deviceId) {
      this.settings.deviceId = uuid();
      await this.saveSettings();
    }
  }

  /**
   * 一次性迁移旧数据到新键方案(幂等):
   *  - 学过 learned:英语各级别(小学…雅思)合并进 learned["英语"](全局)。
   *  - 打卡/metrics:老的 data["英语"]/metrics["英语"](按语言)→ 挪到当前级别(按级别)。
   */
  private migrateProgressKeys(): void {
    // 1) 学过 → 全局按语言(英语)
    const merged = new Set(this.settings.learned["英语"] ?? []);
    let any = false;
    for (const lv of LEVELS) {
      const arr = this.settings.learned[lv];
      if (Array.isArray(arr) && arr.length) {
        arr.forEach((w) => merged.add(w));
        delete this.settings.learned[lv];
        any = true;
      }
    }
    if (any) this.settings.learned["英语"] = Array.from(merged);

    // 2) 老的按语言英语打卡/metrics → 挪到当前级别(仅当级别键还空,避免覆盖)
    const lvl = this.settings.level;
    const moveEn = (store: Record<string, unknown>): void => {
      const old = store["英语"];
      if (old && !store[lvl]) {
        store[lvl] = old;
        delete store["英语"];
      }
    };
    moveEn(this.settings.data as unknown as Record<string, unknown>);
    moveEn(this.settings.metrics as unknown as Record<string, unknown>);

    // Korean used to have a single ungraded progress bucket. Preserve it as
    // TOPIK 1 when upgrading to the six-band model.
    const koKey = "韩语:TOPIK 1";
    const moveKo = (store: Record<string, unknown>): void => {
      const old = store["韩语"];
      if (old && !store[koKey]) {
        store[koKey] = old;
        delete store["韩语"];
      }
    };
    moveKo(this.settings.data as unknown as Record<string, unknown>);
    moveKo(this.settings.metrics as unknown as Record<string, unknown>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_NATIVE)[0];
    if (!leaf) {
      const newLeaf = workspace.getLeaf(true);
      await newLeaf.setViewState({ type: VIEW_TYPE_NATIVE, active: true });
      leaf = newLeaf;
    }
    workspace.revealLeaf(leaf);
  }

  /** Number of tasks in the current customizable list. */
  taskCount(): number {
    return this.settings.tasks.length;
  }

  /**
   * Get the boolean[] for a given language+date, sized to the CURRENT task
   * list. Stored data of a different length is padded (false) / truncated so
   * completion still works after the task list changes.
   */
  /** 当前级别(英语按 level)/语言的整季打卡 map(iso→flags),给统计遍历用。 */
  dayData(language = this.settings.currentLanguage): Record<string, boolean[]> {
    return this.settings.data[this.progressKey(language)] ?? {};
  }

  getDay(language: string, iso: string): boolean[] {
    const key = this.progressKey(language);
    const n = this.taskCount();
    const day = this.settings.data[key]?.[iso];
    const out = new Array(n).fill(false) as boolean[];
    if (day) {
      for (let i = 0; i < n && i < day.length; i++) out[i] = Boolean(day[i]);
    }
    return out;
  }

  async setDay(
    language: string,
    iso: string,
    flags: boolean[]
  ): Promise<void> {
    const key = this.progressKey(language);
    if (!this.settings.data[key]) {
      this.settings.data[key] = {};
    }
    this.settings.data[key][iso] = flags;
    await this.saveSettings();
  }

  /* ---- per-day metrics (drive the progress bars) ---- */

  /** Read the DayMetrics for a language+date (zeros when absent). */
  getMetrics(language: string, iso: string): DayMetrics {
    const m = this.settings.metrics[this.progressKey(language)]?.[iso];
    return {
      learned: m?.learned ?? 0,
      reviewed: m?.reviewed ?? 0,
      articlesRead: m?.articlesRead ?? 0,
    };
  }

  /** Mutate one DayMetrics counter (by delta) and persist. */
  async bumpMetric(
    language: string,
    iso: string,
    key: keyof DayMetrics,
    delta: number
  ): Promise<void> {
    const pk = this.progressKey(language);
    if (!this.settings.metrics[pk]) this.settings.metrics[pk] = {};
    const cur = this.getMetrics(language, iso);
    cur[key] = Math.max(0, cur[key] + delta);
    this.settings.metrics[pk][iso] = cur;
    await this.saveSettings();
  }

  /**
   * Per-task completion ratios (0..1) for a language+date, one per task, in
   * task order. Measurable tasks derive their ratio from plan numbers + the
   * day's metrics / imports; non-measurable tasks fall back to the manual
   * checkbox flag (0 or 1).
   */
  taskProgress(language: string, iso: string): number[] {
    const tasks = this.settings.tasks;
    const flags = this.getDay(language, iso);
    const metrics = this.getMetrics(language, iso);
    const dueCount = this.dueCountFor(language, iso);
    const articlesForDay = this.articlesForDate(iso).length;
    const wordsImported = this.wordsImportedOn(language, iso);
    const ratio = (done: number, total: number): number =>
      total <= 0 ? 0 : Math.max(0, Math.min(1, done / total));

    return tasks.map((label, idx) => {
      const manual = flags[idx] ? 1 : 0;
      // 导入单词 / 导入文章 first (also contain no 新词/复习/读 wording).
      const imp = importKind(label);
      if (imp === "words") return wordsImported > 0 ? 1 : 0;
      if (imp === "article") return articlesForDay > 0 ? 1 : 0;
      if (label.includes("新词")) {
        return ratio(metrics.learned, this.settings.newPerDay);
      }
      if (label.includes("复习")) {
        if (dueCount === 0) return 1; // nothing due → full
        return ratio(metrics.reviewed, dueCount);
      }
      if (label.includes("读") && label.includes("篇")) {
        return ratio(metrics.articlesRead, this.settings.articlesPerDay);
      }
      return manual;
    });
  }

  /** Average of the per-task progress ratios for a language+date (0..1). */
  dayProgress(language: string, iso: string): number {
    const ps = this.taskProgress(language, iso);
    if (ps.length === 0) return 0;
    return ps.reduce((a, b) => a + b, 0) / ps.length;
  }

  /**
   * Words in the primed 生词库 snapshot whose 学于 (learnedDate) equals `iso`
   * — the measurable signal for 导入单词. Returns 0 until primeVocab() runs.
   */
  wordsImportedOn(_language: string, iso: string): number {
    return this.vocabByDate[iso] ?? 0;
  }

  /** word-count-by-learnedDate, derived from the primed vocab snapshot. */
  private vocabByDate: Record<string, number> = {};
  /** All parsed vocab entries from the primed snapshot (for due counts). */
  private vocabEntriesCache: VocabEntry[] = [];

  /**
   * Read + parse the current language's 生词库.md once into a synchronous
   * snapshot so taskProgress()/dayProgress() can run per-cell without awaiting.
   * Call this before a calendar render (and after vocab-mutating actions).
   */
  async primeVocab(language = this.settings.currentLanguage): Promise<void> {
    const path = this.vocabPath(language);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.vocabByDate = {};
      this.vocabEntriesCache = [];
      return;
    }
    const md = await this.app.vault.cachedRead(file);
    const entries = parseVocab(md);
    const byDate: Record<string, number> = {};
    for (const e of entries) {
      if (e.learnedDate) byDate[e.learnedDate] = (byDate[e.learnedDate] ?? 0) + 1;
    }
    this.vocabByDate = byDate;
    this.vocabEntriesCache = entries;
  }

  /**
   * Number of words due for review on `iso` (the 复习 denominator), from the
   * primed snapshot. Returns 0 until primeVocab() has run.
   */
  dueCountFor(_language: string, iso: string): number {
    let n = 0;
    for (const e of this.vocabEntriesCache) if (isDue(e, iso)) n++;
    return n;
  }

  /* ---- folder / path helpers ---- */

  /** Folder path `换母语/<lang>`. */
  langFolder(lang = this.settings.currentLanguage): string {
    return normalizePath(`换母语/${lang}`);
  }

  /**
   * 文章文件夹。英语和韩语按级别分子文件夹；其它语言维持扁平目录。
   */
  readingFolder(lang = this.settings.currentLanguage): string {
    if (lang === "英语") {
      return normalizePath(`换母语/英语/阅读/${this.settings.level}`);
    }
    if (lang === "韩语") {
      return normalizePath(`换母语/韩语/阅读/${this.settings.koreanLevel}`);
    }
    return normalizePath(`换母语/${lang}/阅读`);
  }

  /** File path `换母语/<lang>/生词库.md`. */
  vocabPath(lang = this.settings.currentLanguage): string {
    return normalizePath(`换母语/${lang}/生词库.md`);
  }

  /** Folder path `换母语/<lang>/笔记`. */
  notesFolder(lang = this.settings.currentLanguage): string {
    return normalizePath(`换母语/${lang}/笔记`);
  }

  /** File path `换母语/<lang>/笔记/<date>.md` for the per-day note. */
  notePath(iso: string, lang = this.settings.currentLanguage): string {
    return normalizePath(`换母语/${lang}/笔记/${iso}.md`);
  }

  /** Read the per-day note text (empty string if none). */
  async readDayNote(iso: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(this.notePath(iso));
    if (file instanceof TFile) return this.app.vault.read(file);
    return "";
  }

  /** Save the per-day note, creating folder/file as needed. */
  async saveDayNote(iso: string, text: string): Promise<void> {
    const folder = this.notesFolder();
    await this.ensureFolder(folder);
    const path = this.notePath(iso);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, text);
    } else {
      await this.app.vault.create(path, text);
    }
  }

  /** File path `换母语/<lang>/造句/<date>.md` for the per-day sentence practice. */
  writingPath(iso: string, lang = this.settings.currentLanguage): string {
    return normalizePath(`换母语/${lang}/造句/${iso}.md`);
  }

  /** Read the per-day 造句 text (empty string if none). */
  async readDayWriting(iso: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(this.writingPath(iso));
    if (file instanceof TFile) return this.app.vault.read(file);
    return "";
  }

  /** Save the per-day 造句, creating folder/file as needed. */
  async saveDayWriting(iso: string, text: string): Promise<void> {
    await this.ensureFolder(
      normalizePath(`换母语/${this.settings.currentLanguage}/造句`)
    );
    const path = this.writingPath(iso);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, text);
    } else {
      await this.app.vault.create(path, text);
    }
  }

  /** Create a folder (and ancestors) if it does not exist yet. */
  async ensureFolder(path: string): Promise<void> {
    const vault = this.app.vault;
    if (!(await vault.adapter.exists(path))) {
      await vault.createFolder(path).catch(() => {
        /* folder may already exist (race) */
      });
    }
  }

  /**
   * Shared vocab-append logic used by the editor command and the in-panel
   * 划词存库 button. Writes one structured block to the current language's
   * 生词库.md:
   *
   *   ## <word>
   *   - 翻译:
   *   - 造句: <example>
   *   - 近义词:
   *   - 来源: <src> · <date>
   *
   * If the word already exists, it is not duplicated; instead the new source
   * (and an example, if the block had none) is merged in.
   *
   * @param text        the selected word/phrase
   * @param sourceName  article basename / note title
   * @param example     optional source sentence to auto-fill 造句
   * @param extra       optional structured fields (e.g. from a 词卡) to seed
   *                    ipa / 翻译 / 造句 / 近义词 on a brand-new entry
   */
  async appendWord(
    text: string,
    sourceName: string,
    example = "",
    extra?: AppendExtra
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) {
      new Notice("先选中一个单词/短语");
      return false;
    }

    const lang = this.settings.currentLanguage;
    const folder = this.langFolder(lang);
    const path = this.vocabPath(lang);
    const src = sourceName || "?";
    const example1 = example.trim();

    // Auto-fill IPA from the bundled dictionary for English words. A 词卡 IPA
    // (passed in `extra`) wins over the dictionary lookup.
    let ipa = extra?.ipa?.trim() ?? "";
    if (!ipa && lang === "英语") {
      await this.loadIPA();
      ipa = this.lookupIPA(trimmed) ?? "";
    }
    const translation = extra?.translation?.trim() ?? "";
    const synonyms = extra?.synonyms?.trim() ?? "";
    // A 词卡 例句 seeds 造句 when no source sentence was provided.
    const example2 = example1 || (extra?.example?.trim() ?? "");

    await this.ensureFolder(folder);

    const vault = this.app.vault;
    const existing = vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      const md = await vault.read(existing);
      const entries = parseVocab(md);
      const dup = entries.find(
        (e) => e.word.toLowerCase() === trimmed.toLowerCase()
      );
      if (dup) {
        // Merge: add new source, and back-fill empty fields.
        const newSource = `${src} · ${todayISO()}`;
        if (!dup.source.includes(newSource)) {
          dup.source = dup.source ? `${dup.source}；${newSource}` : newSource;
        }
        if (!dup.example && example2) dup.example = example2;
        if (!dup.ipa && ipa) dup.ipa = ipa;
        if (!dup.translation && translation) dup.translation = translation;
        if (!dup.synonyms && synonyms) dup.synonyms = synonyms;
        await vault.modify(existing, serializeVocab(entries, lang));
        new Notice(`「${trimmed}」已在生词库（已补来源）`);
        return true;
      }
      entries.push({
        word: trimmed,
        ipa,
        translation,
        example: example2,
        synonyms,
        source: `${src} · ${todayISO()}`,
        date: todayISO(),
        ...freshSchedule(),
      });
      await vault.modify(existing, serializeVocab(entries, lang));
    } else {
      const entry: VocabEntry = {
        word: trimmed,
        ipa,
        translation,
        example: example2,
        synonyms,
        source: `${src} · ${todayISO()}`,
        date: todayISO(),
        ...freshSchedule(),
      };
      await vault.create(path, serializeVocab([entry], lang));
    }

    new Notice(`已存入「${lang}」生词库`);
    return true;
  }

  /**
   * 从服务器按需拉这个词的词卡(常见词在官方词库里就有),把释义/音标/例句/近义词
   * 填进生词库条目。生僻词(词库里没有)暂时补不了,给个提示。
   */
  async enrichWord(entry: VocabEntry): Promise<boolean> {
    await this.ensureCards([entry.word]);
    const cards = await this.loadWordCards();
    const c = cards[entry.word] ?? cards[entry.word.toLowerCase()];
    if (!c) {
      new Notice("这个词暂时没有释义(生僻词补全功能马上上线)");
      return false;
    }
    let changed = false;
    if (!entry.translation && c["翻译"]) {
      entry.translation = c["翻译"];
      changed = true;
    }
    if (!entry.ipa && c.ipa) {
      entry.ipa = c.ipa;
      changed = true;
    }
    const ex0 = c["例句组"]?.[0]?.["例句"] ?? c["例句"];
    if (!entry.example && ex0) {
      entry.example = ex0;
      changed = true;
    }
    if (!entry.synonyms && c["近义词"]) {
      entry.synonyms = c["近义词"];
      changed = true;
    }
    if (changed) {
      await this.rewriteVocabEntry(entry);
      return true;
    }
    return false;
  }

  /**
   * Read 生词库.md, replace the block whose word matches `entry`, and write
   * back. Used after an AI enrichment fills in missing fields.
   */
  async rewriteVocabEntry(entry: VocabEntry): Promise<void> {
    const lang = this.settings.currentLanguage;
    const path = this.vocabPath(lang);
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const entries = parseVocab(await vault.read(file));
    const idx = entries.findIndex(
      (e) => e.word.toLowerCase() === entry.word.toLowerCase()
    );
    if (idx < 0) return;
    entries[idx] = entry;
    await vault.modify(file, serializeVocab(entries, lang));
  }

  /** Resolve an article's date from its filename or `日期:` frontmatter. */
  articleDate(file: TFile): string {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const raw = fm?.["日期"];
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return raw.slice(0, 10);
    }
    const m = file.basename.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  /** Display title for an article (frontmatter 篇目 → basename). */
  articleTitle(file: TFile): string {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const fmTitle = fm?.["篇目"];
    return typeof fmTitle === "string" && fmTitle.trim()
      ? fmTitle.trim()
      : file.basename;
  }

  /** Articles under 换母语/<lang>/阅读/ whose resolved date equals `iso`. */
  articlesForDate(iso: string): Article[] {
    const folder = this.app.vault.getAbstractFileByPath(this.readingFolder());
    if (!(folder instanceof TFolder)) return [];
    const out: Article[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      if (this.articleDate(child) !== iso) continue;
      out.push({
        file: child,
        title: this.articleTitle(child),
        date: iso,
      });
    }
    out.sort((a, b) => (a.file.basename < b.file.basename ? -1 : 1));
    return out;
  }

  /**
   * Materialize the current TOPIK band's bundled reading for one calendar day.
   * The article library is generated once during development and ships inside
   * main.js, so customers do not need Ollama, an API key, or Tina's server.
   */
  async ensureKoreanArticlesForDate(iso: string): Promise<void> {
    if (this.settings.currentLanguage !== "韩语") return;
    const level = this.settings.koreanLevel;
    const library: KoreanArticleTemplate[] = KOREAN_ARTICLES[level] ?? [];
    if (library.length === 0) return;

    const bandStart = dateFromISO(await this.ensureKoreanLevelStart(level));
    const dayIndex = Math.round(
      (dateFromISO(iso).getTime() - bandStart.getTime()) / DAY_MS
    );
    if (dayIndex < 0 || dayIndex >= PROGRAM_DAYS) return;

    const target = Math.max(1, this.settings.articlesPerDay);
    const folder = this.readingFolder("韩语");
    await this.ensureFolder(folder);
    const existing = this.articlesForDate(iso);
    if (existing.length >= target) return;

    for (let slot = existing.length; slot < target; slot++) {
      const article = library[(dayIndex * target + slot) % library.length];
      if (!article) continue;
      const safeTitle = article.title
        .replace(/[\\/:*?"<>|#\[\]\^]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48) || `TOPIK 阅读 ${slot + 1}`;
      const filename = `${iso}-${String(slot + 1).padStart(2, "0")}-${safeTitle}.md`;
      const path = normalizePath(`${folder}/${filename}`);
      if (await this.app.vault.adapter.exists(path)) continue;
      const content =
        `---\n` +
        `日期: ${JSON.stringify(iso)}\n` +
        `篇目: ${JSON.stringify(article.title)}\n` +
        `级别: ${JSON.stringify(level)}\n` +
        `来源: ${JSON.stringify("换母语原创分级阅读")}\n` +
        `---\n\n` +
        `# ${article.title}\n\n` +
        `${article.korean}\n\n` +
        `---\n\n` +
        `## 中文对照\n\n` +
        `${article.chinese}\n`;
      await this.app.vault.create(path, content).catch((error) => {
        console.warn("Native: failed to create bundled Korean article", path, error);
      });
    }
  }

  async storeWord(editor: Editor, file: TFile | null): Promise<void> {
    const sel = editor.getSelection();
    // Best-effort example: the editor line the cursor sits on.
    let example = "";
    try {
      const cursor = editor.getCursor("from");
      const lineText = editor.getLine(cursor.line);
      example = sentenceAround(lineText, sel);
    } catch (_e) {
      example = "";
    }
    await this.appendWord(sel, file?.basename ?? "?", example);
  }
}

/* ============================================================
 *  Vocab data model + parser/serializer (shared)
 * ========================================================== */

/** A parsed vocab entry from 生词库.md. */
interface VocabEntry {
  word: string;
  /** IPA phonetics (no slashes), e.g. "həˈloʊ"; "" if unknown. */
  ipa: string;
  translation: string;
  example: string;
  synonyms: string;
  /** 来源 string, e.g. "The Fox and the Grapes · 2026-06-29". */
  source: string;
  /** Best-effort date (YYYY-MM-DD), parsed from 来源 or the old format. */
  date: string;
  /** Date the word was added (YYYY-MM-DD). */
  learnedDate: string;
  /** Ebbinghaus stage index; -1 means 已掌握 (graduated). */
  stage: number;
  /** Next review date (YYYY-MM-DD); "" once 已掌握. */
  nextReview: string;
}

/** Ebbinghaus interval schedule, in days, indexed by stage. */
const REVIEW_INTERVALS: readonly number[] = [1, 2, 4, 7, 15, 30];

/** Stage value marking a graduated (已掌握) word. */
const STAGE_MASTERED = -1;

/** Add `days` to an ISO date, returning a new ISO date. */
function addDaysISO(iso: string, days: number): string {
  const d = dateFromISO(iso);
  d.setTime(d.getTime() + days * DAY_MS);
  return isoFromDate(d);
}

/**
 * Compute scheduling for a freshly-added word: learned today, stage 0,
 * next review tomorrow.
 */
function freshSchedule(): Pick<
  VocabEntry,
  "learnedDate" | "stage" | "nextReview"
> {
  const today = todayISO();
  return {
    learnedDate: today,
    stage: 0,
    nextReview: addDaysISO(today, REVIEW_INTERVALS[0]),
  };
}

/** True if the entry is due for review on or before `todayStr`. */
function isDue(e: VocabEntry, todayStr: string): boolean {
  return e.stage !== STAGE_MASTERED && !!e.nextReview && e.nextReview <= todayStr;
}

/**
 * Advance an entry after a 记住了 result: bump stage, schedule the next
 * review; graduate to 已掌握 once past the last interval. Mutates `e`.
 */
function reviewRemembered(e: VocabEntry): void {
  const nextStage = e.stage + 1;
  if (nextStage >= REVIEW_INTERVALS.length) {
    e.stage = STAGE_MASTERED;
    e.nextReview = "";
    return;
  }
  e.stage = nextStage;
  e.nextReview = addDaysISO(todayISO(), REVIEW_INTERVALS[nextStage]);
}

/** Reset an entry after a 没记住 result: back to stage 0, review tomorrow. */
function reviewForgot(e: VocabEntry): void {
  e.stage = 0;
  e.nextReview = addDaysISO(todayISO(), REVIEW_INTERVALS[0]);
}

/** Pull the first YYYY-MM-DD found in a string, or "". */
function extractDate(s: string): string {
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

/**
 * Parse 生词库.md into structured entries. Understands BOTH:
 *   1. New block format:
 *        ## word
 *        - 翻译: ...
 *        - 造句: ...
 *        - 近义词: ...
 *        - 来源: ...
 *   2. Old simple-line format:
 *        - word  —  来源:src · date
 *      (translation/example/synonyms left empty).
 */
function parseVocab(md: string): VocabEntry[] {
  const out: VocabEntry[] = [];
  const lines = md.split("\n");
  let cur: VocabEntry | null = null;

  const newEntry = (word: string): VocabEntry => ({
    word,
    ipa: "",
    translation: "",
    example: "",
    synonyms: "",
    source: "",
    date: "",
    learnedDate: "",
    stage: 0,
    nextReview: "",
  });

  const flush = (): void => {
    if (cur) out.push(backfillSchedule(cur));
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^##\s+(.*\S)\s*$/);
    if (heading) {
      flush();
      cur = newEntry(heading[1].trim());
      continue;
    }

    if (cur) {
      const field = line.match(
        /^\s*-\s*(音标|翻译|造句|近义词|来源|学于|阶段|下次复习)\s*[:：]\s*(.*)$/
      );
      if (field) {
        const val = field[2].trim();
        if (field[1] === "音标") cur.ipa = val.replace(/^\//, "").replace(/\/$/, "").trim();
        else if (field[1] === "翻译") cur.translation = val;
        else if (field[1] === "造句") cur.example = val;
        else if (field[1] === "近义词") cur.synonyms = val;
        else if (field[1] === "来源") {
          cur.source = val;
          cur.date = extractDate(val);
        } else if (field[1] === "学于") cur.learnedDate = extractDate(val);
        else if (field[1] === "阶段") {
          cur.stage = val === "已掌握" ? STAGE_MASTERED : parseStage(val);
        } else if (field[1] === "下次复习") cur.nextReview = extractDate(val);
        continue;
      }
      // Any other line inside a block is ignored (blank lines, prose).
      continue;
    }

    // Not inside a block → try the OLD simple-line format.
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2);
      const sepIdx = rest.indexOf("  —  ");
      let word = rest;
      let meta = "";
      if (sepIdx >= 0) {
        word = rest.slice(0, sepIdx).trim();
        meta = rest.slice(sepIdx + 5).trim();
      }
      // meta looks like "来源:src · date" → strip the 来源: prefix.
      const source = meta.replace(/^来源\s*[:：]\s*/, "").trim();
      const e = newEntry(word.trim());
      e.source = source;
      e.date = extractDate(meta);
      out.push(backfillSchedule(e));
    }
  }
  flush();
  return out;
}

/** Parse a stage integer, clamped to valid bounds; non-numbers → 0. */
function parseStage(val: string): number {
  const n = parseInt(val, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, REVIEW_INTERVALS.length - 1);
}

/**
 * Fill in scheduling defaults for blocks missing them (backward compat):
 * learnedDate = its 来源 date || today, stage = 0, nextReview = today.
 * Leaves already-scheduled entries untouched.
 */
function backfillSchedule(e: VocabEntry): VocabEntry {
  if (!e.learnedDate) e.learnedDate = e.date || todayISO();
  if (e.stage !== STAGE_MASTERED && !e.nextReview) {
    e.nextReview = todayISO();
  }
  return e;
}

/** Serialize entries back to the block format, with a file heading. */
function serializeVocab(entries: VocabEntry[], lang: string): string {
  const head = `# ${lang} · 生词库\n`;
  const blocks = entries
    .map(
      (e) =>
        `## ${e.word}\n` +
        `- 音标: ${e.ipa}\n` +
        `- 翻译: ${e.translation}\n` +
        `- 造句: ${e.example}\n` +
        `- 近义词: ${e.synonyms}\n` +
        `- 来源: ${e.source}\n` +
        `- 学于: ${e.learnedDate}\n` +
        `- 阶段: ${e.stage === STAGE_MASTERED ? "已掌握" : e.stage}\n` +
        `- 下次复习: ${e.stage === STAGE_MASTERED ? "已掌握" : e.nextReview}\n`
    )
    .join("\n");
  return entries.length ? `${head}\n${blocks}` : head;
}

/**
 * Given a block of text and a selection inside it, return the sentence that
 * contains the selection — split on .!?。！？ boundaries, take the segment
 * holding the first occurrence of the selection, trimmed. Falls back to the
 * whole text (trimmed) if the selection is not found.
 */
/**
 * Remove IPA ruby-text from a selection string. When a <ruby> is selected,
 * Selection.toString() interleaves the word with its /ipa/ <rt> text. The IPA
 * we emit is always wrapped in slashes (`/.../`), so stripping `/.../ ` tokens
 * and collapsing whitespace yields the clean underlying word(s).
 */
function stripIPA(text: string): string {
  return text.replace(/\/[^/\n]*\//g, " ").replace(/\s+/g, " ").trim();
}

function sentenceAround(text: string, selection: string): string {
  const sel = selection.trim();
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (!sel) return flat;

  const idx = flat.indexOf(sel);
  if (idx < 0) return flat;

  // Find sentence boundaries around idx.
  const boundary = /[.!?。！？]/;
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (boundary.test(flat[i])) {
      start = i + 1;
      break;
    }
  }
  let end = flat.length;
  for (let i = idx + sel.length; i < flat.length; i++) {
    if (boundary.test(flat[i])) {
      end = i + 1; // include the terminating punctuation
      break;
    }
  }
  return flat.slice(start, end).trim();
}

/* ============================================================
 *  Placement test (分级测试)
 * ========================================================== */

/** One placement-test question: a word tagged with the level it came from. */
interface PlacementQuestion {
  word: string;
  level: string;
}

/** Per-question self-assessment result. */
interface PlacementAnswer {
  level: string;
  known: boolean;
}

/** How many words to sample per level. */
const PLACEMENT_PER_LEVEL = 5;
/** Skip the easiest words of each list before sampling. */
const PLACEMENT_SKIP_HEAD = 10;
/** A level is "passed" when the user knows at least this fraction. */
const PLACEMENT_PASS_RATE = 0.6;

/**
 * Take up to `count` evenly-spaced samples from `list` after skipping the
 * first `skipHead` entries. Returns fewer when the list is short.
 */
function evenSamples(
  list: string[],
  skipHead: number,
  count: number
): string[] {
  const pool = list.slice(Math.min(skipHead, list.length));
  if (pool.length === 0) return [];
  const n = Math.min(count, pool.length);
  const out: string[] = [];
  // Evenly-spaced indices across the pool (avoids clustering at the start).
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(((i + 0.5) * pool.length) / n);
    out.push(pool[Math.min(idx, pool.length - 1)]);
  }
  return out;
}

/**
 * Build the placement question set: ~PLACEMENT_PER_LEVEL words per level,
 * easy→hard, sampled past the easiest head of each bundled wordlist.
 */
async function buildPlacementQuestions(
  plugin: NativePlugin
): Promise<PlacementQuestion[]> {
  const out: PlacementQuestion[] = [];
  for (const level of LEVELS) {
    const list = await plugin.loadWordlist(level);
    for (const word of evenSamples(list, PLACEMENT_SKIP_HEAD, PLACEMENT_PER_LEVEL)) {
      out.push({ word, level });
    }
  }
  return out;
}

/** Recommendation produced from a finished placement run. */
interface PlacementResult {
  /** Recommended starting level (one of LEVELS). */
  level: string;
  /** One-line rationale shown under the headline. */
  rationale: string;
}

/**
 * Score answers and recommend a starting level. Walk levels easy→hard; the
 * recommendation is the FIRST level whose known-rate < PLACEMENT_PASS_RATE
 * (i.e. where the user starts failing). If every level passes, recommend the
 * hardest. If a level has no sampled words, treat it as passed (skip it).
 */
function recommendLevel(answers: PlacementAnswer[]): PlacementResult {
  const known: Record<string, number> = {};
  const total: Record<string, number> = {};
  for (const a of answers) {
    total[a.level] = (total[a.level] ?? 0) + 1;
    if (a.known) known[a.level] = (known[a.level] ?? 0) + 1;
  }

  let prevLevel: string | null = null;
  for (const level of LEVELS) {
    const t = total[level] ?? 0;
    if (t === 0) {
      prevLevel = level;
      continue;
    }
    const rate = (known[level] ?? 0) / t;
    if (rate < PLACEMENT_PASS_RATE) {
      const rationale = prevLevel
        ? `你认识大部分 ${prevLevel} 词，但 ${level} 开始变难`
        : `${level} 的词对你还偏难，从这里打基础`;
      return { level, rationale };
    }
    prevLevel = level;
  }

  // Knew most words all the way through → start at the hardest level.
  const hardest = LEVELS[LEVELS.length - 1];
  return {
    level: hardest,
    rationale: `各级别你都认识大部分，直接从 ${hardest} 开始`,
  };
}

/* ============================================================
 *  Calendar view
 * ========================================================== */

interface CellInfo {
  iso: string;
  /** Day number 1..100 within the program, or null for trailing real dates. */
  dayNum: number | null;
  /** Sub-label (date) for trailing cells. */
  subLabel: string | null;
}

/** Which dashboard section is showing. Held in memory, not persisted. */
type NativeTab = "calendar" | "vocab";

const TABS: readonly { id: NativeTab; label: string }[] = [
  { id: "calendar", label: "日历" },
  { id: "vocab", label: "生词库" },
];

/* ---- 日语振假名(furigana):内容里写 `{汉字|假名}`,渲染成汉字上方标假名 ---- */
const FURI_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;

/** 去掉振假名标注,只留底字(汉字),给朗读/存库用。 */
function stripFurigana(text: string): string {
  return text.replace(FURI_RE, "$1");
}

/** 把含 `{汉字|假名}` 的字符串转成带 ruby 的 DocumentFragment(没标注就是纯文本)。 */
function furiganaFrag(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  FURI_RE.lastIndex = 0;
  while ((m = FURI_RE.exec(text)) !== null) {
    if (m.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const ruby = document.createElement("ruby");
    ruby.className = "native-ruby";
    ruby.appendChild(document.createTextNode(m[1]));
    const rt = document.createElement("rt");
    rt.className = "native-furi";
    rt.textContent = m[2];
    ruby.appendChild(rt);
    frag.appendChild(ruby);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)));
  }
  return frag;
}

/** 就地把一个元素里所有文本节点的 `{汉字|假名}` 换成 ruby。 */
function annotateFurigana(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && FURI_RE.test(n.nodeValue)) targets.push(n as Text);
  }
  for (const t of targets) {
    t.parentNode?.replaceChild(furiganaFrag(t.nodeValue ?? ""), t);
  }
}

class NativeView extends ItemView {
  /** Active dashboard tab (in-memory). */
  private tab: NativeTab = "calendar";
  /** Container the active section renders into. */
  private sectionEl: HTMLElement | null = null;
  /** 当前正在查看的季号(回看往季用);null = 跟随当前季。 */
  private viewSeason: number | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: NativePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NATIVE;
  }

  getDisplayText(): string {
    return "Native · 换母语";
  }

  getIcon(): string {
    return "calendar";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Re-render the view from scratch (used after external settings changes). */
  refresh(): void {
    this.render();
  }

  async onClose(): Promise<void> {
    this.speech?.stop();
    this.sectionEl = null;
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("native-root");

    const active = this.plugin.license.isUnlocked();
    // 到期只读(A):曾经激活过(有 expiresAt)但现在过期 → 不锁死,进 App 只读 + 续费提示。
    // 从没激活过(全新/没填过有效密钥)→ 才显示锁屏让他填密钥。
    const wasActivated = this.plugin.settings.license.expiresAt != null;
    if (!active && !wasActivated) {
      this.renderLock(root);
      return;
    }
    // First run after unlock: place the user before showing the dashboard.
    if (active && !this.plugin.settings.placementDone) {
      void this.renderPlacement(root);
      return;
    }
    this.renderUnlocked(root);
  }

  /* ---- placement test (分级测试) ---- */

  /**
   * Render the placement test as the first screen. Samples words across all
   * levels (easy→hard), asks 认识 / 不认识 per word, then recommends a level.
   * Finishing or skipping sets placementDone and returns to the dashboard.
   */
  private async renderPlacement(root: HTMLElement): Promise<void> {
    root.empty();
    root.createEl("h1", { cls: "native-title", text: "分级测试" });
    root.createEl("p", {
      cls: "native-subtitle",
      text: "看几个词，凭感觉选认识 / 不认识，给你推荐起点级别。",
    });

    const stage = root.createDiv({ cls: "native-placement" });
    stage.createDiv({ cls: "native-placement-loading", text: "正在准备测试…" });

    const questions = await buildPlacementQuestions(this.plugin);
    stage.empty();

    if (questions.length === 0) {
      stage.createDiv({
        cls: "native-empty",
        text: "词表未就绪，先跳过，去设置里重测。",
      });
      const skip = stage.createEl("button", {
        cls: "native-btn native-btn-ghost native-placement-skip",
        text: "跳过",
      });
      skip.addEventListener("click", () => void this.finishPlacement(null));
      return;
    }

    const answers: PlacementAnswer[] = [];
    let idx = 0;

    const progress = stage.createDiv({ cls: "native-placement-progress" });
    const card = stage.createDiv({ cls: "native-placement-card" });
    const skipRow = stage.createDiv({ cls: "native-placement-skiprow" });
    const skipLink = skipRow.createEl("a", {
      cls: "native-placement-skiplink",
      text: "跳过测试",
      href: "#",
    });
    skipLink.addEventListener("click", (e) => {
      e.preventDefault();
      void this.finishPlacement(null);
    });

    const showResult = (): void => {
      const result = recommendLevel(answers);
      this.renderPlacementResult(stage, progress, card, skipRow, result);
    };

    const showQuestion = (): void => {
      if (idx >= questions.length) {
        showResult();
        return;
      }
      progress.setText(`${idx + 1} / ${questions.length}`);
      card.empty();

      const q = questions[idx];
      const wordRow = card.createDiv({ cls: "native-placement-wordrow" });
      wordRow.createSpan({ cls: "native-placement-word", text: q.word });
      const spk = wordRow.createSpan({ cls: "native-placement-spk" });
      setIcon(spk, "volume-2");
      spk.setAttr("aria-label", "朗读");
      spk.addEventListener("click", () => this.speakOnce(q.word));

      const readBtn = card.createEl("button", {
        cls: "native-btn native-btn-ghost native-placement-read",
        text: "读",
      });
      readBtn.addEventListener("click", () => this.speakOnce(q.word));

      const actions = card.createDiv({ cls: "native-placement-actions" });
      const answer = (known: boolean): void => {
        answers.push({ level: q.level, known });
        idx++;
        showQuestion();
      };
      const yes = actions.createEl("button", {
        cls: "native-btn",
        text: "认识",
      });
      yes.addEventListener("click", () => answer(true));
      const no = actions.createEl("button", {
        cls: "native-btn native-btn-ghost",
        text: "不认识",
      });
      no.addEventListener("click", () => answer(false));
    };

    showQuestion();
  }

  /** Render the placement result + start / skip actions. */
  private renderPlacementResult(
    stage: HTMLElement,
    progress: HTMLElement,
    card: HTMLElement,
    skipRow: HTMLElement,
    result: PlacementResult
  ): void {
    progress.remove();
    skipRow.remove();
    card.empty();
    card.addClass("native-placement-result");

    card.createDiv({
      cls: "native-placement-result-head",
      text: "建议你从",
    });
    card.createDiv({
      cls: "native-placement-result-level",
      text: `【${result.level}】`,
    });
    card.createDiv({ cls: "native-placement-result-sub", text: "开始" });
    card.createDiv({
      cls: "native-placement-result-why",
      text: result.rationale,
    });

    const actions = card.createDiv({ cls: "native-placement-actions" });
    const start = actions.createEl("button", {
      cls: "native-btn",
      text: "就从这里开始",
    });
    start.addEventListener("click", () => void this.finishPlacement(result.level));
    const skip = actions.createEl("a", {
      cls: "native-placement-skiplink",
      text: "跳过",
      href: "#",
    });
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      void this.finishPlacement(null);
    });
  }

  /**
   * Finish the placement test: optionally set the level, mark placementDone,
   * persist, and return to the dashboard.
   */
  private async finishPlacement(level: string | null): Promise<void> {
    if (level && LEVELS.includes(level)) {
      this.plugin.settings.level = level;
    }
    this.plugin.settings.placementDone = true;
    await this.plugin.saveSettings();
    this.render();
  }

  /* ---- lock screen ---- */
  private renderLock(root: HTMLElement): void {
    const box = root.createDiv({ cls: "native-lock" });
    const icon = box.createDiv({ cls: "native-lock-icon" });
    setIcon(icon, "lock");
    box.createEl("h2", { cls: "native-title", text: "Native · 换母语" });
    box.createEl("p", {
      cls: "native-lock-text",
      text: "输入授权码解锁（公众号购买 ¥49.9 / 100 天）",
    });

    const input = box.createEl("input", {
      cls: "native-input",
      attr: { type: "text", placeholder: "授权码" },
    });
    input.value = this.plugin.settings.licenseKey;

    const btn = box.createEl("button", { cls: "native-btn", text: "验证" });
    btn.addEventListener("click", async () => {
      this.plugin.settings.licenseKey = input.value.trim();
      await this.plugin.saveSettings();
      btn.setText("验证中…");
      btn.setAttr("disabled", "true");
      await this.plugin.license.validate();
      this.render();
    });
  }

  /* ---- unlocked ---- */
  private renderUnlocked(root: HTMLElement): void {
    // 到期只读横幅:进度/生词库还能看,续费才能学新内容、开新季。
    if (!this.plugin.license.isUnlocked()) {
      const banner = root.createDiv({ cls: "native-renew-banner" });
      banner.createSpan({
        text:
          "密钥已到期 —— 生词库、进度、旧内容仍可查看复习;续费可继续学新内容、开启新一季。",
      });
      banner.createSpan({
        cls: "native-renew-how",
        text: "续费:公众号发「换母语」购买 → 把新密钥填进设置里验证。",
      });
    }
    root.createEl("div", { cls: "native-eyebrow", text: "NATIVE · 换母语" });
    root.createEl("h1", { cls: "native-title", text: "Native · 换母语" });
    root.createEl("p", {
      cls: "native-subtitle",
      text: `每日 ${this.plugin.taskCount()} 项 · ${this.plugin.settings.totalDays} 天换声计划`,
    });

    this.renderLangRow(root);
    this.renderStats(root);
    this.renderTabBar(root);

    this.sectionEl = root.createDiv({ cls: "native-section" });
    this.renderSection();
  }

  /* ---- tab bar ---- */
  private renderTabBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "native-tabbar" });
    for (const t of TABS) {
      const btn = bar.createEl("button", { cls: "native-tab", text: t.label });
      if (t.id === this.tab) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        if (this.tab === t.id) return;
        this.tab = t.id;
        bar
          .querySelectorAll(".native-tab")
          .forEach((el) => el.removeClass("is-active"));
        btn.addClass("is-active");
        this.renderSection();
      });
    }
  }

  /** Render the section for the active tab into sectionEl. */
  private renderSection(): void {
    const host = this.sectionEl;
    if (!host) return;
    host.empty();
    if (this.tab === "calendar") {
      void this.renderCalendar(host);
    } else {
      void this.renderVocab(host);
    }
  }

  private renderLangRow(root: HTMLElement): void {
    const row = root.createDiv({ cls: "native-lang-row" });
    for (const lang of this.plugin.settings.languages) {
      const btn = row.createEl("button", { cls: "native-lang", text: lang });
      if (lang === this.plugin.settings.currentLanguage) {
        btn.addClass("is-active");
      }
      btn.addEventListener("click", async () => {
        this.plugin.settings.currentLanguage = lang;
        if (lang === "韩语") {
          await this.plugin.ensureKoreanLevelStart();
        } else {
          await this.plugin.saveSettings();
        }
        this.render();
      });
    }
    const add = row.createEl("button", {
      cls: "native-lang native-lang-add",
      text: "+",
    });
    add.addEventListener("click", () => {
      new AddLanguageModal(this.app, async (name) => {
        const clean = name.trim();
        if (!clean) return;
        if (!this.plugin.settings.languages.includes(clean)) {
          this.plugin.settings.languages.push(clean);
        }
        this.plugin.settings.currentLanguage = clean;
        await this.plugin.saveSettings();
        this.render();
      }).open();
    });

    if (this.plugin.settings.currentLanguage === "韩语") {
      const levels = root.createDiv({ cls: "native-lang-row native-topik-row" });
      levels.createSpan({ cls: "native-topik-label", text: "学习级别" });
      for (const level of KOREAN_LEVELS) {
        const btn = levels.createEl("button", { cls: "native-lang", text: level });
        if (level === this.plugin.settings.koreanLevel) btn.addClass("is-active");
        btn.addEventListener("click", async () => {
          if (level === this.plugin.settings.koreanLevel) return;
          this.plugin.settings.koreanLevel = level;
          await this.plugin.ensureKoreanLevelStart(level);
          this.render();
        });
      }
    }
  }

  private renderStats(root: HTMLElement): void {
    const lang = this.plugin.settings.currentLanguage;
    const langData = this.plugin.dayData(lang);

    let completedDays = 0;
    let totalItems = 0;
    for (const iso of Object.keys(langData)) {
      const flags = langData[iso];
      const c = flags.filter(Boolean).length;
      if (c > 0) completedDays++;
      totalItems += c;
    }

    const streak = this.computeStreak(langData);

    const wrap = root.createDiv({ cls: "native-stats" });
    this.statCell(wrap, String(completedDays), "完成天数");
    this.statCell(wrap, String(streak), "连续签");
    this.statCell(wrap, String(totalItems), "总完成项");
  }

  private statCell(parent: HTMLElement, num: string, label: string): void {
    const cell = parent.createDiv({ cls: "native-stat" });
    cell.createDiv({ cls: "native-stat-num", text: num });
    cell.createDiv({ cls: "native-stat-label", text: label });
  }

  /** Consecutive days (ending today or yesterday) with ≥1 task done. */
  private computeStreak(langData: Record<string, boolean[]>): number {
    let streak = 0;
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);

    // If today not done yet, allow the streak to anchor on yesterday.
    const todayFlags = langData[isoFromDate(cursor)];
    if (!todayFlags || todayFlags.filter(Boolean).length === 0) {
      cursor.setTime(cursor.getTime() - DAY_MS);
    }

    for (;;) {
      const iso = isoFromDate(cursor);
      const flags = langData[iso];
      if (flags && flags.filter(Boolean).length > 0) {
        streak++;
        cursor.setTime(cursor.getTime() - DAY_MS);
      } else {
        break;
      }
    }
    return streak;
  }

  private renderLegend(root: HTMLElement): void {
    const legend = root.createDiv({ cls: "native-legend" });
    for (const entry of LEGEND) {
      const item = legend.createDiv({ cls: "native-legend-item" });
      const sw = item.createSpan({ cls: "native-swatch" });
      sw.addClass(entry.cls);
      item.createSpan({ text: entry.label });
    }
  }

  /* ---- calendar ---- */
  private async renderCalendar(root: HTMLElement): Promise<void> {
    // Prime the vocab snapshot so per-cell dayProgress() runs synchronously.
    await this.plugin.primeVocab();
    const s = this.plugin.settings;
    const isKoreanTrack = s.currentLanguage === "韩语";
    const curSeason = isKoreanTrack ? 1 : Math.max(1, s.season);
    // 正在查看的季(默认=当前季);回看往季时 < 当前季。
    const viewSeason = Math.min(curSeason, Math.max(1, this.viewSeason ?? curSeason));
    const isCurrent = viewSeason === curSeason;
    const starts =
      s.seasonStarts?.length > 0 ? s.seasonStarts : [s.seasonStart || s.startDate];
    const seasonStart = isKoreanTrack
      ? dateFromISO(await this.plugin.ensureKoreanLevelStart())
      : dateFromISO(starts[viewSeason - 1] || s.seasonStart || s.startDate);

    // 第 X 季 标题 + 往季/当前季 切换(◀ ▶)
    const head = root.createDiv({ cls: "native-season-head" });
    const prev = head.createSpan({
      cls:
        "native-season-nav" +
        (!isKoreanTrack && viewSeason > 1 ? "" : " is-disabled"),
      text: "◀",
    });
    if (!isKoreanTrack && viewSeason > 1) {
      prev.setAttr("aria-label", "上一季");
      prev.addEventListener("click", () => {
        this.viewSeason = viewSeason - 1;
        this.render();
      });
    }
    head.createSpan({
      cls: "native-season-num",
      text: isKoreanTrack ? s.koreanLevel : `第 ${viewSeason} 季`,
    });
    const next = head.createSpan({
      cls:
        "native-season-nav" +
        (!isKoreanTrack && viewSeason < curSeason ? "" : " is-disabled"),
      text: "▶",
    });
    if (!isKoreanTrack && viewSeason < curSeason) {
      next.setAttr("aria-label", "下一季");
      next.addEventListener("click", () => {
        this.viewSeason = viewSeason + 1;
        this.render();
      });
    }
    head.createSpan({
      cls: "native-season-sub",
      text: isKoreanTrack
        ? "100 天 · 本级从第 1 批开始"
        : isCurrent
          ? "100 天 · 词接着上一季往下"
          : "往季回看 · 只读",
    });

    this.renderLegend(root);

    // 本季 100 天格子(从本季开始日 seasonStart 起),分 4 阶段。
    const cells: CellInfo[] = [];
    for (let i = 0; i < PROGRAM_DAYS; i++) {
      const d = new Date(seasonStart.getTime() + i * DAY_MS);
      cells.push({ iso: isoFromDate(d), dayNum: i + 1, subLabel: null });
    }
    for (const phase of PHASES) {
      this.renderPhaseHeader(root, phase);
      const slice = cells.filter(
        (c) => c.dayNum != null && c.dayNum >= phase.start && c.dayNum <= phase.end
      );
      this.renderGrid(root, slice);
    }

    // 里程碑 + 完成本季 → 开启下一季
    const ms = root.createDiv({ cls: "native-milestone" });
    ms.createSpan({
      cls: "native-milestone-text",
      text: isKoreanTrack
        ? `${s.koreanLevel} · 里程碑`
        : `第 ${viewSeason} 季 · 里程碑`,
    });
    const withinToday = Math.round(
      (dateFromISO(todayISO()).getTime() - seasonStart.getTime()) / DAY_MS
    );
    if (isKoreanTrack) {
      const dayNo = Math.min(PROGRAM_DAYS, Math.max(1, withinToday + 1));
      root.createDiv({
        cls: "native-milestone-sub",
        text:
          withinToday >= PROGRAM_DAYS - 1
            ? `${s.koreanLevel} 已完成 · 可以切换下一个 TOPIK 级别`
            : `${s.koreanLevel} 第 ${dayNo} / 100 天`,
      });
    } else if (!isCurrent) {
      // 回看往季:不给"开启下一季",提示已完成 + 怎么回当前季。
      root.createDiv({
        cls: "native-milestone-sub",
        text: `第 ${viewSeason} 季已完成 · 点 ▶ 回到第 ${curSeason} 季`,
      });
    } else if (withinToday >= PROGRAM_DAYS - 1) {
      this.renderSeasonComplete(root, curSeason);
    } else {
      // 未满季也常驻提示:让"满 100 天开启下一季"从第一天就看得见,不留死胡同。
      const dayNo = Math.min(PROGRAM_DAYS, Math.max(1, withinToday + 1));
      root.createDiv({
        cls: "native-milestone-sub",
        text: `第 ${dayNo} / 100 天 · 满 100 天可开启第 ${curSeason + 1} 季，词接着上一季往下学`,
      });
    }
  }

  /** 本季走到第 100 天 → 恭喜 + 开启下一季(需有效密钥;过期则提示续费)。 */
  private renderSeasonComplete(root: HTMLElement, season: number): void {
    const box = root.createDiv({ cls: "native-season-done" });
    box.createDiv({
      cls: "native-season-done-title",
      text: `🎉 第 ${season} 季完成!`,
    });
    const active = this.plugin.license.isUnlocked();
    box.createDiv({
      cls: "native-season-done-sub",
      text: active
        ? `开启第 ${season + 1} 季,接着往下学新的一批词。`
        : "续费后即可开启下一季、继续学新内容。",
    });
    const btn = box.createEl("button", {
      cls: "native-btn",
      text: active ? `开启第 ${season + 1} 季` : "续费后开启下一季",
    });
    btn.disabled = !active;
    btn.addEventListener("click", async () => {
      if (!this.plugin.license.isUnlocked()) {
        new Notice("密钥已到期,续费后可开启新一季");
        return;
      }
      const today = todayISO();
      this.plugin.settings.season = season + 1;
      this.plugin.settings.seasonStart = today;
      // 记录新一季开始日,历史里往季永远查得回。
      if (!Array.isArray(this.plugin.settings.seasonStarts)) {
        this.plugin.settings.seasonStarts = [];
      }
      this.plugin.settings.seasonStarts[season] = today;
      this.viewSeason = season + 1;
      await this.plugin.saveSettings();
      new Notice(`第 ${season + 1} 季开始!`);
      this.render();
    });
  }

  private renderPhaseHeader(root: HTMLElement, phase: Phase): void {
    const h = root.createDiv({ cls: "native-phase" });
    h.createSpan({ cls: "native-phase-num", text: phase.numeral + "." });
    h.createSpan({ cls: "native-phase-name", text: phase.name });
    h.createSpan({
      cls: "native-phase-range",
      text: `D${phase.start}–${phase.end}`,
    });
  }

  private renderGrid(root: HTMLElement, cells: CellInfo[]): void {
    const grid = root.createDiv({ cls: "native-grid" });
    const todayStr = todayISO();
    const lang = this.plugin.settings.currentLanguage;
    for (const info of cells) {
      // Heat = AVERAGE of the per-task progress ratios for the day.
      const progress = this.plugin.dayProgress(lang, info.iso);

      const cell = grid.createDiv({ cls: "native-cell" });
      this.applyHeatClass(cell, info.iso, progress, todayStr);
      this.applyBadge(cell, info.iso, progress); // 按进度贴书签角标(全勤=小猫)

      if (info.iso === todayStr) {
        cell.addClass("is-today");
      }

      cell.createSpan({
        text: info.dayNum != null ? String(info.dayNum) : (info.subLabel ?? ""),
      });
      if (info.dayNum != null && info.subLabel) {
        cell.createSpan({ cls: "native-cell-sub", text: info.subLabel });
      }

      cell.addEventListener("click", () => {
        new DayModal(this.app, this.plugin, info.iso, () => {
          // Live-update this cell + stats after a toggle/action. Re-prime the
          // vocab snapshot so learned/imported/due counts stay current.
          void this.plugin.primeVocab().then(() => {
            const p = this.plugin.dayProgress(lang, info.iso);
            this.clearHeatClass(cell);
            this.applyHeatClass(cell, info.iso, p, todayISO());
            this.applyBadge(cell, info.iso, p);
            this.refreshStats(root);
          });
        }).open();
      });
    }
  }

  /**
   * Map an average progress ratio (0..1) to a heat class. 0: past day →
   * 断签 (red), today/future → paper. Otherwise bucket the ratio onto the
   * existing 5-step yellow→green scale.
   */
  private heatClassFor(iso: string, ratio: number, todayStr: string): string {
    if (ratio <= 0) {
      // Past day with nothing → broken streak; today/future → blank paper.
      return iso < todayStr ? "native-broken" : "native-c0";
    }
    if (ratio >= 1) return "native-c6"; // 深森林绿
    if (ratio > 0.7) return "native-c5"; // 绿
    if (ratio > 0.4) return "native-c34"; // 黄绿
    if (ratio > 0.2) return "native-c2"; // 黄
    return "native-c1"; // 浅柠檬黄
  }

  private applyHeatClass(
    cell: HTMLElement,
    iso: string,
    ratio: number,
    todayStr: string
  ): void {
    cell.addClass(this.heatClassFor(iso, ratio, todayStr));
  }

  private clearHeatClass(cell: HTMLElement): void {
    cell.removeClasses([
      "native-c0",
      "native-broken",
      "native-c1",
      "native-c2",
      "native-c34",
      "native-c5",
      "native-c6",
    ]);
  }

  /** Bundled reward-cat image URL (resolved once from the plugin dir). */
  private catUrlCache: string | null = null;
  private catUrl(): string {
    if (this.catUrlCache != null) return this.catUrlCache;
    const dir = this.plugin.manifest.dir;
    this.catUrlCache = dir
      ? this.app.vault.adapter.getResourcePath(normalizePath(`${dir}/cat.png`))
      : "";
    return this.catUrlCache;
  }

  /**
   * 按当天完成进度给格子加"书签角标":全勤(ratio≥1)贴奖励小猫(会摇);
   * 其余进度档贴一个鼓励小字(冲/赞/棒/强);没进度的不贴。
   */
  private applyBadge(cell: HTMLElement, iso: string, ratio: number): void {
    cell.querySelector(".native-cat-badge")?.remove();
    cell.querySelector(".native-cell-badge")?.remove();
    if (ratio >= 1) {
      const url = this.catUrl();
      if (!url) return;
      const img = cell.createEl("img", { cls: "native-cat-badge" });
      img.src = url;
      img.alt = "满分";
      return;
    }
    // 鼓励小字 — 阈值与 heatClassFor 一致
    let txt = "";
    if (ratio > 0.7) txt = "强"; // 接近
    else if (ratio > 0.4) txt = "棒"; // 过半
    else if (ratio > 0.2) txt = "赞"; // 在状态
    else if (ratio > 0) txt = "冲"; // 起步
    if (!txt) return;
    const b = cell.createSpan({ cls: "native-cell-badge", text: txt });
    b.setAttr("aria-hidden", "true");
  }

  private refreshStats(_root: HTMLElement): void {
    const old = this.contentEl.querySelector(".native-stats");
    if (!old) return;
    const fresh = createDiv();
    this.renderStats(fresh);
    const newStats = fresh.querySelector(".native-stats");
    if (newStats) {
      old.replaceWith(newStats);
    }
  }

  /* ============================================================
   *  Tab 2 — 生词库
   * ========================================================== */

  /** Read + parse the current language's 生词库.md into entries. */
  private async loadVocab(): Promise<VocabEntry[]> {
    const path = this.plugin.vocabPath();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return parseVocab(await this.app.vault.cachedRead(file));
    }
    return [];
  }

  private async renderVocab(host: HTMLElement): Promise<void> {
    const entries = await this.loadVocab();

    const head = host.createDiv({ cls: "native-sec-head" });
    head.createEl("h2", { cls: "native-sec-title", text: "生词库" });
    head.createSpan({
      cls: "native-sec-count",
      text: `${entries.length} 词`,
    });

    if (entries.length === 0) {
      host.createDiv({
        cls: "native-empty",
        text: "还没有生词。读文章时选中词「＋存入生词库」。",
      });
      return;
    }

    const today = todayISO();
    const due = entries.filter((e) => isDue(e, today));

    // ---- top banner: 今日待复习 N 个 + 开始复习 ----
    const banner = host.createDiv({ cls: "native-review-banner" });
    banner.createSpan({
      cls: "native-review-count",
      text: `今日待复习 ${due.length} 个`,
    });
    if (due.length > 0) {
      const startBtn = banner.createEl("button", {
        cls: "native-btn",
        text: "开始复习",
      });
      startBtn.addEventListener("click", () => this.startReview(due));
    }
    // 默写 (dictation): test the due set; fall back to all words when none due.
    const dictBtn = banner.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "默写",
    });
    const dictWords = due.length > 0 ? due : entries;
    const dictAll = due.length === 0;
    dictBtn.addEventListener("click", () =>
      this.startDictation(dictWords, dictAll)
    );

    // ---- 全部补全 ----
    const actions = host.createDiv({ cls: "native-vocab-actions" });
    const enrichAllBtn = actions.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "全部补全",
    });
    enrichAllBtn.addEventListener("click", () =>
      void this.enrichAll(entries, enrichAllBtn)
    );

    // ---- search box: filter cards by word OR 翻译 (case-insensitive) ----
    const searchBar = host.createDiv({ cls: "native-vocab-search" });
    const searchInput = searchBar.createEl("input", {
      cls: "native-input native-vocab-search-input",
      type: "search",
      attr: { placeholder: "搜索单词…" },
    });
    const searchCount = searchBar.createSpan({ cls: "native-vocab-search-count" });

    // ---- full list, due-first ----
    const sorted = [...entries].sort((a, b) => {
      const ad = isDue(a, today) ? 0 : 1;
      const bd = isDue(b, today) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return (a.nextReview || "9999") < (b.nextReview || "9999") ? -1 : 1;
    });
    const listEl = host.createDiv({ cls: "native-vocab-list" });
    // Build cards once; keep a (card, haystack) index so search just toggles
    // visibility — the review banner and cards stay intact.
    const cards: { el: HTMLElement; hay: string }[] = [];
    for (const e of sorted) {
      const card = this.renderVocabCard(listEl, e, today);
      cards.push({
        el: card,
        hay: `${e.word}\n${e.translation}`.toLowerCase(),
      });
    }

    const applyFilter = (raw: string): void => {
      const q = raw.trim().toLowerCase();
      let shown = 0;
      for (const c of cards) {
        const match = q === "" || c.hay.includes(q);
        c.el.toggle(match);
        if (match) shown++;
      }
      searchCount.setText(
        q === "" ? `${cards.length} 词` : `${shown} / ${cards.length} 词`
      );
    };
    applyFilter("");

    // Light debounce so typing stays smooth on large lists.
    let debounce = 0;
    searchInput.addEventListener("input", () => {
      window.clearTimeout(debounce);
      const val = searchInput.value;
      debounce = window.setTimeout(() => applyFilter(val), 120);
    });
  }

  /**
   * Run the spaced-repetition review flow over `due` words, one at a time,
   * inside a dedicated card host that replaces the section content.
   */
  private startReview(due: VocabEntry[]): void {
    const host = this.sectionEl;
    if (!host) return;
    host.empty();

    const head = host.createDiv({ cls: "native-sec-head" });
    head.createEl("h2", { cls: "native-sec-title", text: "复习" });
    const back = head.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "返回",
    });
    back.addEventListener("click", () => this.renderSection());

    const stage = host.createDiv({ cls: "native-review-stage" });
    const queue = [...due];

    const showNext = (): void => {
      stage.empty();
      const e = queue.shift();
      if (!e) {
        stage.createDiv({ cls: "native-review-done", text: "今天复习完了" });
        return;
      }
      stage.createDiv({ cls: "native-review-word", text: e.word });

      const answer = stage.createDiv({ cls: "native-review-answer is-hidden" });
      if (e.ipa) {
        answer.createDiv({ cls: "native-review-ipa", text: `/${e.ipa}/` });
      }
      this.fillReviewAnswer(answer, e);

      const reveal = stage.createEl("button", {
        cls: "native-btn native-btn-ghost native-review-reveal",
        text: "显示",
      });
      const grade = stage.createDiv({
        cls: "native-review-grade is-hidden",
      });
      reveal.addEventListener("click", () => {
        answer.removeClass("is-hidden");
        reveal.hide();
        grade.removeClass("is-hidden");
      });

      const remembered = grade.createEl("button", {
        cls: "native-btn",
        text: "记住了",
      });
      const forgot = grade.createEl("button", {
        cls: "native-btn native-btn-ghost",
        text: "没记住",
      });
      const grade_ = async (ok: boolean): Promise<void> => {
        remembered.disabled = true;
        forgot.disabled = true;
        if (ok) reviewRemembered(e);
        else reviewForgot(e);
        await this.plugin.rewriteVocabEntry(e);
        showNext();
      };
      remembered.addEventListener("click", () => void grade_(true));
      forgot.addEventListener("click", () => void grade_(false));
    };
    showNext();
  }

  /** Lazily-built speech controller for the 默写 读 button. */
  private speech: SpeechController | null = null;

  /** Speak one word/sentence once via the view's speech controller. */
  private speakOnce(text: string): void {
    if (!this.speech) {
      this.speech = new SpeechController(
        () => this.plugin.settings.speechRate,
        () => undefined,
        () => undefined,
        () => this.plugin.settings.voiceName,
        () => this.plugin.ttsUrlBuilder()
      );
    }
    void this.speech.speakOnce(text, this.plugin.settings.currentLanguage);
  }

  /**
   * Mask every case-insensitive occurrence of `word` in `example` with "____"
   * so the dictation prompt does not give the answer away. Returns "" when the
   * example is empty.
   */
  private maskWord(example: string, word: string): string {
    const ex = example.trim();
    if (!ex || !word.trim()) return ex;
    const esc = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return ex.replace(new RegExp(esc, "gi"), "____");
  }

  /**
   * Run the 默写 (dictation / typing) flow over `words`, one at a time. The
   * English word is hidden; the user reads 翻译 (+ masked 例句 + 音标) and types
   * the word. 提交 grades case-insensitively + trimmed, reuses
   * reviewRemembered / reviewForgot, persists, then advances. A summary closes
   * the run.
   *
   * @param words   the entries to test (due set, or all when nothing is due)
   * @param overAll true when falling back to the whole list (shows a note)
   */
  private startDictation(words: VocabEntry[], overAll: boolean): void {
    const host = this.sectionEl;
    if (!host || words.length === 0) return;
    host.empty();

    const head = host.createDiv({ cls: "native-sec-head" });
    head.createEl("h2", { cls: "native-sec-title", text: "默写" });
    const back = head.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "返回",
    });
    back.addEventListener("click", () => this.renderSection());

    if (overAll) {
      host.createDiv({
        cls: "native-dict-note",
        text: "今天没有待复习的词，默写全部生词。",
      });
    }

    const stage = host.createDiv({ cls: "native-review-stage" });
    const queue = [...words];
    const total = queue.length;
    let correct = 0;
    let done = 0;

    const showNext = (): void => {
      stage.empty();
      const e = queue.shift();
      if (!e) {
        stage.createDiv({
          cls: "native-review-done",
          text: `默写完成：对 ${correct} / 共 ${total}`,
        });
        const exit = stage.createEl("button", {
          cls: "native-btn native-dict-exit",
          text: "返回生词库",
        });
        exit.addEventListener("click", () => this.renderSection());
        return;
      }
      done++;

      stage.createDiv({
        cls: "native-dict-progress",
        text: `${done} / ${total}`,
      });

      // Prompt: 翻译 (+ 音标 + masked 例句) — never the English word itself.
      const prompt = stage.createDiv({ cls: "native-dict-prompt" });
      if (e.translation) {
        prompt.createDiv({ cls: "native-dict-translation", text: e.translation });
      } else {
        prompt.createDiv({
          cls: "native-dict-translation native-dict-muted",
          text: "（无翻译，凭例句默写）",
        });
      }
      if (e.ipa) {
        prompt.createDiv({ cls: "native-dict-ipa", text: `/${e.ipa}/` });
      }
      const masked = this.maskWord(e.example, e.word);
      if (masked) {
        prompt.createDiv({ cls: "native-dict-example native-italic", text: masked });
      }

      const input = stage.createEl("input", {
        cls: "native-input native-dict-input",
        type: "text",
        attr: { placeholder: "输入英文单词…", autocapitalize: "off", spellcheck: "false" },
      });

      const submitRow = stage.createDiv({ cls: "native-dict-submit-row" });
      const submitBtn = submitRow.createEl("button", {
        cls: "native-btn",
        text: "提交",
      });

      const reveal = stage.createDiv({ cls: "native-dict-reveal is-hidden" });

      let graded = false;
      const grade = async (): Promise<void> => {
        if (graded) return;
        graded = true;
        const typed = input.value.trim();
        const ok = typed.toLowerCase() === e.word.trim().toLowerCase();
        input.disabled = true;
        submitBtn.disabled = true;
        if (ok) {
          correct++;
          reviewRemembered(e);
        } else {
          reviewForgot(e);
        }

        reveal.removeClass("is-hidden");
        reveal.createDiv({
          cls: ok ? "native-dict-result is-correct" : "native-dict-result is-wrong",
          text: ok ? "正确" : "再看一眼",
        });
        const ansRow = reveal.createDiv({ cls: "native-dict-answer-row" });
        ansRow.createSpan({ cls: "native-dict-answer", text: e.word });
        const speakBtn = ansRow.createEl("button", {
          cls: "native-btn native-btn-ghost native-dict-read",
          text: "读",
        });
        speakBtn.addEventListener("click", () => this.speakOnce(e.word));

        const nextBtn = reveal.createEl("button", {
          cls: "native-btn native-dict-next",
          text: "下一个",
        });
        nextBtn.addEventListener("click", () => showNext());
        nextBtn.focus();

        await this.plugin.rewriteVocabEntry(e);
        await this.plugin.primeVocab();
      };

      submitBtn.addEventListener("click", () => void grade());
      input.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          void grade();
        }
      });
      input.focus();
    };
    showNext();
  }

  /** Render the reveal body of a review card: 翻译 + 造句 + 近义词. */
  private fillReviewAnswer(host: HTMLElement, e: VocabEntry): void {
    const row = (label: string, value: string, italic = false): void => {
      if (!value) return;
      const r = host.createDiv({ cls: "native-quiz-row" });
      r.createSpan({ cls: "native-quiz-k", text: label });
      const v = r.createSpan({ cls: "native-quiz-v", text: value });
      if (italic) v.addClass("native-italic");
    };
    row("翻译", e.translation);
    row("造句", e.example, true);
    row("近义词", e.synonyms);
    if (!e.translation && !e.example && !e.synonyms) {
      host.createDiv({ cls: "native-quiz-v", text: e.source || "（待补全）" });
    }
  }

  /** Format a word's schedule status line. */
  private scheduleLine(e: VocabEntry): string {
    if (e.stage === STAGE_MASTERED) return "已掌握";
    return `阶段 ${e.stage} · 下次复习 ${e.nextReview || "—"}`;
  }

  /**
   * Render one vocab card with all fields; 待补 chips get an AI 补全 button.
   * Returns the card element so callers (e.g. search) can toggle its visibility.
   */
  private renderVocabCard(
    list: HTMLElement,
    e: VocabEntry,
    today: string
  ): HTMLElement {
    const card = list.createDiv({ cls: "native-vocab-card" });
    if (isDue(e, today)) card.addClass("is-due");

    const headRow = card.createDiv({ cls: "native-vocab-head" });
    headRow.createSpan({ cls: "native-vocab-word", text: e.word });
    if (e.ipa) {
      headRow.createSpan({ cls: "native-vocab-ipa", text: `/${e.ipa}/` });
    }

    const needsEnrich = !e.translation || !e.synonyms;
    if (needsEnrich) {
      const btn = headRow.createEl("button", {
        cls: "native-btn native-btn-ghost native-vocab-enrich",
        text: "AI 补全",
      });
      btn.addEventListener("click", () => void this.enrichOne(e, btn, list));
    }

    const field = (label: string, value: string, italic = false): void => {
      const f = card.createDiv({ cls: "native-vocab-field" });
      f.createSpan({ cls: "native-vocab-k", text: label });
      if (value) {
        const v = f.createSpan({ cls: "native-vocab-v", text: value });
        if (italic) v.addClass("native-italic");
      } else {
        f.createSpan({ cls: "native-vocab-todo", text: "待补" });
      }
    };
    field("翻译", e.translation);
    field("造句", e.example, true);
    field("近义词", e.synonyms);
    field("来源", e.source);

    card.createDiv({
      cls: "native-vocab-sched",
      text: this.scheduleLine(e),
    });
    return card;
  }

  /** Enrich one entry, then re-render the vocab tab to reflect the change. */
  private async enrichOne(
    e: VocabEntry,
    btn: HTMLButtonElement,
    _list: HTMLElement
  ): Promise<void> {
    btn.setText("补全中…");
    btn.disabled = true;
    const ok = await this.plugin.enrichWord(e);
    if (ok) {
      this.renderSection();
    } else {
      btn.setText("AI 补全");
      btn.disabled = false;
    }
  }

  /** Enrich every entry missing 翻译/近义词, sequentially. */
  private async enrichAll(
    entries: VocabEntry[],
    btn: HTMLButtonElement
  ): Promise<void> {
    btn.setText("补全中…");
    btn.disabled = true;
    let any = false;
    for (const e of entries) {
      if (e.translation && e.synonyms) continue;
      const ok = await this.plugin.enrichWord(e);
      if (ok) any = true;
      else break; // server unavailable → stop (Notice already shown)
    }
    if (any) this.renderSection();
    else {
      btn.setText("全部补全");
      btn.disabled = false;
    }
  }
}

/* ============================================================
 *  Modals
 * ========================================================== */

class AddLanguageModal extends Modal {
  constructor(app: App, private onSubmit: (name: string) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "新增语言" });
    const input = contentEl.createEl("input", {
      cls: "native-input",
      attr: { type: "text", placeholder: "如：西班牙语" },
    });
    input.focus();

    const submit = () => {
      const v = input.value;
      this.close();
      this.onSubmit(v);
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") submit();
    });

    const btn = contentEl.createEl("button", {
      cls: "native-btn native-btn-spaced",
      text: "添加",
    });
    btn.addEventListener("click", submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Import a pasted article into 换母语/<lang>/阅读/ named by a target date. */
class ImportArticleModal extends Modal {
  /** Date the imported article is filed under (defaults to today). */
  private targetDate: string;

  constructor(
    app: App,
    private plugin: NativePlugin,
    private onDone: (file: TFile | null) => void | Promise<void>,
    targetDate?: string
  ) {
    super(app);
    this.targetDate = targetDate ?? todayISO();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "导入文章" });

    const titleInput = contentEl.createEl("input", {
      cls: "native-input",
      attr: { type: "text", placeholder: "标题（可留空，默认用日期）" },
    });
    titleInput.focus();

    const bodyInput = contentEl.createEl("textarea", {
      cls: "native-input native-import-body",
      attr: { placeholder: "粘贴文章正文（Markdown）" },
    });

    const btn = contentEl.createEl("button", {
      cls: "native-btn native-btn-spaced",
      text: "保存",
    });
    btn.addEventListener("click", () => void this.save(titleInput, bodyInput));
  }

  private async save(
    titleInput: HTMLInputElement,
    bodyInput: HTMLTextAreaElement
  ): Promise<void> {
    const body = bodyInput.value.trim();
    if (!body) {
      new Notice("正文不能为空");
      return;
    }
    const lang = this.plugin.settings.currentLanguage;
    const date = this.targetDate;
    const title = titleInput.value.trim() || date;

    const folder = this.plugin.readingFolder(lang);
    await this.plugin.ensureFolder(folder);

    // Find a free filename for today: <date>.md, <date>-2.md, …
    const vault = this.app.vault;
    let path = normalizePath(`${folder}/${date}.md`);
    let n = 2;
    while (await vault.adapter.exists(path)) {
      path = normalizePath(`${folder}/${date}-${n}.md`);
      n++;
    }

    const fm =
      `---\n` +
      `语言: ${lang}\n` +
      `日期: ${date}\n` +
      `级别: ${lang === "英语" || lang === "韩语" ? this.plugin.levelKey() : ""}\n` +
      `篇目: ${title}\n` +
      `---\n\n`;
    const file = await vault.create(path, fm + body + "\n");

    new Notice("已导入文章");
    this.close();
    await this.onDone(file);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Import pasted words (one per line) into the current language's 生词库. */
class ImportWordsModal extends Modal {
  constructor(
    app: App,
    private plugin: NativePlugin,
    private onDone: (added: number) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "导入单词" });
    contentEl.createEl("p", {
      cls: "native-import-hint",
      text: "每行一个单词或短语，存入当前语言的生词库。",
    });

    const bodyInput = contentEl.createEl("textarea", {
      cls: "native-input native-import-body",
      attr: { placeholder: "apple\nbanana\nin spite of\n…" },
    });
    bodyInput.focus();

    const btn = contentEl.createEl("button", {
      cls: "native-btn native-btn-spaced",
      text: "导入",
    });
    btn.addEventListener("click", () => void this.save(bodyInput, btn));
  }

  private async save(
    bodyInput: HTMLTextAreaElement,
    btn: HTMLButtonElement
  ): Promise<void> {
    const words = bodyInput.value
      .split("\n")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    if (words.length === 0) {
      new Notice("没有可导入的单词");
      return;
    }
    btn.disabled = true;
    btn.setText("导入中…");
    let added = 0;
    for (const w of words) {
      if (await this.plugin.appendWord(w, "自己导入")) added++;
    }
    new Notice(`已导入 ${added} 个单词`);
    this.close();
    await this.onDone(added);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DayModal extends Modal {
  /** Floating 划词存库 button for the in-modal reading area. */
  private floatBtn: HTMLElement | null = null;
  /** The currently-open article's file (for re-render on IPA toggle). */
  private currentFile: TFile | null = null;
  /** TTS controller for the inline reader (one per modal). */
  private speech: SpeechController | null = null;
  /** Sentence spans of the currently-rendered article body, by index. */
  private sentSpans: HTMLElement[] = [];
  /** Article paths already counted toward today's 读 metric (de-dupe). */
  private readArticles = new Set<string>();

  constructor(
    app: App,
    private plugin: NativePlugin,
    private iso: string,
    private onChange: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("native-day-modal");
    contentEl.addClass("native-root");
    const lang = this.plugin.settings.currentLanguage;
    const tasks = this.plugin.settings.tasks;
    const flags = this.plugin.getDay(lang, this.iso).slice();

    contentEl.createEl("div", { cls: "native-modal-date", text: this.iso });
    contentEl.createEl("div", {
      cls: "native-modal-meta",
      text: `${lang} · 今日 ${tasks.length} 项`,
    });

    const setFlag = async (idx: number, next: boolean): Promise<void> => {
      flags[idx] = next;
      await this.plugin.setDay(lang, this.iso, flags.slice());
      this.onChange();
    };

    const list = contentEl.createDiv({ cls: "native-tasklist" });
    tasks.forEach((label, idx) => {
      const taskEl = list.createDiv({ cls: "native-task" });
      const cb = taskEl.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = flags[idx];
      if (flags[idx]) taskEl.addClass("is-done");

      const main = taskEl.createDiv({ cls: "native-task-main" });
      main.createSpan({ cls: "native-task-label", text: label });

      // Per-task progress: a thin coral bar on a hairline track + x/N readout.
      const prog = main.createDiv({ cls: "native-task-prog" });
      const track = prog.createDiv({ cls: "native-task-track" });
      const fill = track.createDiv({ cls: "native-task-fill" });
      const readout = prog.createSpan({ cls: "native-task-readout" });
      this.taskBars[idx] = { fill, readout, label };

      const toggle = async (next: boolean): Promise<void> => {
        cb.checked = next;
        taskEl.toggleClass("is-done", next);
        await setFlag(idx, next);
        this.refreshTaskBars();
      };

      cb.addEventListener("change", () => void toggle(cb.checked));
      taskEl.addEventListener("click", (e) => {
        if (e.target === cb) return; // checkbox handles its own change
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest(".native-task-import") ||
            e.target.closest(".native-task-prog"))
        ) {
          return; // import button / progress area handle their own clicks
        }
        void toggle(!cb.checked);
      });

      // Inline 导入 button for the 导入单词 / 导入文章 tasks.
      const kind = importKind(label);
      if (kind) {
        const imp = taskEl.createEl("button", {
          cls: "native-btn native-btn-ghost native-task-import",
          text: "导入",
        });
        imp.addEventListener("click", () => {
          if (kind === "words") {
            new ImportWordsModal(this.app, this.plugin, async (added) => {
              if (added > 0) {
                await this.plugin.primeVocab();
                await toggle(true);
              }
            }).open();
          } else {
            new ImportArticleModal(
              this.app,
              this.plugin,
              async (file) => {
                this.rebuildReading();
                if (file) await toggle(true);
                else this.refreshTaskBars();
              },
              this.iso
            ).open();
          }
        });
      }
    });

    // Prime the vocab snapshot, then paint the measured progress bars.
    void this.plugin.primeVocab().then(() => this.refreshTaskBars());

    this.renderWords(contentEl);
    this.renderReading(contentEl);
    this.renderDayWriting(contentEl);
    this.renderDayNote(contentEl);
  }

  /** Per-task progress-bar handles, by task index. */
  private taskBars: Record<
    number,
    { fill: HTMLElement; readout: HTMLElement; label: string }
  > = {};

  /**
   * Recompute + paint every task's progress bar from the plugin's measured
   * ratios. Measurable tasks show x/N; full tasks show a check.
   */
  private refreshTaskBars(): void {
    const lang = this.plugin.settings.currentLanguage;
    const ratios = this.plugin.taskProgress(lang, this.iso);
    const metrics = this.plugin.getMetrics(lang, this.iso);
    const dueCount = this.plugin.dueCountFor(lang, this.iso);
    const articles = this.plugin.articlesForDate(this.iso).length;
    const flags = this.plugin.getDay(lang, this.iso);

    for (const key of Object.keys(this.taskBars)) {
      const idx = Number(key);
      const bar = this.taskBars[idx];
      const r = ratios[idx] ?? 0;
      bar.fill.style.width = `${Math.round(r * 100)}%`;
      bar.fill.toggleClass("is-full", r >= 1);
      bar.readout.setText(
        this.readoutFor(bar.label, idx, metrics, dueCount, articles, flags, r)
      );
    }
  }

  /** The small x/N (or check) label for one task's progress. */
  private readoutFor(
    label: string,
    idx: number,
    metrics: DayMetrics,
    dueCount: number,
    articles: number,
    flags: boolean[],
    ratio: number
  ): string {
    const imp = importKind(label);
    if (imp) return ratio >= 1 ? "✓" : "0";
    if (label.includes("新词")) {
      return `${metrics.learned}/${this.plugin.settings.newPerDay}`;
    }
    if (label.includes("复习")) {
      if (dueCount === 0) return "✓";
      return `${metrics.reviewed}/${dueCount}`;
    }
    if (label.includes("读") && label.includes("篇")) {
      return `${metrics.articlesRead}/${this.plugin.settings.articlesPerDay}`;
    }
    return flags[idx] ? "✓" : "—";
  }

  /** Host for 今日新词 + 今日复习 (rebuilt after a 学会了 / review action). */
  private wordsSec: HTMLElement | null = null;

  /**
   * 今日新词 + 今日复习 sections. Built into a host element synchronously,
   * then populated async (wordlist / 词卡 / vocab loads).
   */
  private renderWords(host: HTMLElement): void {
    const sec = host.createDiv({ cls: "native-day-words" });
    this.wordsSec = sec;
    void this.rebuildWords();
  }

  /** (Re)load + render the 今日新词 / 今日复习 content into wordsSec. */
  private async rebuildWords(): Promise<void> {
    const sec = this.wordsSec;
    if (!sec) return;
    sec.empty();

    const lang = this.plugin.settings.currentLanguage;
    const isEnglish = lang === "英语";
    if (isEnglish) await this.plugin.loadIPA();

    const [newWords, vocab] = await Promise.all([
      this.plugin.newWordsForDay(this.iso),
      this.loadVocab(),
    ]);
    // 英语:今日这批词本地没卡的,先从服务器按需拉回来,再读卡。
    await this.plugin.ensureCards(newWords, lang);
    const cards = await this.plugin.loadWordCards(lang);

    // ---- 今日新词 ----
    const newSec = sec.createDiv({ cls: "native-day-wordgroup" });
    const newHead = newSec.createDiv({ cls: "native-sec-head" });
    newHead.createEl("h3", {
      cls: "native-day-reading-title",
      text: "今日新词",
    });
    const learnedSet = this.plugin.learnedSet(this.plugin.levelKey());
    const learnedCount = newWords.filter((w) =>
      learnedSet.has(w.toLowerCase())
    ).length;
    newHead.createSpan({
      cls: "native-sec-count",
      text: `已学会 ${learnedCount}/${newWords.length}`,
    });
    // A detail panel (inline expand) shared by both tile grids.
    const detail = sec.createDiv({ cls: "native-word-detail is-empty" });
    this.detailEl = detail;

    if (newWords.length === 0) {
      newSec.createDiv({
        cls: "native-empty",
        text: "本级别词表已全部学完，去设置里换个级别。",
      });
    } else {
      const grid = newSec.createDiv({ cls: "native-word-tiles" });
      for (const word of newWords) {
        this.renderWordTile(
          grid,
          word,
          () => this.showNewWordDetail(word, cards[word], isEnglish),
          learnedSet.has(word.toLowerCase())
        );
      }
    }

    // ---- 今日复习 ----
    const today = todayISO();
    const due = vocab.filter((e) => isDue(e, today));
    const revSec = sec.createDiv({ cls: "native-day-wordgroup" });
    const revHead = revSec.createDiv({ cls: "native-sec-head" });
    revHead.createEl("h3", {
      cls: "native-day-reading-title",
      text: "今日复习",
    });
    revHead.createSpan({
      cls: "native-sec-count",
      text: `${due.length} 词`,
    });
    if (due.length === 0) {
      revSec.createDiv({ cls: "native-empty", text: "今天没有到期要复习的词。" });
    } else {
      const grid = revSec.createDiv({ cls: "native-word-tiles" });
      for (const e of due) {
        this.renderWordTile(grid, e.word, () =>
          this.showReviewDetail(e, cards[e.word])
        );
      }
    }
  }

  /** Inline word-detail panel (shared by 今日新词 + 今日复习 tile grids). */
  private detailEl: HTMLElement | null = null;

  /**
   * One compact square-ish word TILE: the word + a tiny speaker icon that
   * reads it. Clicking the tile (anywhere but the speaker) opens its detail.
   */
  private renderWordTile(
    grid: HTMLElement,
    word: string,
    onOpen: () => void,
    learned = false
  ): void {
    const tile = grid.createDiv({ cls: "native-word-tile" });
    if (learned) {
      tile.addClass("is-learned");
      const bm = tile.createSpan({ cls: "native-word-bookmark" });
      setIcon(bm, "bookmark-check");
      bm.setAttr("aria-label", "已学会");
    }
    tile.createSpan({ cls: "native-word-tile-w", text: word });
    const spk = tile.createSpan({ cls: "native-word-tile-spk" });
    setIcon(spk, "volume-2");
    spk.setAttr("aria-label", "朗读");
    spk.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.speakOnce(word);
    });
    tile.addEventListener("click", () => onOpen());
  }

  /** Speak one word/sentence once via the modal's speech controller. */
  private speakOnce(text: string): void {
    void this.ensureSpeech().speakOnce(
      text,
      this.plugin.settings.currentLanguage
    );
  }

  /**
   * Render the 今日新词 detail into the shared panel: word large + ipa + 翻译 +
   * 例句(italic) + 例句中译 + 近义词 + 读 + 学会了. Missing card → ipa + muted
   * "（卡片生成中）". 学会了 → markLearned + appendWord; the tile re-renders away.
   */
  private showNewWordDetail(
    word: string,
    card: WordCard | undefined,
    isEnglish: boolean
  ): void {
    const detail = this.detailEl;
    if (!detail) return;
    detail.removeClass("is-empty");
    detail.empty();

    const ipa =
      card?.ipa?.trim() || (isEnglish ? this.plugin.lookupIPA(word) ?? "" : "");
    const head = detail.createDiv({ cls: "native-word-head" });
    head.createSpan({ cls: "native-word-detail-w", text: word });
    if (ipa) head.createSpan({ cls: "native-word-ipa", text: `/${ipa}/` });

    const group = card?.["例句组"]?.filter((e) => e?.["例句"]?.trim()) ?? [];
    const example = (group[0]?.["例句"] ?? card?.["例句"] ?? "").trim();
    if (card) {
      this.detailField(detail, "翻译", card["翻译"] ?? "");
      if (group.length) {
        this.renderExamples(detail, group);
      } else {
        this.detailField(detail, "例句", example, true);
        this.detailField(detail, "例句中译", card["例句中译"] ?? "");
      }
      this.detailField(detail, "近义词", card["近义词"] ?? "");
    } else {
      detail.createDiv({ cls: "native-word-todo", text: "（卡片生成中）" });
    }

    const actions = detail.createDiv({ cls: "native-word-actions" });
    const readBtn = actions.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "读",
    });
    readBtn.addEventListener("click", () => {
      // Read the word, then the example sentence if present.
      this.speakOnce(example ? `${word}. ${example}` : word);
    });
    const learnBtn = actions.createEl("button", {
      cls: "native-btn",
      text: "学会了",
    });
    learnBtn.addEventListener("click", async () => {
      learnBtn.disabled = true;
      const extra: AppendExtra | undefined = card
        ? {
            ipa: card.ipa,
            translation: card["翻译"],
            example: card["例句"],
            synonyms: card["近义词"],
          }
        : ipa
        ? { ipa }
        : undefined;
      await this.plugin.appendWord(word, "今日新词", "", extra);
      await this.plugin.markLearned(this.plugin.levelKey(), word);
      // Measured: one new word learned today.
      await this.plugin.bumpMetric(
        this.plugin.settings.currentLanguage,
        this.iso,
        "learned",
        1
      );
      await this.plugin.primeVocab();
      this.onChange();
      this.refreshTaskBars();
      await this.rebuildWords(); // tile disappears (re-render drops learned)
    });
  }

  /**
   * Render the 今日复习 detail into the shared panel: word + ipa + 翻译 +
   * 例句(italic) + 近义词 + 读 + 记住了 / 没记住 (Ebbinghaus reschedule).
   */
  private showReviewDetail(e: VocabEntry, card?: WordCard): void {
    const detail = this.detailEl;
    if (!detail) return;
    detail.removeClass("is-empty");
    detail.empty();

    const head = detail.createDiv({ cls: "native-word-head" });
    head.createSpan({ cls: "native-word-detail-w", text: e.word });
    if (e.ipa) head.createSpan({ cls: "native-word-ipa", text: `/${e.ipa}/` });

    this.detailField(detail, "翻译", e.translation);
    // Prefer the card's 10-scenario 例句组; fall back to the saved single 造句.
    const group = card?.["例句组"]?.filter((x) => x?.["例句"]?.trim()) ?? [];
    if (group.length) {
      this.renderExamples(detail, group);
    } else {
      this.detailField(detail, "例句", e.example, true);
    }
    this.detailField(detail, "近义词", e.synonyms);

    const actions = detail.createDiv({ cls: "native-word-actions" });
    const readBtn = actions.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "读",
    });
    readBtn.addEventListener("click", () => {
      this.speakOnce(e.example ? `${e.word}. ${e.example}` : e.word);
    });
    const remembered = actions.createEl("button", {
      cls: "native-btn",
      text: "记住了",
    });
    const forgot = actions.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "没记住",
    });
    const grade = async (ok: boolean): Promise<void> => {
      remembered.disabled = true;
      forgot.disabled = true;
      if (ok) reviewRemembered(e);
      else reviewForgot(e);
      await this.plugin.rewriteVocabEntry(e);
      // Measured: one review graded today.
      await this.plugin.bumpMetric(
        this.plugin.settings.currentLanguage,
        this.iso,
        "reviewed",
        1
      );
      await this.plugin.primeVocab();
      this.onChange();
      this.refreshTaskBars();
      await this.rebuildWords(); // tile disappears
    };
    remembered.addEventListener("click", () => void grade(true));
    forgot.addEventListener("click", () => void grade(false));
  }

  /**
   * Render the 例句组 (scenario sentences) block: each item shows its 场景 tag,
   * the English line (tap to read it), and the 中译. Numbered 1…N.
   */
  private renderExamples(host: HTMLElement, examples: WordExample[]): void {
    const f = host.createDiv({ cls: "native-word-field" });
    f.createSpan({ cls: "native-word-k", text: `例句 · ${examples.length} 个场景` });
    const list = host.createDiv({ cls: "native-word-examples" });
    examples.forEach((ex, i) => {
      const item = list.createDiv({ cls: "native-word-ex" });
      const top = item.createDiv({ cls: "native-word-ex-top" });
      top.createSpan({ cls: "native-word-ex-num", text: String(i + 1) });
      if (ex["场景"]?.trim()) {
        top.createSpan({ cls: "native-word-ex-scene", text: ex["场景"].trim() });
      }
      const sent = ex["例句"].trim();
      const en = item.createDiv({ cls: "native-word-ex-en native-italic" });
      en.appendChild(furiganaFrag(sent)); // 日语汉字标假名;其它语言=纯文本
      en.setAttr("title", "点击朗读");
      en.addEventListener("click", () => this.speakOnce(stripFurigana(sent)));
      if (ex["中译"]?.trim()) {
        item.createDiv({ cls: "native-word-ex-cn", text: ex["中译"].trim() });
      }
    });
  }

  /** One labelled field row inside the word-detail panel. */
  private detailField(
    host: HTMLElement,
    label: string,
    value: string,
    italic = false
  ): void {
    const v = value.trim();
    if (!v) return;
    const f = host.createDiv({ cls: "native-word-field" });
    f.createSpan({ cls: "native-word-k", text: label });
    const span = f.createSpan({ cls: "native-word-v", text: v });
    if (italic) span.addClass("native-italic");
  }

  /** Read + parse the current language's 生词库.md into entries. */
  private async loadVocab(): Promise<VocabEntry[]> {
    const path = this.plugin.vocabPath();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return parseVocab(await this.app.vault.cachedRead(file));
    }
    return [];
  }

  /** Reading section element (stored so it can be rebuilt after imports). */
  private readingSec: HTMLElement | null = null;

  /** Open the import-article modal targeting this day; refresh on done. */
  private importArticle(autoOpen: boolean): void {
    new ImportArticleModal(
      this.app,
      this.plugin,
      async (file) => {
        this.rebuildList();
        if (file && autoOpen) await this.openArticle(file);
      },
      this.iso
    ).open();
  }

  /** 当日阅读: exactly articlesPerDay slots for this day + inline reader. */
  private renderReading(host: HTMLElement): void {
    const sec = host.createDiv({ cls: "native-day-reading" });
    this.readingSec = sec;
    const head = sec.createDiv({ cls: "native-sec-head" });
    head.createEl("h3", { cls: "native-day-reading-title", text: "当日阅读" });
    if (this.plugin.settings.currentLanguage === "韩语") {
      const loading = sec.createDiv({
        cls: "native-read-loading",
        text: "正在准备本级阅读…",
      });
      void this.plugin
        .ensureKoreanArticlesForDate(this.iso)
        .catch((error) => {
          console.warn("Native: Korean reading setup failed", error);
          new Notice("韩语文章加载失败，请重新打开这一天");
        })
        .finally(() => {
          loading.remove();
          this.rebuildList();
          this.refreshTaskBars();
        });
    } else {
      this.rebuildList();
    }
  }

  /** Re-render the reading section (after an article import). */
  private rebuildReading(): void {
    this.rebuildList();
  }

  /**
   * (Re)build the slot list + reader panel. Shows exactly articlesPerDay
   * slots: filled slots list the article (with 读); empty slots show a
   * "＋ 第N篇" button that opens the import-article modal.
   */
  private rebuildList(): void {
    const sec = this.readingSec;
    if (!sec) return;
    sec.querySelector(".native-read-list")?.remove();
    sec.querySelector(".native-article")?.remove();
    this.speech?.stop();
    this.sentSpans = [];
    this.removeFloatBtn();

    const articles = this.plugin.articlesForDate(this.iso);
    const slots = Math.max(
      this.plugin.settings.articlesPerDay,
      articles.length
    );

    const list = sec.createDiv({ cls: "native-read-list" });
    for (let i = 0; i < slots; i++) {
      const a = articles[i];
      if (a) {
        const item = list.createDiv({ cls: "native-read-item" });
        item.dataset.path = a.file.path;
        item.createSpan({ cls: "native-read-item-title", text: a.title });
        const readBtn = item.createEl("button", {
          cls: "native-btn native-btn-ghost native-read-btn",
          text: "读",
        });
        readBtn.addEventListener("click", () => void this.openArticle(a.file));
      } else {
        const empty = list.createDiv({
          cls: "native-read-item native-read-slot",
        });
        empty.createSpan({
          cls: "native-read-slot-label",
          text: `＋ 第${i + 1}篇`,
        });
        empty.addEventListener("click", () => this.importArticle(true));
      }
    }

    sec.createDiv({ cls: "native-article" });
  }

  /** 当日笔记: a textarea loading/saving a per-day note, saved on blur. */
  private renderDayNote(host: HTMLElement): void {
    const sec = host.createDiv({ cls: "native-day-note" });
    sec.createEl("h3", { cls: "native-day-reading-title", text: "当日笔记" });
    const ta = sec.createEl("textarea", {
      cls: "native-input native-day-note-input",
      attr: { placeholder: "记下今天的学习心得、难点、造句…（失焦自动保存）" },
    });
    void this.plugin.readDayNote(this.iso).then((text) => {
      ta.value = text;
    });
    ta.addEventListener("blur", () => {
      void this.plugin.saveDayNote(this.iso, ta.value);
    });
  }

  /** 自己造句: a textarea for the user's own sentences, saved on blur. */
  private renderDayWriting(host: HTMLElement): void {
    const sec = host.createDiv({ cls: "native-day-note" });
    sec.createEl("h3", { cls: "native-day-reading-title", text: "自己造句" });
    sec.createEl("div", {
      text: "用今天学的词造句（每行一句）。写完后可以自己检查，并记录更自然的表达。",
      attr: { style: "font-size:12px;opacity:.7;margin:2px 0 6px;line-height:1.5;" },
    });
    const ta = sec.createEl("textarea", {
      cls: "native-input native-day-note-input",
      attr: { placeholder: "写几句英文，用上今天的新词…（失焦自动保存）" },
    });
    void this.plugin.readDayWriting(this.iso).then((text) => {
      ta.value = text;
    });
    ta.addEventListener("blur", () => {
      void this.plugin.saveDayWriting(this.iso, ta.value);
    });
  }

  /** Render an article's markdown inline into the reading section. */
  private async openArticle(file: TFile): Promise<void> {
    const sec = this.readingSec;
    if (!sec) return;
    const panel = sec.querySelector<HTMLElement>(".native-article");
    if (!panel) return;
    this.currentFile = file;

    sec
      .querySelectorAll(".native-read-item")
      .forEach((el) => el.removeClass("is-active"));
    sec
      .querySelector<HTMLElement>(
        `.native-read-item[data-path="${CSS.escape(file.path)}"]`
      )
      ?.addClass("is-active");

    // Measured: mark this article read once per day (opening the reader).
    // Cap at the number of articles filed for the day so the count can't drift.
    const lang0 = this.plugin.settings.currentLanguage;
    const cap = this.plugin.articlesForDate(this.iso).length;
    if (
      !this.readArticles.has(file.path) &&
      this.plugin.getMetrics(lang0, this.iso).articlesRead < cap
    ) {
      this.readArticles.add(file.path);
      await this.plugin.bumpMetric(lang0, this.iso, "articlesRead", 1);
      this.onChange();
      this.refreshTaskBars();
    } else {
      this.readArticles.add(file.path);
    }

    panel.empty();
    this.removeFloatBtn();
    // Stop any speech from a previously-open article and reset highlight state.
    this.speech?.stop();
    this.sentSpans = [];

    const lang = this.plugin.settings.currentLanguage;
    const isEnglish = lang === "英语";

    // Reader header: 音标 toggle (English only) + LISTEN audio controls.
    const bar = panel.createDiv({ cls: "native-reader-bar" });
    if (isEnglish) {
      const toggle = bar.createEl("button", {
        cls: "native-btn native-btn-ghost native-ipa-toggle",
        text: `音标 ${this.plugin.settings.showIPA ? "开" : "关"}`,
      });
      toggle.addEventListener("click", async () => {
        this.plugin.settings.showIPA = !this.plugin.settings.showIPA;
        await this.plugin.saveSettings();
        await this.openArticle(file); // re-render with new state
      });
    }

    const body = panel.createDiv({ cls: "native-article-body" });
    const md = await this.app.vault.cachedRead(file);
    await MarkdownRenderer.render(
      this.app,
      md,
      body,
      file.path,
      this.plugin as Component
    );

    // Snapshot the CLEAN plain text BEFORE any annotation (strip 读音标注 `{词|读音}`,
    // 让朗读/划词存库拿到底字,不带读音), so 造句 capture never includes ruby text.
    const hasReadings = /\{[^{}|]+\|[^{}|]+\}/.test(body.innerText || "");
    const cleanText = stripFurigana(body.innerText || "");

    // Pre-split clean text into sentences for both TTS and highlight wrapping.
    const sentences = splitSentences(cleanText);

    if (hasReadings) {
      // 内容自带读音标注(日语假名 / 中文拼音 / 法语音标 / 阿语转写 / 韩语罗马音…)
      // → 渲染成"读音标在词上方"(ruby)。跳过逐句高亮包裹——标注文本与净文本不一致会
      // 错位;朗读走上面的净文本,不受影响。
      this.sentSpans = [];
      annotateFurigana(body);
    } else {
      // Wrap the rendered body's text into per-sentence spans for highlight.
      // Runs BEFORE IPA annotation so ruby is built inside the spans.
      try {
        this.sentSpans = this.wrapSentences(body, sentences);
      } catch (e) {
        console.error("[native] sentence wrap failed; reader still works", e);
        this.sentSpans = [];
      }
      // Annotate English words with IPA ruby (when enabled).
      if (isEnglish && this.plugin.settings.showIPA) {
        await this.plugin.loadIPA();
        this.annotateIPA(body);
      }
    }

    // LISTEN controls (after body so the highlight target exists).
    const speakSentences =
      lang === "英语"
        ? sentences.filter(
            (s) => /[A-Za-z]/.test(s) && !/[一-鿿]/.test(s)
          )
        : lang === "韩语"
          ? sentences.filter((s) => /[가-힣]/.test(s))
        : sentences;
    this.buildAudioControls(bar, speakSentences, lang);

    const onSelect = (): void => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      if (!sel || sel.isCollapsed || !text.trim() || !body.contains(sel.anchorNode)) {
        this.removeFloatBtn();
        return;
      }
      // A ruby selection's toString() can include the <rt> IPA. Strip any
      // IPA tokens and collapse to the underlying word(s).
      const word = stripIPA(text).trim();
      if (!word) {
        this.removeFloatBtn();
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const hostRect = panel.getBoundingClientRect();
      // Compute 造句 from the CLEAN pre-annotation text, never the ruby DOM.
      const example = sentenceAround(cleanText, word);
      this.showFloatBtn(
        panel,
        word,
        file.basename,
        example,
        rect.left - hostRect.left + rect.width / 2,
        rect.top - hostRect.top
      );
    };
    body.addEventListener("mouseup", () => window.setTimeout(onSelect, 0));
  }

  /** Lazily create the per-modal speech controller. */
  private ensureSpeech(): SpeechController {
    if (!this.speech) {
      this.speech = new SpeechController(
        () => this.plugin.settings.speechRate,
        (i) => this.setActiveSentence(i),
        () => this.refreshAudioControls(),
        () => this.plugin.settings.voiceName,
        () => this.plugin.ttsUrlBuilder()
      );
    }
    return this.speech;
  }

  /** Highlight the sentence at `index` (or clear all when index < 0). */
  private setActiveSentence(index: number): void {
    this.sentSpans.forEach((span, i) => {
      const on = i === index;
      span.toggleClass("native-sent-active", on);
      if (on) span.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /**
   * Build the 朗读 / 暂停 + 停止 + 语速 controls into the reader bar.
   * Buttons reflect controller state via refreshAudioControls().
   */
  private buildAudioControls(
    bar: HTMLElement,
    sentences: string[],
    language: string
  ): void {
    const speech = this.ensureSpeech();
    const group = bar.createDiv({ cls: "native-audio" });

    const playBtn = group.createEl("button", {
      cls: "native-btn native-btn-ghost native-audio-btn",
    });
    playBtn.addEventListener("click", () => {
      if (speech.isActive && !speech.isPaused) {
        speech.pause();
      } else {
        void speech.play(sentences, language);
      }
    });

    const stopBtn = group.createEl("button", {
      cls: "native-btn native-btn-ghost native-audio-btn",
      text: "停止",
    });
    stopBtn.addEventListener("click", () => speech.stop());

    // 声音固定为自动挑选的最清楚那个(见 pickVoice),不再提供选择。

    // Speed slider (0.5–1.5), persisted in settings.speechRate. Applies live:
    // if currently speaking, re-speak the remaining sentences at the new rate.
    const speed = group.createDiv({ cls: "native-audio-speed" });
    const slider = speed.createEl("input", {
      attr: {
        type: "range",
        min: "0.5",
        max: "1.5",
        step: "0.05",
        value: String(clampRate(this.plugin.settings.speechRate)),
      },
    });
    const readout = speed.createSpan({ cls: "native-audio-rate" });
    const showRate = (): void => {
      readout.setText(`${clampRate(this.plugin.settings.speechRate).toFixed(2)}×`);
    };
    showRate();
    slider.addEventListener("input", async () => {
      this.plugin.settings.speechRate = clampRate(parseFloat(slider.value));
      showRate();
      await this.plugin.saveSettings();
      // Live-apply to an in-progress reading.
      speech.reapplyRate();
    });

    this.refreshAudioControls();
  }

  /** Sync the 朗读/暂停 label+icon to the controller's current state. */
  private refreshAudioControls(): void {
    const btn = this.contentEl.querySelector<HTMLButtonElement>(
      ".native-audio-btn"
    );
    if (!btn) return;
    const speaking = this.speech?.isActive && !this.speech.isPaused;
    btn.empty();
    const icon = btn.createSpan({ cls: "native-audio-icon" });
    setIcon(icon, speaking ? "pause" : "play");
    btn.createSpan({ text: speaking ? "暂停" : "朗读" });
  }

  /**
   * Wrap the body's rendered text into per-sentence <span class="native-sent">
   * spans, in document order, so the speaker can highlight by index. Walks text
   * nodes (skipping code), consumes characters against the pre-split sentence
   * list, and moves each sentence's text nodes under its span. Returns the
   * spans by index. The clean-text snapshot / 造句 capture is unaffected.
   */
  private wrapSentences(body: HTMLElement, sentences: string[]): HTMLElement[] {
    if (sentences.length === 0) return [];
    const spans: HTMLElement[] = [];
    // Wrap one sentence at a time, re-scanning only the still-unwrapped text on
    // each pass. surroundContents/extractContents SPLIT text nodes, so any
    // precomputed node+offset refs go stale after the first wrap — re-collecting
    // fresh each sentence keeps offsets valid and avoids the IndexSizeError that
    // previously threw and aborted the rest of the reader setup.
    for (let s = 0; s < sentences.length; s++) {
      const len = sentences[s].replace(/\s+/g, "").length;
      if (len === 0) {
        spans.push(this.emptySentSpan(body, s));
        continue;
      }
      try {
        const ref = this.collectUnwrapped(body, len);
        if (!ref) {
          spans.push(this.emptySentSpan(body, s));
          continue;
        }
        const span = document.createElement("span");
        span.className = "native-sent";
        span.dataset.i = String(s);
        const range = document.createRange();
        range.setStart(ref.start.node, ref.start.offset);
        range.setEnd(ref.end.node, ref.end.offset + 1);
        try {
          range.surroundContents(span);
        } catch {
          const frag = range.extractContents();
          span.appendChild(frag);
          range.insertNode(span);
        }
        spans.push(span);
      } catch {
        spans.push(this.emptySentSpan(body, s));
      }
    }
    return spans;
  }

  /**
   * Collect the next `len` non-whitespace characters from body text that is not
   * yet inside a .native-sent span (and not in code). Returns the start and end
   * char positions as node+offset, or null if there isn't enough text left.
   */
  private collectUnwrapped(
    body: HTMLElement,
    len: number
  ):
    | { start: { node: Text; offset: number }; end: { node: Text; offset: number } }
    | null {
    const SKIP = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "RT"]);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node): number => {
        for (
          let el: HTMLElement | null = node.parentElement;
          el && el !== body;
          el = el.parentElement
        ) {
          if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (el.classList && el.classList.contains("native-sent")) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let start: { node: Text; offset: number } | null = null;
    let end: { node: Text; offset: number } | null = null;
    let count = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const v = t.nodeValue ?? "";
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) continue;
        if (!start) start = { node: t, offset: i };
        end = { node: t, offset: i };
        count++;
        if (count >= len) return { start, end };
      }
    }
    return start && end ? { start, end } : null;
  }

  /** A placeholder (empty) sentence span appended to body; keeps indices aligned. */
  private emptySentSpan(body: HTMLElement, i: number): HTMLElement {
    const span = body.createSpan({ cls: "native-sent" });
    span.dataset.i = String(i);
    return span;
  }

  /**
   * Walk the rendered article DOM and wrap each English word in a
   * <ruby class="native-ruby">WORD<rt class="native-ipa">/ipa/</rt></ruby>
   * when an IPA is found. Skips code blocks; words without IPA stay plain.
   */
  private annotateIPA(body: HTMLElement): void {
    const SKIP = new Set(["CODE", "PRE", "RUBY", "RT", "SCRIPT", "STYLE"]);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node): number => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        for (let el: HTMLElement | null = parent; el && el !== body; el = el.parentElement) {
          if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && /[A-Za-z]/.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      targets.push(n as Text);
    }

    const tokenRe = /[A-Za-z'’-]+/g;
    for (const textNode of targets) {
      const value = textNode.nodeValue ?? "";
      tokenRe.lastIndex = 0;
      let m: RegExpExecArray | null = tokenRe.exec(value);
      if (!m) continue;
      // Does this node have at least one annotatable word? If not, skip.
      const frag = document.createDocumentFragment();
      let last = 0;
      let annotated = false;
      while (m) {
        const word = m[0];
        const ipa = this.plugin.lookupIPA(word);
        if (ipa) {
          if (m.index > last) {
            frag.appendChild(document.createTextNode(value.slice(last, m.index)));
          }
          const ruby = document.createElement("ruby");
          ruby.className = "native-ruby";
          ruby.appendChild(document.createTextNode(word));
          const rt = document.createElement("rt");
          rt.className = "native-ipa";
          rt.textContent = `/${ipa}/`;
          ruby.appendChild(rt);
          frag.appendChild(ruby);
          last = m.index + word.length;
          annotated = true;
        }
        m = tokenRe.exec(value);
      }
      if (!annotated) continue;
      if (last < value.length) {
        frag.appendChild(document.createTextNode(value.slice(last)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }

  private showFloatBtn(
    host: HTMLElement,
    text: string,
    sourceName: string,
    example: string,
    x: number,
    y: number
  ): void {
    this.removeFloatBtn();
    if (getComputedStyle(host).position === "static") {
      host.addClass("native-anchor");
    }
    const btn = host.createEl("button", {
      cls: "native-float-store",
      text: "＋ 存入生词库",
    });
    btn.style.left = `${Math.max(0, x)}px`;
    btn.style.top = `${Math.max(0, y - 38)}px`;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", async () => {
      const ok = await this.plugin.appendWord(text, sourceName, example);
      if (ok) window.getSelection()?.removeAllRanges();
      this.removeFloatBtn();
    });
    this.floatBtn = btn;
  }

  private removeFloatBtn(): void {
    if (this.floatBtn) {
      this.floatBtn.remove();
      this.floatBtn = null;
    }
  }

  onClose(): void {
    this.speech?.stop();
    this.sentSpans = [];
    this.removeFloatBtn();
    this.contentEl.empty();
  }
}

/* ============================================================
 *  Settings tab
 * ========================================================== */

class NativeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NativePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("换母语").setHeading();

    new Setting(containerEl)
      .setName("授权码")
      .setDesc("公众号购买后获得的 100 天授权码")
      .addText((text) =>
        text
          .setPlaceholder("授权码")
          .setValue(this.plugin.settings.licenseKey)
          .onChange(async (value) => {
            this.plugin.settings.licenseKey = value.trim();
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("验证")
          .setCta()
          .onClick(async () => {
            const lic = await this.plugin.license.validate();
            new Notice(lic.valid ? "授权有效 ✓" : `授权无效：${lic.reason ?? "未知原因"}`);
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("验证服务地址")
      .setDesc("授权验证端点（默认即可，一般无需修改）")
      .addText((text) =>
        text
          .setPlaceholder("https://…supabase.co/functions/v1/native-license-validate")
          .setValue(this.plugin.settings.licenseApi)
          .onChange(async (value) => {
            this.plugin.settings.licenseApi = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("英文音标")
      .setDesc("在英语文章阅读器中，于单词上方显示 IPA 音标")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showIPA)
          .onChange(async (value) => {
            this.plugin.settings.showIPA = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("英语朗读音色")
      .setDesc("内置自然声在你的电脑本地合成；不把朗读文字传到服务器。无密钥或不支持时自动回退系统声音。")
      .addDropdown((dd) =>
        dd
          .addOption("af_heart", "Heart（女声）")
          .addOption("am_michael", "Michael（男声）")
          .setValue(
            this.plugin.settings.ttsVoice === "andy"
              ? "am_michael"
              : this.plugin.settings.ttsVoice === "abby"
                ? "af_heart"
                : this.plugin.settings.ttsVoice || "af_heart"
          )
          .onChange(async (value) => {
            this.plugin.settings.ttsVoice = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("朗读语速")
      .setDesc("文章朗读（跟读）的播放速度，0.5–1.5 倍")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 1.5, 0.05)
          .setValue(clampRate(this.plugin.settings.speechRate))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.speechRate = clampRate(value);
            await this.plugin.saveSettings();
          })
      );

    this.renderVoiceSetting(containerEl);
    this.renderPlanSettings(containerEl);
    this.renderTaskSettings(containerEl);

    new Setting(containerEl)
      .setName("本地模拟授权(开发用)")
      .setDesc("开启后，任意非空授权码即视为有效，不访问网络")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mockLicense)
          .onChange(async (value) => {
            this.plugin.settings.mockLicense = value;
            await this.plugin.saveSettings();
          })
      );

    const lic = this.plugin.settings.license;
    const expiry =
      lic.expiresAt != null
        ? isoFromDate(new Date(lic.expiresAt))
        : "—";
    const status = containerEl.createDiv({ cls: "native-setting-status" });
    status.createDiv({ text: `设备ID：${this.plugin.settings.deviceId}` });
    status.createDiv({
      text: `授权状态：${lic.valid ? "已授权" : `未授权${lic.reason ? "（" + lic.reason + "）" : ""}`}`,
    });
    status.createDiv({ text: `到期日：${expiry}` });
  }

  /**
   * 朗读声音：固定自动挑选最清晰的内置声音(见 pickVoice),不再提供选择。
   * 这里只给一条提示,告诉用户如何下载更自然的声音(下载后会被自动选用)。
   */
  private renderVoiceSetting(containerEl: HTMLElement): void {
    const korean = this.plugin.settings.currentLanguage === "韩语";
    new Setting(containerEl)
      .setName("朗读声音")
      .setDesc(
        korean
          ? "韩语自动使用自然女声，无需选择。"
          : "自动使用最清晰的声音，无需选择。"
      );
    containerEl.createDiv({
      cls: "native-setting-status",
      text: korean
        ? "首次朗读需联网，音频会自动缓存在你的电脑；之后再听直接本地播放，不下载、不运行语音模型。"
        : "英语自然声在电脑本地合成，朗读内容不会传到服务器。",
    });
  }

  /** Plan settings: 每日新词 / 每日文章 / 总目标 / 总天数 / 级别. */
  private renderPlanSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("学习计划").setHeading();

    const numberSetting = (
      name: string,
      desc: string,
      get: () => number,
      set: (v: number) => void,
      min: number
    ): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text.setValue(String(get())).onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isNaN(n) || n < min) return;
            set(n);
            await this.plugin.saveSettings();
          })
        );
    };

    numberSetting(
      "每日新词",
      "计划每天学习的新单词数（默认任务 1 引用此数）",
      () => this.plugin.settings.newPerDay,
      (v) => (this.plugin.settings.newPerDay = v),
      1
    );
    numberSetting(
      "每日文章",
      "计划每天阅读的文章数（默认任务 3 + 当日阅读槽位引用此数）",
      () => this.plugin.settings.articlesPerDay,
      (v) => (this.plugin.settings.articlesPerDay = v),
      1
    );
    numberSetting(
      "总目标词量",
      "整个计划要掌握的总词量",
      () => this.plugin.settings.totalTarget,
      (v) => (this.plugin.settings.totalTarget = v),
      1
    );
    numberSetting(
      "总天数",
      "计划总天数",
      () => this.plugin.settings.totalDays,
      (v) => (this.plugin.settings.totalDays = v),
      1
    );

    if (this.plugin.settings.currentLanguage === "韩语") {
      new Setting(containerEl)
        .setName("韩语 TOPIK 级别")
        .setDesc("词汇、打卡进度和阅读文章都会按该 TOPIK 级别独立显示")
        .addDropdown((dd) => {
          for (const lv of KOREAN_LEVELS) dd.addOption(lv, lv);
          dd.setValue(
            KOREAN_LEVELS.includes(this.plugin.settings.koreanLevel)
              ? this.plugin.settings.koreanLevel
              : "TOPIK 1"
          );
          dd.onChange(async (value) => {
            this.plugin.settings.koreanLevel = value;
            await this.plugin.ensureKoreanLevelStart(value);
            this.plugin.refreshViews();
          });
        });
    } else if (this.plugin.settings.currentLanguage === "英语") {
      new Setting(containerEl)
        .setName("词表级别")
        .setDesc("选择内置词表（小学/初中/高中/CET4/CET6/雅思）")
        .addDropdown((dd) => {
          for (const lv of LEVELS) dd.addOption(lv, lv);
          dd.setValue(
            LEVELS.includes(this.plugin.settings.level)
              ? this.plugin.settings.level
              : "高中"
          );
          dd.onChange(async (value) => {
            this.plugin.settings.level = value;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("重新测试水平")
        .setDesc("重新做一次分级测试，重新推荐起点级别")
        .addButton((btn) =>
          btn.setButtonText("重新测试").onClick(async () => {
            this.plugin.settings.placementDone = false;
            await this.plugin.saveSettings();
            await this.plugin.activateView();
            // Re-render any already-open views so the test shows immediately.
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NATIVE)) {
              const view = leaf.view;
              if (view instanceof NativeView) view.refresh();
            }
            new Notice("已打开分级测试");
          })
        );
    }
  }

  /** Editable daily-task list: rename / add / delete / reorder + reset. */
  private renderTaskSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("每日任务").setHeading();
    containerEl.createEl("p", {
      cls: "native-setting-status",
      text: "自定义每天打卡的任务清单（含「导入单词」「导入文章」会获得内联导入按钮）。",
    });

    const tasks = this.plugin.settings.tasks;
    const listEl = containerEl.createDiv({ cls: "native-task-edit-list" });

    // Structural changes (add/delete/reorder) re-render the whole panel so the
    // rows, indices and disabled-states stay consistent.
    const commit = async (): Promise<void> => {
      await this.plugin.saveSettings();
      this.display();
    };

    tasks.forEach((label, idx) => {
      const row = new Setting(listEl).addText((text) =>
        text.setValue(label).onChange(async (value) => {
          this.plugin.settings.tasks[idx] = value;
          await this.plugin.saveSettings();
        })
      );
      row.addExtraButton((b) =>
        b
          .setIcon("arrow-up")
          .setTooltip("上移")
          .setDisabled(idx === 0)
          .onClick(() => {
            if (idx === 0) return;
            [tasks[idx - 1], tasks[idx]] = [tasks[idx], tasks[idx - 1]];
            void commit();
          })
      );
      row.addExtraButton((b) =>
        b
          .setIcon("arrow-down")
          .setTooltip("下移")
          .setDisabled(idx === tasks.length - 1)
          .onClick(() => {
            if (idx === tasks.length - 1) return;
            [tasks[idx + 1], tasks[idx]] = [tasks[idx], tasks[idx + 1]];
            void commit();
          })
      );
      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("删除")
          .onClick(() => {
            if (tasks.length <= 1) {
              new Notice("至少保留一个任务");
              return;
            }
            tasks.splice(idx, 1);
            void commit();
          })
      );
    });

    const actions = containerEl.createDiv({ cls: "native-task-edit-actions" });
    const addBtn = actions.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "＋ 添加任务",
    });
    addBtn.addEventListener("click", () => {
      tasks.push("新任务");
      void commit();
    });
    const resetBtn = actions.createEl("button", {
      cls: "native-btn native-btn-ghost",
      text: "恢复默认",
    });
    resetBtn.addEventListener("click", () => {
      this.plugin.settings.tasks = defaultTasks(
        this.plugin.settings.newPerDay,
        this.plugin.settings.articlesPerDay
      );
      void commit();
    });
  }
}
