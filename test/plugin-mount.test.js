/**
 * host 半的整合測試：用「鏡像真實 cordis 介面」的假 ctx 跑完整掛載
 * （route 註冊 → 收 payload → pre-step 注入 → 清空），不必開實例、不必呼叫模型。
 *
 * 這是 dsh-model-refresh 已固化的做法：真機驗證貴，先用假 ctx 把邏輯釘死，
 * 再另外對真實例做端到端（見 acceptance 紀錄）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { apply, inject } from "../index.js";

/** 只提供本插件用到的介面：connection.fetch.register / on / effect。 */
function makeCtx() {
  const routes = new Map();
  const listeners = new Map();
  const effects = [];
  return {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => {
            routes.delete(route.path);
          };
        },
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    effect(callback) {
      effects.push(callback);
    },
    routes,
    listeners,
    effects,
  };
}

function postRoute(route, body) {
  return route.fetch(
    new Request(`http://127.0.0.1/api/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

/** 模擬 agent/pre-step 的呼叫：回傳最後一個 listener 的結果。 */
async function runPreStep(ctx, agentId, messages = [{ role: "user", id: "m1", content: [] }]) {
  const list = ctx.listeners.get("agent/pre-step") ?? [];
  assert.ok(list.length > 0, "應該註冊了 agent/pre-step 監聽器");
  return list[list.length - 1]({ agent: { id: agentId } }, async () => ({ kind: "enter", messages }));
}

test("host 半：inject 宣告了 connection（否則 apply 當下拿不到服務）", () => {
  assert.deepEqual(inject, ["connection"]);
});

test("apply：註冊 route 與 pre-step 監聽器", () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(ctx.routes.has("/api/dsh-quote-note/pending"), "route 應已註冊");
  const route = ctx.routes.get("/api/dsh-quote-note/pending");
  assert.deepEqual(route.methods, ["POST"]);
  assert.equal(route.requestBody, "buffered");
  assert.equal(ctx.listeners.get("agent/pre-step")?.length, 1);
  assert.equal(ctx.effects.length, 1, "route disposer 應掛在 effect 上");
});

test("route：合法 payload → 200 並回報筆數", async () => {
  const ctx = makeCtx();
  apply(ctx);
  const res = await postRoute(ctx.routes.get("/api/dsh-quote-note/pending"), {
    sessionId: "session-1",
    items: [{ quote: "原文", note: "想法" }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, sessionId: "session-1", count: 1 });
});

test("route：壞 payload 分別以 400／422 拒收", async () => {
  const ctx = makeCtx();
  apply(ctx);
  const route = ctx.routes.get("/api/dsh-quote-note/pending");

  assert.equal((await postRoute(route, "not json at all")).status, 400);
  assert.equal((await postRoute(route, { items: [] })).status, 422);
  assert.equal((await postRoute(route, { sessionId: "s", items: [{ quote: " " }] })).status, 422);
});

test("pre-step：有 pending → 注入一條 user 訊息，且原本的訊息保留在後面", async () => {
  const ctx = makeCtx();
  apply(ctx);
  await postRoute(ctx.routes.get("/api/dsh-quote-note/pending"), {
    sessionId: "session-A",
    items: [{ quote: "被反白的原文", note: "我的想法" }],
  });

  const original = [
    { role: "user", id: "m1", content: [] },
    { role: "assistant", id: "m2", content: [] },
  ];
  const decision = await runPreStep(ctx, "session-A", original);

  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, original.length + 1, "應多出一條訊息");
  assert.deepEqual(decision.messages.slice(0, original.length), original, "原本的訊息不該被動到");

  const injected = decision.messages[decision.messages.length - 1];
  assert.equal(injected.role, "user");
  assert.equal(typeof injected.id, "string");
  assert.equal(injected.source.kind, "dsh-quote-note");
  assert.equal(injected.source.form, "notice");
  const text = injected.content[0].text;
  assert.match(text, /> 被反白的原文/);
  assert.match(text, /我的想法/);
});

test("pre-step：注入後清空 —— 同一 session 第二次不會再注入", async () => {
  const ctx = makeCtx();
  apply(ctx);
  await postRoute(ctx.routes.get("/api/dsh-quote-note/pending"), {
    sessionId: "session-B",
    items: [{ quote: "q", note: "n" }],
  });

  const first = await runPreStep(ctx, "session-B");
  assert.equal(first.messages.length, 2, "第一次應注入");

  const second = await runPreStep(ctx, "session-B");
  assert.equal(second.messages.length, 1, "第二次不該再注入");
});

test("pre-step：別的 session 的 pending 不會被用到", async () => {
  const ctx = makeCtx();
  apply(ctx);
  await postRoute(ctx.routes.get("/api/dsh-quote-note/pending"), {
    sessionId: "session-C",
    items: [{ quote: "q", note: "n" }],
  });
  const decision = await runPreStep(ctx, "session-OTHER");
  assert.equal(decision.messages.length, 1);
});

test("pre-step：空陣列＝清空該 session（送空清單後不再注入）", async () => {
  const ctx = makeCtx();
  apply(ctx);
  const route = ctx.routes.get("/api/dsh-quote-note/pending");
  await postRoute(route, { sessionId: "session-D", items: [{ quote: "q", note: "n" }] });
  await postRoute(route, { sessionId: "session-D", items: [] });

  const decision = await runPreStep(ctx, "session-D");
  assert.equal(decision.messages.length, 1, "清空後不該注入");
});

test("pre-step：下游回 reject 時原樣回傳（不注入）", async () => {
  const ctx = makeCtx();
  apply(ctx);
  await postRoute(ctx.routes.get("/api/dsh-quote-note/pending"), {
    sessionId: "session-E",
    items: [{ quote: "q", note: "n" }],
  });
  const list = ctx.listeners.get("agent/pre-step");
  const decision = await list[0]({ agent: { id: "session-E" } }, async () => ({ kind: "reject" }));
  assert.deepEqual(decision, { kind: "reject" });
});

test("pre-step：沒有 pending 時不注入，也不消耗官方工廠", async () => {
  const ctx = makeCtx();
  apply(ctx);
  const decision = await runPreStep(ctx, "session-NONE");
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.kind, "enter");
});

test("pre-step：多次注入是「附加」而不是取代（每次都多一條）", async () => {
  const ctx = makeCtx();
  apply(ctx);
  const route = ctx.routes.get("/api/dsh-quote-note/pending");
  await postRoute(route, { sessionId: "session-F", items: [{ quote: "q1", note: "" }] });
  const d1 = await runPreStep(ctx, "session-F");
  await postRoute(route, { sessionId: "session-F", items: [{ quote: "q2", note: "" }] });
  const d2 = await runPreStep(ctx, "session-F", d1.messages);
  assert.equal(d2.messages.length, d1.messages.length + 1);
  assert.match(d2.messages[d2.messages.length - 1].content[0].text, /q2/);
});
