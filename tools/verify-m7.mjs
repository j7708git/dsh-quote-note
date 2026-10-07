/**
 * dsh-quote-note — M7 的真機驗證（headless Chromium + CDP）。
 *
 * 用法：node tools/verify-m7.mjs "<baseUrl含token>" [--edge <path>]
 *
 * 驗的是使用者指定的新 UX：
 *   1. client 半物化、三個 slot 都註冊、rail 有掛載、無錯誤
 *   2. 反白 → 浮動按鈕 → 面板 → 「加入引用」
 *   3. **chip 出現在輸入框外，而主輸入框保持空白**（這正是這個改動的目的）
 *   4. hover chip → 面板顯示「引用的原文 ＋ 我的想法」
 *   5. 編輯想法 → 儲存 → 值有留下
 *   6. 刪除 → chip 消失
 *
 * 只讀（＋在 headless 瀏覽器裡操作自己的頁面），不動任何檔案。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const edgeFlagIndex = args.indexOf("--edge");
const explicitBrowser = edgeFlagIndex >= 0 ? args[edgeFlagIndex + 1] : null;
const CDP_PORT = 9334;

const BROWSER_CANDIDATES = [
  process.env.QN_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const EDGE = explicitBrowser || BROWSER_CANDIDATES.find((c) => existsSync(c)) || null;

if (!target) {
  console.error('用法: node tools/verify-m7.mjs "<baseUrl含token>" [--edge <path>]');
  process.exit(2);
}
if (!EDGE) {
  console.error("找不到 Chromium 系瀏覽器；請用 --edge <path> 或 QN_BROWSER 指定。");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profileDir = mkdtempSync(join(tmpdir(), "qn-m7-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true }
);

let ws = null;
let msgId = 0;
const pending = new Map();
const consoleLines = [];

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;

function cleanup() {
  try {
    ws?.close();
  } catch {}
  try {
    browser.kill();
  } catch {}
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {}
}

async function waitFor(expression, label, attempts = 20, delay = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await evaluate(expression)) return true;
    await sleep(delay);
  }
  return false;
}

try {
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {}
    await sleep(500);
  }
  check("headless Chromium 與 CDP 就緒", Boolean(version), version?.["Browser"]);
  if (!version) throw new Error("CDP 未就緒");

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLines.push(
        `${msg.params.type}: ` +
          (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(" ")
      );
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: target });
  try {
    await send("Page.bringToFront");
  } catch {}

  const booted = await waitFor("document.body ? document.body.innerText.trim().length > 20 : false", "boot", 60, 1000);
  check("app 在真瀏覽器裡 boot 起來", booted);

  const applied = consoleLines.find((l) => l.includes("[dsh-quote-note] client half applied"));
  check("client 模組被物化", Boolean(applied), applied);
  const errors = consoleLines.filter((l) => l.includes("[dsh-quote-note]") && l.startsWith("error"));
  check("本插件沒有註冊錯誤", errors.length === 0, errors.join(" | ") || "無");

  const diag = await evaluate("window.__dshQuoteNote || null");
  const slotsOk =
    Boolean(diag?.applied) &&
    diag.inject.registered.includes("shell.overlay") &&
    diag.inject.registered.includes("conversation.input.right") &&
    diag.inject.registered.includes("conversation.input.dock");
  // rail 的掛載時機取決於 composer 的 session 何時就緒，所以等一下再判定（不是註冊失敗）。
  const railMounted = await waitFor("window.__dshQuoteNote && window.__dshQuoteNote.mounted.rail === 1", "rail-mount", 30, 500);
  const diag2 = await evaluate("window.__dshQuoteNote || null");
  check(
    "三個 slot 都註冊、rail 已掛載",
    slotsOk && railMounted,
    `registered=${JSON.stringify(diag2?.inject?.registered)} mounted=${JSON.stringify(diag2?.mounted)}`
  );

  check("初始沒有 chip（rail 不佔位）", (await evaluate(`!document.querySelector('[data-dsh-quote-note="rail"]')`)) === true);

  /* 反白 → 按鈕 */
  const makeSelection = `(() => {
    const bad = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],input,textarea';
    const trySelect = (el) => {
      try {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return s.toString();
      } catch { return ''; }
    };
    for (const el of Array.from(document.querySelectorAll('span,div,p,h1,h2,h3,code,a'))) {
      if (el.hasAttribute('data-dsh-quote-note') || el.querySelector('[data-dsh-quote-note]')) continue;
      if (el.closest(bad)) continue;
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim().length < 4) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      const got = trySelect(el);
      if (!got || !got.trim()) continue;
      document.dispatchEvent(new Event('selectionchange'));
      return { text: got, rect: { w: Math.round(rect.width), h: Math.round(rect.height) } };
    }
    return null;
  })()`;

  let selection = null;
  for (let i = 0; i < 20; i++) {
    selection = await evaluate(makeSelection);
    if (selection) break;
    await sleep(700);
  }
  check("頁面上找到可反白的文字", Boolean(selection), selection ? `「${String(selection.text).slice(0, 24)}」` : "找不到");

  const hasButton = await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="button"]'))`, "button", 15, 400);
  check("反白後浮出按鈕", hasButton);

  /* 點按鈕 → 面板 → 加入引用 */
  let panel = false;
  if (hasButton) {
    await evaluate(`document.querySelector('[data-dsh-quote-note="button"]').click()`);
    panel = await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="panel"]'))`, "panel", 15, 300);
  }
  check("點擊後想法輸入框出現", panel);

  const NOTE = "驗證用想法：這段請展開說明";
  if (panel) {
    await evaluate(`(() => {
      const ta = document.querySelector('[data-dsh-quote-note="textarea"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(NOTE)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    })()`);
    await sleep(200);
    await evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('[data-dsh-quote-note="panel"] button'));
      const b = btns.find((x) => (x.textContent || '').includes('加入引用'));
      if (b) b.click();
      return Boolean(b);
    })()`);
  }

  const chipAppeared = await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="rail"] [data-dsh-quote-note="chip"]'))`, "chip", 20, 300);
  check("chip 出現在輸入框外（rail）", chipAppeared);

  /* chip 要跟輸入框卡片對齊，不是貼在整條 dock 的最左邊（實際使用回報「位置有點怪」） */
  if (chipAppeared) {
    const align = await evaluate(`(() => {
      const rail = document.querySelector('[data-dsh-quote-note="rail"]');
      const ed = document.querySelector('[contenteditable="true"]');
      if (!rail || !ed) return null;
      return {
        railLeft: Math.round(rail.getBoundingClientRect().left),
        edLeft: Math.round(ed.getBoundingClientRect().left),
      };
    })()`);
    check(
      "chip rail 與輸入框對齊",
      Boolean(align) && Math.abs(align.railLeft - align.edLeft) <= 60,
      align ? `rail.left=${align.railLeft} editor.left=${align.edLeft}（差 ${Math.abs(align.railLeft - align.edLeft)}px）` : "量不到"
    );

    // 回答「跟任務清單（TodoDock）會不會重疊」：看 dock 容器的實際 flex 佈局與兄弟數量。
    const dockInfo = await evaluate(`(() => {
      const rail = document.querySelector('[data-dsh-quote-note="rail"]');
      if (!rail) return null;
      const chain = [];
      let p = rail.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        const cs = getComputedStyle(p);
        chain.push({
          tag: p.tagName,
          cls: String(p.className || '').slice(0, 30),
          display: cs.display,
          dir: cs.flexDirection,
          justify: cs.justifyContent,
          wrap: cs.flexWrap,
          children: p.children.length,
        });
      }
      return chain;
    })()`);
    console.log(`-- dock 容器鏈: ${JSON.stringify(dockInfo)}`);
  }

  /* 核心斷言：主輸入框保持空白 */
  const draft = await evaluate(`(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    return ed ? (ed.textContent || '') : null;
  })()`);
  check(
    "**主輸入框保持空白**（引用沒有跑進草稿）",
    draft !== null && draft.trim() === "",
    draft === null ? "找不到 composer 編輯器（無法判定）" : `draft=${JSON.stringify(draft)}`
  );

  /* 點 chip → 面板（刻意不做 hover：面板與 chip 之間的空隙會讓 hover 在使用者碰到
     面板前就觸發 mouseleave，實際使用回報過這個 bug） */
  let hoverPanel = false;
  let hoverVia = null;
  if (chipAppeared) {
    await evaluate(`document.querySelector('[data-dsh-quote-note="rail"] [data-dsh-quote-note="chip"]').click()`);
    hoverPanel = await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="chip-panel"]'))`, "click-panel", 15, 250);
    hoverVia = hoverPanel ? "click" : null;
  }
  check("點 chip 開啟面板", hoverPanel, hoverVia ? `經由 ${hoverVia}` : "沒開");

  const panelContent = hoverPanel
    ? await evaluate(`(() => {
        const p = document.querySelector('[data-dsh-quote-note="chip-panel"]');
        return { quote: (p.querySelector('[data-dsh-quote-note="chip-quote"]') || {}).textContent || '', note: (p.querySelector('[data-dsh-quote-note="chip-note"]') || {}).value || '' };
      })()`)
    : null;
  check(
    "面板顯示引用的原文與我的想法",
    Boolean(panelContent && panelContent.quote.trim() && panelContent.note === NOTE),
    panelContent ? `quote=${JSON.stringify(panelContent.quote.slice(0, 20))} note=${JSON.stringify(panelContent.note)}` : "無面板"
  );

  /* 編輯想法 → 儲存 */
  const EDITED = "改過的想法：請附上出處";
  let editOk = false;
  if (hoverPanel) {
    await evaluate(`(() => {
      const ta = document.querySelector('[data-dsh-quote-note="chip-note"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(EDITED)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const b = document.querySelector('[data-dsh-quote-note="chip-save"]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(700);
    editOk = (await evaluate(`window.__dshQuoteNote?.pending?.syncs > 0`)) === true;
  }
  check("編輯想法並儲存（有觸發同步）", editOk);

  const savedFeedback = await evaluate(
    `(() => { const el = document.querySelector('[data-dsh-quote-note="chip-saved"]'); return el ? el.textContent : null; })()`
  );
  check("儲存後有視覺回饋（已儲存）", Boolean(savedFeedback), savedFeedback ?? "沒有回饋元素");

  /* 刪除 → chip 消失 */
  let removed = false;
  if (hoverPanel) {
    await evaluate(`(() => {
      const b = document.querySelector('[data-dsh-quote-note="chip-remove"]');
      if (b) b.click();
      return true;
    })()`);
    removed = await waitFor(`!document.querySelector('[data-dsh-quote-note="rail"]')`, "removed", 15, 300);
  }
  check("刪除後 chip 消失、rail 不再佔位", removed);

  const finalDiag = await evaluate("window.__dshQuoteNote || null");

  /* 送出後 chip 應自動消失：模擬 host 在 pre-step 消費掉 pending（真實送出時就是這樣清的） */
  await evaluate(makeSelection);
  await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="button"]'))`, "button3", 15, 400);
  await evaluate(`document.querySelector('[data-dsh-quote-note="button"]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="panel"]'))`, "panel3", 15, 300);
  await evaluate(`(() => {
    const ta = document.querySelector('[data-dsh-quote-note="textarea"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '送出後應該消失');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const b = Array.from(document.querySelectorAll('[data-dsh-quote-note="panel"] button')).find((x) => (x.textContent || '').includes('加入引用'));
    if (b) b.click();
    return true;
  })()`);
  const chip3 = await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="rail"] [data-dsh-quote-note="chip"]'))`, "chip3", 20, 300);
  check("再次掛上一則引用（準備驗證送出後消失）", chip3);

  if (chip3) {
    const sid = await evaluate("window.__dshQuoteNote && window.__dshQuoteNote.pending.sessionId");
    await evaluate(
      `fetch('/api/dsh-quote-note/pending', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ sessionId: ${JSON.stringify(sid)}, items: [] }) }).then((r) => r.status)`
    );
    const cleared = await waitFor(`!document.querySelector('[data-dsh-quote-note="rail"]')`, "cleared-after-send", 24, 500);
    const clearedDiag = await evaluate("window.__dshQuoteNote && window.__dshQuoteNote.pending.clearedAfterSend");
    check("host 消費後 chip 自動消失（＝看得出已送出）", cleared, `clearedAfterSend=${clearedDiag}`);
  }
  console.log(
    `\n-- diag: adds=${finalDiag?.pending?.adds} syncs=${finalDiag?.pending?.syncs} syncFailures=${finalDiag?.pending?.syncFailures} sessionId=${finalDiag?.pending?.sessionId}`
  );

  /* ── 選配：真的送出，驗證 host 在 pre-step 注入（QN_SEND=1） ─────────────
     會在該 session 產生一次真實的模型呼叫。 */
  if (process.env.QN_SEND === "1") {
    // 1) 重新加一則引用
    await evaluate(makeSelection);
    await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="button"]'))`, "button2", 15, 400);
    await evaluate(`document.querySelector('[data-dsh-quote-note="button"]').click()`);
    await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="panel"]'))`, "panel2", 15, 300);
    await evaluate(`(() => {
      const ta = document.querySelector('[data-dsh-quote-note="textarea"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '送出驗證用的想法');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const b = Array.from(document.querySelectorAll('[data-dsh-quote-note="panel"] button')).find((x) => (x.textContent || '').includes('加入引用'));
      if (b) b.click();
      return true;
    })()`);
    const chipAgain = await waitFor(`Boolean(document.querySelector('[data-dsh-quote-note="rail"] [data-dsh-quote-note="chip"]'))`, "chip2", 20, 300);
    check("送出前先掛上一則引用", chipAgain);

    // 2) 在主輸入框打字後送出（真的 Enter）。
    //    注意：Lexical 編輯器對 CDP 的 insertText 不一定買單，所以先真實點擊再插入，
    //    失敗才退回逐字元 char 事件。
    const edRect = await evaluate(`(() => {
      const r = document.querySelector('[contenteditable="true"]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: edRect.x, y: edRect.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: edRect.x, y: edRect.y, button: "left", clickCount: 1 });
    await sleep(300);
    await send("Input.insertText", { text: "請看這段" });
    await sleep(600);
    let draftBeforeSend = await evaluate(`document.querySelector('[contenteditable="true"]').textContent || ''`);
    if (!draftBeforeSend.trim()) {
      for (const ch of "請看這段") {
        await send("Input.dispatchKeyEvent", { type: "char", text: ch });
        await sleep(80);
      }
      await sleep(500);
      draftBeforeSend = await evaluate(`document.querySelector('[contenteditable="true"]').textContent || ''`);
    }
    check("草稿只有我自己打的字（沒有引用內容）", draftBeforeSend.includes("請看這段") && !draftBeforeSend.includes("引用"), JSON.stringify(draftBeforeSend));

    await send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    console.log("-- 已送出，等待回合（最多 90s）…");
    const cleared = await waitFor(`(document.querySelector('[contenteditable="true"]').textContent || '').trim() === ''`, "draft-cleared", 60, 1500);
    check("送出後草稿被清空（代表真的送出了）", cleared);
    await sleep(8000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通過`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("驗證腳本錯誤：", error?.message || error);
  process.exitCode = 2;
} finally {
  cleanup();
  await sleep(150);
}
