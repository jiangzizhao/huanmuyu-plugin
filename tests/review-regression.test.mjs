import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Captured from the preserved, pre-review working copy on 2026-11-02.
// Only the two runner listeners and the equivalent voice-path string literal
// were re-reviewed for typed payload validation; their targeted hashes reflect
// that change. The remaining ten speech methods and bundled assets stay frozen.
// These fixed baselines intentionally need no other checkout or Git history.
// This suite parses source and checks bundled bytes; it does not start a model,
// import the Obsidian plugin, download resources, or prove audible playback.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = read("main.ts").toString("utf8");
const mainAst = ts.createSourceFile(
  "main.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
assert.equal(mainAst.parseDiagnostics.length, 0, "main.ts must parse");

const ACTIVE_TTS_METHOD_SHA256 = {
  pluginAssetRoot: "b07848c63e12cae777872fe348356f8e7cd17b887fd370e47a6f4159b5a7db5a",
  ensureAssets: "87255dc86ed0ea08c2d501df962991424573d1114c13062415ce43efc1432169",
  startServer: "a898c074f8cfdaf8f0dd69efc4bcc1ae26075278d9fbac838ab56b71e5c35467",
  ensureRunner: "62ea094edd5704ef6a867521263d4922f5e0d8b8d4327e0b5192c63875856a13",
  ensureJapaneseAssets: "d6dbbb91a8e7d49d128f540009f75dde97842b437ecef268d4f970719c20378e",
  ensureJapaneseRunner: "799f94f25182da19656284496ed68d71a1507da5da635a36afdd7ac004293471",
  ensureModel: "6ae8caa6892b590d2962426137ed839b325065e645f7c6a4ca21494146fbcc65",
  warmup: "1e30ff80f2948e21527ac6112b3bdc0a13a46d7722d2ef22bd82e28746f4b9ef",
  warmupJapanese: "c382b501c72b722e8e652fd4baf54b577c811a8c6416b7bffa921aee371420d9",
  synthesize: "c74b578af429c68ff887007d274420786bb68d699b602e5caf2a8f69e8d638d3",
  synthesizeJapanese: "e67b6c6e875b740d65c1a88734869e7cb669554e9fc83c6672f33815f6e9755a",
  wav: "4e77c033020115ccf9be8704b68ff18cab843874ee0ed3780ba3d4d563b2208d",
};

// The ONNX model itself is downloaded by the plugin and is not bundled here.
// Lock its existing configuration without fetching or executing that model.
const MODEL_CONFIGURATION_SHA256 = {
  KOKORO_MODEL_ID: "5e77e7e3e54ddf619cfa9a989f89ae1dd213f1cccab72a93d1760c38e1145fe1",
  KOKORO_VOICE_URL: "2c26a81c7b8d938280075341d463aafe67df73880735420bb410c40bdc6a3a16",
  KOKORO_MODEL_URL: "b6d96c34bb9687162fe54d0e725a90da5cad966f990e6c5160ce7f51cbc5e89a",
  KOKORO_MODEL_FILES: "85d54f96f9ee4844673df2d2457cb8377d97c284b9e54d19218f0dd13846bc05",
  KOKORO_LOCAL_VOICE_JS: "13690371afa51330100b2ce78e19c5c81fdebbdd61d850250f1a14b5275eb947",
  KOKORO_JP_LOCAL_WEB_JS: "b9e10a301fecb7320e4a321503cd190087e3a343d61e847aaa818a2b2de3ef81",
  OFFLINE_TTS_MIME: "8083f4ff9795e52e6f831278ab5fb42e91509b1f1d5fd17397d812cb8cff9b25",
  OFFLINE_TTS_ASSETS: "de0ed6908b844ddbcbcde17a7cbae778ad01f44f0d8468db40a895de68ed691f",
  JAPANESE_TTS_ASSET_BASE: "96d0d896a2bd67c7e3dc9fd4db480bcbeb6e8d5031c5e7f29bc2746432d7b40a",
  JAPANESE_TTS_DOWNLOADS: "7815f3626d879189c862ab21cb98bf6107232e50f247b46154de9e6f257d48f8",
};

const BUNDLED_ASSET_SHA256 = {
  "offline-tts/kokoro.web.js": "abd58b7c32e377a84c12ac32d912c0de3368a4d27fbda13022ddae43df057502",
  "offline-tts/kokoro-jp.web.js": "a68ed6c4dd7ac5ff10003fbc804ac115ab23043ec14012b479b4241af404ea2d",
  "offline-tts/ort/ort-wasm-simd-threaded.mjs": "43c25054b6b9ac000f786c65545ff83a45f871e0e310e8c2f4d48a363bb66db4",
  "offline-tts/ort/ort-wasm-simd-threaded.wasm": "f061472c6e77d6d50d079aacdc0ff9b63fee287ddd2cbf46cf62438d3891de2b",
  "offline-tts/voices/af_heart.bin": "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
  "offline-tts/voices/am_michael.bin": "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
  "offline-tts/voices/jf_gongitsune.bin": "0f1181f3772d27b7c12aaf4bcd71e31b186c4146e330d074a3dc64ee392af396",
};

const REVIEWED_JAPANESE_DATA_SHA256 = {
  "japanese-cards.ts": "e0cf6f3aa03c41057f5cdb7099c1274f2f6dc90c896cc9eff6d4b7e48709c014",
  "japanese-zh-cards.json": "19bec3a93b18abacf2db47d8769030a4583ad5843c7d490ef8c7f95d6188a22a",
  "japanese-direct-zh-review.json": "8ff501af936f31d413060a723c7df59774d96c9f0c576ffb019f72b56c7c3001",
};

function topLevelVariable(ast, name) {
  return ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText(ast) === name);
}

