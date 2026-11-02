import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(`${root}/main.ts`, "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
assert.equal(ast.parseDiagnostics.length, 0);
const helper = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleUiTask",
);
assert.ok(helper);
const helperJs = ts.transpileModule(helper.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2018 },
}).outputText;

function uiHarness() {
  const errors = [];
  const notices = [];
  const wrap = runInNewContext(`${helperJs}\nhandleUiTask;`, {
    console: { error: (...args) => errors.push(args) },
    Notice: function Notice(message) { notices.push(message); },
  });
  return { wrap, errors, notices };
}

test("async UI callback returns void and preserves argument and execution order", async () => {
  const { wrap, errors, notices } = uiHarness();
  const calls = [];
  const argument = { value: "日语" };
  const callback = wrap(async (name, event) => {
    calls.push(["before", name, event]);
    await Promise.resolve();
    calls.push(["after", name, event]);
  });
  assert.equal(callback("N3", argument), undefined);
  assert.deepEqual(calls, [["before", "N3", argument]]);
  await nextTurn();
  assert.deepEqual(calls, [
    ["before", "N3", argument], ["after", "N3", argument],
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, []);
});

test("a rejected UI action is caught and reported once", async () => {
  const { wrap, errors, notices } = uiHarness();
  const failure = new Error("test-only persistence failure");
  const callback = wrap(async () => { throw failure; });
  assert.equal(callback(), undefined);
  await nextTurn();
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], failure);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /操作未完成/);
});

test("a synchronously throwing UI action is also caught", async () => {
  const { wrap, errors, notices } = uiHarness();
  const failure = new Error("test-only synchronous failure");
  const callback = wrap(() => { throw failure; });
  assert.doesNotThrow(() => callback());
  await nextTurn();
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], failure);
  assert.equal(notices.length, 1);
});

test("DOM listeners do not directly receive async callbacks", () => {
  let adaptedActions = 0;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "handleUiTask") {
        adaptedActions += 1;
      }
      if (ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "addEventListener") {
        const listener = node.arguments[1];
        if (listener && (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))) {
          assert.equal(
            listener.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
            false,
            `Unhandled async listener at ${ast.getLineAndCharacterOfPosition(listener.pos).line + 1}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  // Ten DOM listeners and the AddLanguageModal callback use the adapter.
  assert.equal(adaptedActions, 11);
});

test("onunload synchronously stops speech, and activateView awaits revealLeaf", () => {
  const plugin = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "NativePlugin",
  );
  assert.ok(plugin);
  const unload = plugin.members.find((node) => node.name?.getText(ast) === "onunload");
  assert.ok(unload && ts.isMethodDeclaration(unload));
  assert.equal(unload.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
  assert.equal(unload.body.statements.length, 1);
  assert.equal(unload.body.statements[0].getText(ast), "this.offlineTts.stop();");
  const activate = plugin.members.find((node) => node.name?.getText(ast) === "activateView");
  assert.ok(activate && ts.isMethodDeclaration(activate));
  assert.match(activate.getText(ast), /await workspace\.revealLeaf\(leaf\)/);
});

test("filename character sanitizing matches the pre-cleanup regex for every UTF-16 code unit", () => {
  const literals = [];
  function visit(node) {
    if (ts.isRegularExpressionLiteral(node) && node.text === String.raw`/[\\/:*?"<>|#[\]^]/g`) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(literals.length, 2, "both Japanese and Korean title sanitizers must remain present");
  const before = new RegExp(String.raw`[\\/:*?"<>|#\[\]\^]`, "g");
  for (const literal of literals) {
    const after = new RegExp(literal.slice(1, -2), "g");
    for (let code = 0; code <= 0xffff; code += 1) {
      const value = String.fromCharCode(code);
      assert.equal(value.replace(after, "-"), value.replace(before, "-"), `code unit ${code}`);
    }
  }
});

test("Markdown rendering uses a modal-scoped child component that is removed on close", () => {
  const modal = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "DayModal",
  );
  assert.ok(modal);
  const member = (name) => modal.members.find((node) => node.name?.getText(ast) === name);
  assert.match(member("markdownComponent").getText(ast), /new Component\(\)/);
  assert.match(member("onOpen").getText(ast), /this\.plugin\.addChild\(this\.markdownComponent\)/);
  assert.match(member("onClose").getText(ast), /this\.plugin\.removeChild\(this\.markdownComponent\)/);
  let renderCalls = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "MarkdownRenderer.render") {
      renderCalls += 1;
      assert.equal(node.arguments[4].getText(ast), "this.markdownComponent");
    }
    ts.forEachChild(node, visit);
  }
  visit(modal);
  assert.equal(renderCalls, 1);
});

test("opening and closing the modal registers and releases its Markdown component", async () => {
  const modalClass = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "DayModal",
  );
  const javascript = ts.transpileModule(modalClass.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2018 },
  }).outputText;
  const children = new Set();
  let emptyCalls = 0;
  const element = {
    addClass() {},
    createEl() { return element; },
    createDiv() { return element; },
    empty() { emptyCalls += 1; },
  };
  class ComponentFixture {
    loaded = false;
    unloadCalls = 0;
    load() { this.loaded = true; }
    unload() { this.loaded = false; this.unloadCalls += 1; }
  }
  class ModalFixture {
    contentEl = element;
    modalEl = element;
  }
  const ModalUnderTest = runInNewContext(`${javascript}\nDayModal;`, {
    Modal: ModalFixture,
    Component: ComponentFixture,
  });
  const plugin = {
    settings: { currentLanguage: "日语", tasks: [] },
    getDay() { return []; },
    async primeVocab() {},
    addChild(component) { children.add(component); component.load(); },
    removeChild(component) { children.delete(component); component.unload(); },
  };
  const modal = new ModalUnderTest({}, plugin, "2026-11-02", () => {});
  for (const name of ["renderWords", "renderReading", "renderDayWriting", "renderDayNote", "refreshTaskBars"]) {
    modal[name] = () => {};
  }
  modal.onOpen();
  assert.equal(children.size, 1);
  const [component] = children;
  assert.equal(component.loaded, true);
  await nextTurn();
  modal.onClose();
  assert.equal(children.size, 0);
  assert.equal(component.loaded, false);
  assert.equal(component.unloadCalls, 1);
  assert.equal(emptyCalls, 1);
});
