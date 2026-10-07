/**
 * dsh-quote-note 單元測試：直接載入 client.js（lazy-CJS 信封）測純函式。
 * 跑法：node --test test/
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadClient } from "../tools/load-client.mjs";

const { id, exports: plugin } = loadClient();
const { normalizeQuote, formatQuoteBlock, composeDraftText, insertIntoComposer, previewText } = plugin.__pure;

test("信封：id 等於套件名，且匯出 apply/inject", () => {
  assert.equal(id, "dsh-quote-note");
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(plugin.inject, ["slots"]);
});

test("normalizeQuote：統一行尾、收斂空白、去頭尾空白行", () => {
  assert.equal(normalizeQuote("  a\r\n\r\n\r\n  b  \t c  "), "a\n\nb c");
  assert.equal(normalizeQuote("第一行\n   第二行"), "第一行\n第二行");
  assert.equal(normalizeQuote(undefined), "");
  assert.equal(normalizeQuote(42), "");
});

test("formatQuoteBlock：多行引用逐行加 '>'，並附上想法區塊", () => {
  const out = formatQuoteBlock("第一行\n第二行\n\n第四行", "這裡的推論我看不懂");
  assert.equal(
    out,
    "[引用你先前的回覆]\n> 第一行\n> 第二行\n>\n> 第四行\n\n[我對這段的想法]\n這裡的推論我看不懂"
  );
});

test("formatQuoteBlock：只有想法、沒有引用時仍可用", () => {
  assert.equal(formatQuoteBlock("", "只寫想法"), "[引用你先前的回覆]\n>\n\n[我對這段的想法]\n只寫想法");
});

test("formatQuoteBlock：兩邊都空 → 空字串（呼叫端據此拒絕）", () => {
  assert.equal(formatQuoteBlock("", ""), "");
  assert.equal(formatQuoteBlock("   \n  ", undefined), "");
});

test("formatQuoteBlock：超長引用會截斷並標示", () => {
  const out = formatQuoteBlock("x".repeat(2500), "n");
  assert.match(out, /引用過長，已截斷/);
  assert.ok(out.length < 2500, "截斷後不應仍帶著超長內容");
});

test("composeDraftText：不覆蓋已打的字，接在後面", () => {
  assert.equal(composeDraftText("我先打的問題", "區塊"), "我先打的問題\n\n區塊");
  assert.equal(composeDraftText("先打的   \n", "區塊"), "先打的\n\n區塊");
  assert.equal(composeDraftText("", "區塊"), "區塊");
  assert.equal(composeDraftText("   ", "區塊"), "區塊");
  assert.equal(composeDraftText("原稿", ""), "原稿");
});

test("previewText：chip 標籤取前 14 字並收斂換行", () => {
  assert.equal(previewText("短句"), "短句");
  assert.equal(previewText("多行\n引用"), "多行 引用");
  assert.equal(previewText("這是一段很長的引用文字內容測試用"), "這是一段很長的引用文字內容測…");
  assert.equal(previewText(""), "");
});

/* ── 寫入 composer 的兩條路 ─────────────────────────────────────────────── */

function fakeInputActions(overrides = {}) {
  const calls = { captureInsertion: 0, insertText: [], setDraft: [] };
  const ia = {
    state: { getSnapshot: () => ({ draft: "使用者原本打的字" }) },
    captureInsertion() {
      calls.captureInsertion += 1;
      return { start: 0, end: 0, draftRev: 7 };
    },
    insertText(text, span) {
      calls.insertText.push([text, span]);
      return true;
    },
    setDraft(text) {
      calls.setDraft.push(text);
    },
    ...overrides,
  };
  return { ia, calls };
}

test("insertIntoComposer：首選 caret 錨定的 insertText", () => {
  const { ia, calls } = fakeInputActions();
  assert.deepEqual(insertIntoComposer(ia, "區塊"), { ok: true, via: "insertText" });
  assert.equal(calls.insertText.length, 1);
  assert.deepEqual(calls.insertText[0][0], "區塊");
  assert.deepEqual(calls.insertText[0][1], { start: 0, end: 0, draftRev: 7 });
  assert.equal(calls.setDraft.length, 0, "成功時不應再走 setDraft");
});

test("insertIntoComposer：insertText 回 false → 退回整份草稿合併（保留原稿）", () => {
  const { ia, calls } = fakeInputActions({ insertText: () => false });
  assert.deepEqual(insertIntoComposer(ia, "區塊"), { ok: true, via: "setDraft" });
  assert.deepEqual(calls.setDraft, ["使用者原本打的字\n\n區塊"]);
});

test("insertIntoComposer：captureInsertion 丟錯 → 仍能退回 setDraft", () => {
  const { ia, calls } = fakeInputActions({
    captureInsertion() {
      throw new Error("contract drift");
    },
  });
  assert.deepEqual(insertIntoComposer(ia, "區塊"), { ok: true, via: "setDraft" });
  assert.equal(calls.setDraft.length, 1);
});

test("insertIntoComposer：沒有 inputActions → no-session", () => {
  assert.deepEqual(insertIntoComposer(null, "區塊"), { ok: false, reason: "no-session" });
});

test("insertIntoComposer：兩條路都沒有 → no-api", () => {
  assert.deepEqual(insertIntoComposer({ state: { getSnapshot: () => ({ draft: "" }) } }, "區塊"), {
    ok: false,
    reason: "no-api",
  });
});

test("insertIntoComposer：setDraft 丟錯 → 回報 threw 而不是假裝成功", () => {
  const ia = {
    state: { getSnapshot: () => ({ draft: "" }) },
    setDraft() {
      throw new Error("editor locked");
    },
  };
  const result = insertIntoComposer(ia, "區塊");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "threw");
  assert.match(result.detail, /editor locked/);
});