function ttsClass() {
  const declaration = mainAst.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "OfflineTtsEngine",
  );
  assert.ok(declaration, "OfflineTtsEngine must remain available");
  return declaration;
}

function dynamicFunctionCalls(ast) {
  const calls = [];
  const visit = (node) => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const target = node.expression;
      if (
        (ts.isIdentifier(target) && target.text === "Function") ||
        (ts.isPropertyAccessExpression(target) && target.name.text === "Function")
      ) {
        calls.push(node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return calls;
}

function runUuid(context) {
  const declaration = mainAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "uuid",
  );
  assert.ok(declaration, "uuid helper must remain available");
  const javascript = ts.transpileModule(declaration.getText(mainAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2018 },
  }).outputText;
  return runInNewContext(`${javascript}\nuuid();`, context, { timeout: 1000 });
}

function assertUuidFallback(context) {
  let randomCalls = 0;
  const value = runUuid({
    ...context,
    Math: { random: () => { randomCalls += 1; return 0.5; } },
  });
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(randomCalls, 31, "existing random fallback must still be used");
}

test("ten unchanged speech methods and two reviewed listeners retain their SHA256", () => {
  const methods = new Map(
    ttsClass().members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(mainAst), method]),
  );
  assert.equal(Object.keys(ACTIVE_TTS_METHOD_SHA256).length, 12);
  for (const [name, expected] of Object.entries(ACTIVE_TTS_METHOD_SHA256)) {
    const method = methods.get(name);
    assert.ok(method, `${name} must not be removed`);
    assert.equal(sha256(method.getText(mainAst)), expected, `${name} changed`);
  }
});

test("model paths, asset configuration and patch expressions remain unchanged", () => {
  for (const [name, expected] of Object.entries(MODEL_CONFIGURATION_SHA256)) {
    const declaration = topLevelVariable(mainAst, name);
    assert.ok(declaration, `${name} must remain available`);
    assert.equal(sha256(declaration.getText(mainAst)), expected, `${name} changed`);
  }
});

