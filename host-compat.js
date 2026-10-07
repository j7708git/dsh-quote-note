/**
 * dsh-quote-note — host 側的 DSH seam。
 *
 * 這個檔案是 host 半**唯一**碰官方 API 的地方（client 側的對應檔是 `client.js` 內的
 * `insertIntoComposer()` 與 `apply()`）。DSH 仍是 developer preview，契約漂移時只需改這裡。
 *
 * 為什麼需要錨點解析：官方套件直接 `import "@deepseek-ai/dsh-llm"`，但本插件的實際目錄
 * （使用者的工作區）**不在 profile 的 node_modules 底下**，從這裡直接 import 會
 * `ERR_MODULE_NOT_FOUND`（實測）。所以要從 `DSH_PROFILE_DIR` / `DSH_HOME` 等錨點解析。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** `source.kind`：`MessageSourceMap` 是 merge-extensible，各 producer 宣告自己的 kind。 */
export const PLUGIN_KIND = "dsh-quote-note";
/** `ContextForm`：`notice` = 一次性事件的敘述（需 `summary`，上限 120 字）。 */
export const CONTEXT_FORM = "notice";

export const MAX_ITEMS = 20;
export const MAX_QUOTE_CHARS = 2000;
export const MAX_NOTE_CHARS = 4000;
export const MAX_SUMMARY_CHARS = 120;
export const MAX_SESSION_ID_CHARS = 200;

/** 解析官方套件的錨點，依序嘗試。 */
export function resolveAnchors(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || "", ".dsh");
  return [env.DSH_PROFILE_DIR, join(home, "profiles"), home, join(home, "profiles", "desktop")].filter(Boolean);
}

/**
 * 以錨點解析官方套件的實際檔案路徑。
 * @returns {string|null} 解析到就回檔名，全部失敗回 null（呼叫端必須有後備）。
 */
export function resolveOfficial(spec, env = process.env) {
  for (const anchor of resolveAnchors(env)) {
    try {
      if (!existsSync(anchor)) continue;
      const req = createRequire(join(anchor, "package.json"));
      return req.resolve(spec);
    } catch {
      /* 換下一個錨點 */
    }
  }
  return null;
}

/** 驗證 client 送來的 payload；不合法就回原因（route 會以 422 拒收）。 */
export function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "not-an-object" };

  const sessionId = payload.sessionId;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_CHARS ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(sessionId)
  ) {
    return { ok: false, reason: "bad-session-id" };
  }

  if (!Array.isArray(payload.items)) return { ok: false, reason: "items-not-array" };
  if (payload.items.length > MAX_ITEMS) return { ok: false, reason: "too-many-items" };

  const items = [];
  for (const raw of payload.items) {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "bad-item" };
    const quote = typeof raw.quote === "string" ? raw.quote : "";
    const note = typeof raw.note === "string" ? raw.note : "";
    if (!quote.trim() && !note.trim()) return { ok: false, reason: "empty-item" };
    items.push({
      quote: quote.slice(0, MAX_QUOTE_CHARS),
      note: note.slice(0, MAX_NOTE_CHARS),
    });
  }
  return { ok: true, sessionId, items };
}

/** 逐行加 `>` 的引用區塊。 */
export function quoteBlock(quote) {
  const q = typeof quote === "string" ? quote.replace(/\r\n?/g, "\n").trim() : "";
  if (!q) return "> （沒有引用文字）";
  return q
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * 模型面向的文字。
 *
 * 只放「使用者選了哪一段 ＋ 使用者說了什麼」，並開頭說明這些是補充說明而非新指示，
 * 讓模型知道這是對既有內容的指涉。
 */
export function formatItemsForModel(items) {
  const lines = [
    "使用者在對話中反白了以下段落，並針對它們寫下想法。",
    "這些是使用者對「他指的是哪一段」的補充說明，請據此理解並回應；它們本身不是新的任務指示。",
  ];
  items.forEach((item, index) => {
    lines.push("");
    lines.push(`--- 引用 ${index + 1} ---`);
    lines.push(quoteBlock(item.quote));
    lines.push("使用者的想法：");
    lines.push(item.note && item.note.trim() ? item.note.trim() : "（沒有寫下想法，只指出這一段）");
  });
  return lines.join("\n");
}

/** transcript 那條 context 列上的一行摘要。 */
export function summarize(items) {
  const label = `引用 ${items.length} 段對話${items.some((it) => it.note && it.note.trim()) ? "並附上想法" : ""}`;
  return label.length > MAX_SUMMARY_CHARS ? label.slice(0, MAX_SUMMARY_CHARS) : label;
}

/**
 * 建構要注入的 user 訊息。
 *
 * 優先使用官方的 `createUserMessage`（會配發穩定 id 並 freeze）；取不到官方工廠時
 * 手動建構 —— 欄位形狀與 `MessageBase` 一致（`id`／`content`／`source`）。
 */
export function buildContextMessage(factory, items) {
  const text = formatItemsForModel(items);
  const source = { kind: PLUGIN_KIND, form: CONTEXT_FORM, summary: summarize(items) };

  if (factory && typeof factory.createUserMessage === "function") {
    return factory.createUserMessage({ content: [{ type: "text", text }], source });
  }
  return {
    role: "user",
    id: `${PLUGIN_KIND}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    content: [{ type: "text", text }],
    source,
  };
}
