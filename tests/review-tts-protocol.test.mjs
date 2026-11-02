import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Run only the guard, listeners and sender protocol with fake engines/PCM.
// No model is loaded, no resource is downloaded, and this is not an audible
// natural-speech quality or Obsidian/Electron integration test.
const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const engine = ast.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "OfflineTtsEngine",
);
assert.ok(engine);

function findNode(root, predicate) {
  if (predicate(root)) return root;
  let found;
  ts.forEachChild(root, (child) => {
    found ??= findNode(child, predicate);
    return found;
  });
  return found;
}

const guard = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "isTtsRunnerMessage",
);
assert.ok(guard);
const guardJs = ts.transpileModule(guard.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2018 },
}).outputText;
const isMessage = runInNewContext(`${guardJs}\nisTtsRunnerMessage;`, {
  ArrayBuffer,
  Float32Array,
});

const PROTOCOLS = [
  { source: "huanmuyu-tts", method: "ensureRunner", japanese: false },
  { source: "huanmuyu-japanese-tts", method: "ensureJapaneseRunner", japanese: true },
];

test("runner guard accepts both actual transferred-buffer protocols", () => {
  for (const protocol of PROTOCOLS) {
    const base = { source: protocol.source };
    assert.equal(isMessage({ ...base, type: "ready" }), true);
    assert.equal(isMessage({ ...base, type: "init-error" }), true);
    assert.equal(isMessage({ ...base, type: "init-error", error: "startup failed" }), true);
    assert.equal(isMessage({ ...base, type: "error", id: "request-1", error: "generation failed" }), true);
    const audio = structuredClone(new Float32Array([0.25, -0.5]).buffer);
    assert.equal(isMessage({ ...base, type: "audio", id: "request-1", audio, sampleRate: 24000 }), true);
  }
});

test("runner guard rejects malformed payloads instead of asserting their types", () => {
  const audio = new Float32Array([0.25]).buffer;
  const valid = { source: "huanmuyu-tts", type: "audio", id: "request-1", audio, sampleRate: 24000 };
  const invalid = [
    null, undefined, true, 7, "ready", [], {},
    { source: "other-frame", type: "ready" },
    { source: "huanmuyu-tts", type: "unknown" },
    { source: "huanmuyu-tts", type: "init-error", error: {} },
    { source: "huanmuyu-tts", type: "error", id: "request-1" },
    { source: "huanmuyu-tts", type: "error", id: 1, error: "failed" },
    { ...valid, id: undefined },
    { ...valid, audio: new Float32Array([0.25]) },
    { ...valid, audio: { byteLength: 4 } },
    { ...valid, audio: new ArrayBuffer(3) },
    ...[undefined, "24000", NaN, Infinity, 0, -1].map((sampleRate) => ({ ...valid, sampleRate })),
  ];
  if (typeof SharedArrayBuffer === "function") invalid.push({ ...valid, audio: new SharedArrayBuffer(4) });
  for (const payload of invalid) assert.equal(isMessage(payload), false);
});

