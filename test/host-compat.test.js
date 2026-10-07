/**
 * host 半純函式的單元測試（不碰真實 ctx、不起實例）。
 * 真機行為（route、pre-step 注入）由 acceptance 紀錄裡的實測涵蓋。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_FORM,
  MAX_ITEMS,
  PLUGIN_KIND,
  buildContextMessage,
  formatItemsForModel,
  quoteBlock,
  resolveAnchors,
  resolveOfficial,
  summarize,
  validatePayload,
} from "../host-compat.js";

/* ── validatePayload ──────────────────────────────────────────────────── */

test("validatePayload：合法 payload", () => {
  const r = validatePayload({ sessionId: "session-abc", items: [{ quote: "原文", note: "想法" }] });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, "session-abc");
  assert.deepEqual(r.items, [{ quote: "原文", note: "想法" }]);
});

test("validatePayload：空陣列合法（＝清空該 session）", () => {
  const r = validatePayload({ sessionId: "session-abc", items: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, []);
});

test("validatePayload：拒絕壞 sessionId", () => {
  for (const sessionId of [undefined, null, "", 42, "x".repeat(201), "bad\u0000id", "bad\nid"]) {
    const r = validatePayload({ sessionId, items: [] });
    assert.equal(r.ok, false, `應拒絕：${JSON.stringify(sessionId)}`);
    assert.equal(r.reason, "bad-session-id");
  }
});

test("validatePayload：拒絕非物件／items 非陣列／過多／壞項／空項", () => {
  assert.equal(validatePayload(null).reason, "not-an-object");
  assert.equal(validatePayload("x").reason, "not-an-object");
  assert.equal(validatePayload({ sessionId: "s" }).reason, "items-not-array");
  assert.equal(validatePayload({ sessionId: "s", items: new Array(MAX_ITEMS + 1).fill({ quote: "a" }) }).reason, "too-many-items");
  assert.equal(validatePayload({ sessionId: "s", items: [null] }).reason, "bad-item");
  assert.equal(validatePayload({ sessionId: "s", items: [{ quote: "   ", note: "\n" }] }).reason, "empty-item");
});

test("validatePayload：超長內容會被截斷而不是拒收", () => {
  const r = validatePayload({ sessionId: "s", items: [{ quote: "x".repeat(5000), note: "y".repeat(9000) }] });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].quote.length, 2000);
  assert.equal(r.items[0].note.length, 4000);
});

/* ── 模型面向的文字 ───────────────────────────────────────────────────── */

test("quoteBlock：逐行加 > 且保留空行", () => {
  assert.equal(quoteBlock("第一行\n第二行"), "> 第一行\n> 第二行");
  assert.equal(quoteBlock("第一行\n\n第三行"), "> 第一行\n>\n> 第三行");
  assert.equal(quoteBlock("   "), "> （沒有引用文字）");
  assert.equal(quoteBlock(undefined), "> （沒有引用文字）");
});

test("formatItemsForModel：編號分段、含引用與想法、且說明不是新指示", () => {
  const text = formatItemsForModel([
    { quote: "原文一", note: "想法一" },
    { quote: "原文二", note: "" },
  ]);
  assert.match(text, /補充說明/);
  assert.match(text, /不是新的任務指示/);
  assert.match(text, /--- 引用 1 ---/);
  assert.match(text, /--- 引用 2 ---/);
  assert.match(text, /> 原文一/);
  assert.match(text, /想法一/);
  assert.match(text, /（沒有寫下想法，只指出這一段）/);
});

test("summarize：帶則數，且標示有無想法；長度受限", () => {
  assert.equal(summarize([{ quote: "a", note: "n" }]), "引用 1 段對話並附上想法");
  assert.equal(summarize([{ quote: "a", note: "  " }]), "引用 1 段對話");
  assert.equal(summarize([{ quote: "a", note: "" }, { quote: "b", note: "" }]), "引用 2 段對話");
  assert.ok(summarize(new Array(20).fill({ quote: "a", note: "n" })).length <= 120);
});

/* ── 注入訊息 ─────────────────────────────────────────────────────────── */

test("buildContextMessage：優先用官方 createUserMessage", () => {
  const seen = [];
  const factory = {
    createUserMessage(input) {
      seen.push(input);
      return { ...input, role: "user", id: "official-id" };
    },
  };
  const message = buildContextMessage(factory, [{ quote: "q", note: "n" }]);
  assert.equal(message.id, "official-id");
  assert.equal(message.role, "user");
  assert.equal(seen.length, 1, "官方工廠應被呼叫一次");
  assert.equal(seen[0].content[0].type, "text");
  assert.equal(seen[0].source.kind, PLUGIN_KIND);
  assert.equal(seen[0].source.form, CONTEXT_FORM);
});

test("buildContextMessage：取不到官方工廠時手動建構，欄位形狀仍符合 MessageBase", () => {
  const message = buildContextMessage(null, [{ quote: "q", note: "n" }]);
  assert.equal(message.role, "user");
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 0);
  assert.equal(Array.isArray(message.content), true);
  assert.equal(message.content[0].type, "text");
  assert.equal(message.source.kind, PLUGIN_KIND);
  assert.equal(message.source.form, CONTEXT_FORM);
  assert.match(message.content[0].text, /q/);
});

test("buildContextMessage：兩次手動建構的 id 不同（避免身分碰撞）", () => {
  const a = buildContextMessage(null, [{ quote: "q", note: "" }]);
  const b = buildContextMessage(null, [{ quote: "q", note: "" }]);
  assert.notEqual(a.id, b.id);
});

/* ── 錨點解析 ─────────────────────────────────────────────────────────── */

test("resolveAnchors：依 DSH_PROFILE_DIR / DSH_HOME 產生錨點", () => {
  const anchors = resolveAnchors({ DSH_PROFILE_DIR: join("/p", "desktop"), DSH_HOME: "/p", HOME: join("/home", "u") });
  assert.equal(anchors[0], join("/p", "desktop"));
  assert.ok(anchors.includes(join("/p", "profiles")), `應含 profiles 錨點：${JSON.stringify(anchors)}`);
  assert.ok(anchors.includes("/p"));
  assert.ok(anchors.includes(join("/p", "profiles", "desktop")));
});

test("resolveAnchors：沒有 DSH_HOME 時退回 HOME/.dsh", () => {
  const anchors = resolveAnchors({ HOME: join("/home", "u") });
  assert.ok(anchors.includes(join(join("/home", "u"), ".dsh", "profiles")));
});

test("resolveOfficial：全部錨點都解析不到時回 null（呼叫端必須有後備）", () => {
  const env = { DSH_PROFILE_DIR: "/nonexistent-a", DSH_HOME: "/nonexistent-b", HOME: "/nonexistent-c" };
  assert.equal(resolveOfficial("@deepseek-ai/dsh-llm", env), null);
});
