/**
 * dsh-quote-note — host half。
 *
 * 職責只有兩件：
 *   1. 用一條**認證的 `/api` route** 收下 client 送來的「待送引用」（依 session 保管）。
 *   2. 在 `agent/pre-step`（官方 waterfall，語意就是「替換進入該 step 的訊息」）
 *      把引用注入成一條**額外的 user 訊息**，然後清空。
 *
 * 注入的訊息是 durable 的：它會成為 session log 裡的 `user/message` 事件，
 * transcript 也會以 context 列呈現（實測見 notes 的
 * `research/m7-context-chip-feasibility.md`）。
 *
 * 為什麼是這條路：client 端**沒有送出事件**，引用又刻意不放在草稿裡，
 * 所以只能在 host 的 pre-step 注入。官方 `dsh-session-reference` 用的是同一招。
 *
 * 為什麼要宣告 inject：`ctx.get('connection')` 在 `apply` 當下會拿到 `undefined`
 * （服務還沒被提供）—— 實測踩過。宣告 inject 後 cordis 會等到服務就緒才呼叫 apply。
 */
import { pathToFileURL } from "node:url";

import { buildContextMessage, PLUGIN_KIND, resolveOfficial, validatePayload } from "./host-compat.js";

export const inject = ["connection"];

const ROUTE = "/api/dsh-quote-note/pending";
const LLM_SPEC = "@deepseek-ai/dsh-llm";

/** @param {number} status @param {object} body */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function apply(ctx) {
  /** @type {Map<string, Array<{quote: string, note: string}>>} */
  const pending = new Map();
  /** 官方訊息工廠只解析一次（memoized）。 */
  let factoryPromise = null;

  function loadFactory() {
    if (factoryPromise === null) {
      factoryPromise = (async () => {
        const resolved = resolveOfficial(LLM_SPEC);
        if (resolved === null) {
          console.error(`[${PLUGIN_KIND}] 找不到 ${LLM_SPEC}；將以手動建構的訊息注入`);
          return null;
        }
        try {
          return await import(pathToFileURL(resolved).href);
        } catch (error) {
          console.error(`[${PLUGIN_KIND}] 載入 ${LLM_SPEC} 失敗：`, error);
          return null;
        }
      })();
    }
    return factoryPromise;
  }

  /* ── 1) client → host：認證的 /api route ─────────────────────────────── */

  const disposeRoute = ctx.connection.fetch.register({
    path: ROUTE,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      let payload;
      try {
        payload = JSON.parse(await request.text());
      } catch {
        return json(400, { ok: false, reason: "bad-json" });
      }
      const check = validatePayload(payload);
      if (!check.ok) return json(422, { ok: false, reason: check.reason });

      // replace 語意：每次送來的都是該 session 的完整現況（空陣列＝清空）。
      if (check.items.length === 0) pending.delete(check.sessionId);
      else pending.set(check.sessionId, check.items);

      return json(200, { ok: true, sessionId: check.sessionId, count: check.items.length });
    },
  });
  console.log(`[${PLUGIN_KIND}] route 已註冊：${ROUTE}`);

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      void disposeRoute();
    });
  }

  /* ── 2) 送出時注入 ──────────────────────────────────────────────────── */

  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter") return decision;

    const items = pending.get(agent.id);
    if (!items || items.length === 0) return decision;
    pending.delete(agent.id);

    const factory = await loadFactory();
    const message = buildContextMessage(factory, items);
    console.log(`[${PLUGIN_KIND}] 注入 ${items.length} 則引用到 ${agent.id}`);

    return {
      kind: "enter",
      messages: [...decision.messages, message],
      startsRequestSeries: decision.startsRequestSeries,
    };
  });
}