function makeListener(protocol) {
  const method = engine.members.find(
    (member) => ts.isMethodDeclaration(member) && member.name.getText(ast) === protocol.method,
  );
  const declaration = findNode(method, (node) =>
    ts.isVariableDeclaration(node) && node.name.getText(ast) === "onMessage");
  assert.ok(declaration?.initializer);
  const js = ts.transpileModule(`function attach() { return ${declaration.initializer.getText(ast)}; }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2018 },
  }).outputText;
  const state = { ready: 0, cleared: 0, initializationErrors: [] };
  const frameWindow = {};
  const owner = { runnerRequests: new Map() };
  const listener = runInNewContext(`${js}\nattach.call(owner);`, {
    owner,
    frame: { contentWindow: frameWindow },
    timeout: 17,
    window: { clearTimeout(id) { assert.equal(id, 17); state.cleared += 1; } },
    resolveReady() { state.ready += 1; },
    rejectReady(error) { state.initializationErrors.push(error.message); },
    isTtsRunnerMessage: isMessage,
  });
  return { listener, state, frameWindow, owner };
}

for (const protocol of PROTOCOLS) {
  test(`${protocol.source} listener preserves frame/source/request boundaries`, () => {
    const { listener, state, frameWindow, owner } = makeListener(protocol);
    const ready = { source: protocol.source, type: "ready" };
    const unreadable = new Proxy({}, { get() { throw new Error("wrong-frame payload was read"); } });
    listener({ source: {}, data: unreadable });
    listener({ source: frameWindow, data: { ...ready, source: "other-frame" } });
    listener({ source: frameWindow, data: { ...ready, source: protocol.japanese ? "huanmuyu-tts" : "huanmuyu-japanese-tts" } });
    assert.equal(state.ready, 0);
    listener({ source: frameWindow, data: ready });
    assert.equal(state.ready, 1);

    const resolved = [];
    const rejected = [];
    owner.runnerRequests.set("audio-1", { resolve(value) { resolved.push(value); } });
    const pcm = new Float32Array([0.25, -0.5]).buffer;
    const data = { source: protocol.source, type: "audio", id: "audio-1", audio: pcm, sampleRate: 24000 };
    listener({ source: frameWindow, data: { ...data, audio: new Float32Array([0.25]) } });
    assert.equal(owner.runnerRequests.has("audio-1"), true);
    listener({ source: frameWindow, data });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].audio, pcm);
    assert.equal(resolved[0].sampleRate, 24000);
    assert.equal(owner.runnerRequests.has("audio-1"), false);
    listener({ source: frameWindow, data });
    assert.equal(resolved.length, 1, "a settled request must not be resolved twice");

    owner.runnerRequests.set("error-1", { reject(error) { rejected.push(error.message); } });
    listener({ source: frameWindow, data: { source: protocol.source, type: "error", id: "error-1", error: "generation failed" } });
    assert.deepEqual(rejected, ["generation failed"]);
    assert.equal(owner.runnerRequests.has("error-1"), false);
    listener({ source: frameWindow, data: { source: protocol.source, type: "init-error" } });
    assert.equal(state.initializationErrors.length, 1);
    assert.match(state.initializationErrors[0], /语音引擎未能启动/);
  });
}

function senderScript(protocol) {
  const method = engine.members.find(
    (member) => ts.isMethodDeclaration(member) && member.name.getText(ast) === "startServer",
  );
  const templates = [];
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "html") templates.push(node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(method);
  assert.equal(templates.length, 2);
  const template = templates[protocol.japanese ? 1 : 0];
  const html = runInNewContext(`(${template.getText(ast)})`, {
    KOKORO_MODEL_ID: "onnx-community/Kokoro-82M-v1.0-ONNX",
  });
  let script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const parsed = ts.createSourceFile("sender.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0);
  // Replace imports only with injected fake engine APIs; do not load a model.
  for (const declaration of parsed.statements.filter(ts.isImportDeclaration).reverse()) {
    script = script.slice(0, declaration.pos) + script.slice(declaration.end);
  }
  return script;
}

for (const protocol of PROTOCOLS) {
  test(`${protocol.source} actual sender keeps PCM buffer, voice, request ID and transfer protocol`, async () => {
    const messages = [];
    const spoken = [];
    let synthesize;
    let fail = false;
    let markReady;
    const ready = new Promise((resolveReady) => { markReady = resolveReady; });
    const result = () => ({ audio: new Float32Array([0.25, -0.5]), sampling_rate: 24000 });
    const fakeEngine = {
      async generate(text, options) {
        if (fail) throw new Error("fake generation failed");
        spoken.push({ text, voice: options.voice, rate: options.speed });
        return result();
      },
      async speak(text, voice, rate) {
        if (fail) throw new Error("fake generation failed");
        spoken.push({ text, voice, rate });
        return result();
      },
    };
    runInNewContext(senderScript(protocol), {
      KokoroTTS: { async from_pretrained() { return fakeEngine; } },
      KokoroJP: { async load() { return fakeEngine; } },
      env: {},
      transformersEnv: {},
      location: { origin: "http://127.0.0.1:12345" },
      addEventListener(kind, callback) { assert.equal(kind, "message"); synthesize = callback; },
      parent: {
        postMessage(message, origin, transfer = []) {
          const cloned = structuredClone(message, { transfer });
          messages.push({ data: cloned, origin, transferCount: transfer.length });
          if (cloned.type === "ready" || cloned.type === "init-error") markReady();
        },
      },
    });
    await ready;
    assert.equal(messages[0].data.type, "ready");
    assert.equal(isMessage(messages[0].data), true);
    assert.equal(typeof synthesize, "function");
    await synthesize({ data: { source: protocol.source, type: "synthesize", id: "pcm-1", text: "sample", voice: "am_michael", rate: 1.1 } });
    const audio = messages.find((message) => message.data.type === "audio");
    assert.equal(audio.data.id, "pcm-1");
    assert.equal(audio.data.source, protocol.source);
    assert.equal(audio.origin, "*");
    assert.equal(audio.transferCount, 1);
    assert.ok(audio.data.audio instanceof ArrayBuffer);
    assert.deepEqual([...new Float32Array(audio.data.audio)], [0.25, -0.5]);
    assert.equal(audio.data.sampleRate, 24000);
    assert.equal(isMessage(audio.data), true);
    assert.deepEqual(spoken.at(-1), { text: "sample", voice: protocol.japanese ? "jf_gongitsune" : "am_michael", rate: 1.1 });
    fail = true;
    await synthesize({ data: { source: protocol.source, type: "synthesize", id: "failed-1", text: "sample", voice: "am_michael", rate: 1 } });
    const error = messages.at(-1).data;
    assert.equal(error.type, "error");
    assert.equal(error.id, "failed-1");
    assert.match(error.error, /fake generation failed/);
    assert.equal(isMessage(error), true);
  });
}