test("voice-path escape cleanup preserves the literal replacement value", () => {
  const declaration = topLevelVariable(mainAst, "KOKORO_LOCAL_VOICE_JS");
  const replacement = declaration.initializer.arguments[1];
  assert.ok(ts.isStringLiteral(replacement));
  assert.equal(replacement.text, "${globalThis.__HUANMUYU_TTS_BASE__}voices/${e}.bin");
  const search = declaration.initializer.arguments[0];
  assert.ok(ts.isTemplateExpression(search));
  assert.equal(search.templateSpans[0].literal.text, "${e}.bin");
});

test("bundled engines, ORT/WASM and all three voices retain their SHA256", () => {
  for (const [path, expected] of Object.entries(BUNDLED_ASSET_SHA256)) {
    assert.equal(sha256(read(path)), expected, `${path} changed`);
  }
});

test("actual dynamic Function calls and the unused classic-engine chain are absent", () => {
  assert.deepEqual(dynamicFunctionCalls(mainAst), []);
  const names = ttsClass().members.map((member) => member.name?.getText(mainAst));
  for (const name of ["module", "getTts", "initPromise", "ttsPromise"]) {
    assert.ok(!names.includes(name), `unused member ${name} returned`);
  }
  assert.equal(topLevelVariable(mainAst, "KOKORO_CLASSIC_SCRIPT"), undefined);
});

test("dynamic-call inspection ignores string literals, not executable AST nodes", () => {
  const quoted = ts.createSourceFile(
    "quoted.ts", 'const message = "new Function(\\\"return 1\\\")";', ts.ScriptTarget.Latest, true,
  );
  const executable = ts.createSourceFile(
    "executable.ts", 'const fn = new Function("return 1");', ts.ScriptTarget.Latest, true,
  );
  assert.equal(quoted.parseDiagnostics.length, 0);
  assert.equal(executable.parseDiagnostics.length, 0);
  assert.deepEqual(dynamicFunctionCalls(quoted), []);
  assert.equal(dynamicFunctionCalls(executable).length, 1);
});

test("UUID uses native crypto.randomUUID when available", () => {
  const expected = "12345678-1234-4123-8123-123456789abc";
  let calls = 0;
  const actual = runUuid({
    crypto: { randomUUID() { calls += 1; return expected; } },
    Math: { random() { throw new Error("native UUID must not use the fallback"); } },
  });
  assert.equal(actual, expected);
  assert.equal(calls, 1);
});

test("UUID preserves the existing fallback when crypto is absent", () => {
  assertUuidFallback({});
});

test("UUID preserves the existing fallback when crypto.randomUUID is absent", () => {
  assertUuidFallback({ crypto: {} });
});

test("reviewed Japanese data is preserved and スーツ means 西装, not 诉讼", () => {
  for (const [path, expected] of Object.entries(REVIEWED_JAPANESE_DATA_SHA256)) {
    assert.equal(sha256(read(path)), expected, `${path} differs from the reviewed data`);
  }
  const ast = ts.createSourceFile(
    "japanese-cards.ts", read("japanese-cards.ts").toString("utf8"), ts.ScriptTarget.Latest, true,
  );
  const declaration = topLevelVariable(ast, "JAPANESE_CARDS");
  assert.ok(declaration?.initializer, "bundled Japanese cards must remain available");
  assert.ok(ts.isObjectLiteralExpression(declaration.initializer));
  const cards = JSON.parse(declaration.initializer.getText(ast));
  assert.equal(Object.keys(cards).length, 8110);
  assert.match(cards["スーツ"]["翻译"], /西装/);
  assert.doesNotMatch(cards["スーツ"]["翻译"], /诉讼/);
});

test("plugin identity and desktop/runtime compatibility remain stable", () => {
  const manifest = JSON.parse(read("manifest.json").toString("utf8"));
  assert.equal(manifest.id, "huanmuyu");
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(manifest.minAppVersion, "1.4.0");
  // A future release can increase the version without changing this baseline.
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
