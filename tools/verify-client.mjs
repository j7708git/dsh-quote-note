/**
 * dsh-quote-note — client 半的真實瀏覽器驗證（headless Edge + CDP）。
 *
 * 用法：
 *   node tools/verify-client.mjs "http://127.0.0.1:<port>/?token=<token>" [--edge <path>]
 *   （瀏覽器由常見路徑自動尋找，可用 --edge <path> 或環境變數 QN_BROWSER 覆寫）
 *
 * 為什麼需要它：host 端「有掛載、有服務 bundle」不等於 client 半會動。
 * 本腳本在真瀏覽器裡確認：
 *   1. app 開得起來（頁面有內容、無 uncaught error）
 *   2. 我們的 client 模組被物化（console 出現 client half applied）
 *   3. 在真 DOM 造一個反白選取 → 浮動「¶ 加想法」按鈕出現
 *   4. 點按鈕 → 想法輸入框出現、可輸入
 *   5. 按「附加到輸入框」→ UI→bus→insertIntoComposer 全鏈產生可觀測結果
 *      （成功＝面板關閉＋chip；無 session＝面板顯示明確原因）
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
const CDP_PORT = 9333;

/** 常見 Chromium 系瀏覽器位置；可用 --edge <path> 或環境變數 QN_BROWSER 覆寫。 */
const BROWSER_CANDIDATES = [
  process.env.QN_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const EDGE = explicitBrowser || BROWSER_CANDIDATES.find((c) => existsSync(c)) || null;

if (!target) {
  console.error('用法: node tools/verify-client.mjs "<baseUrl含token>" [--edge <path>]');
  process.exit(2);
}
if (!EDGE) {
  console.error("找不到 Chromium 系瀏覽器；請用 --edge <path> 或設定環境變數 QN_BROWSER 指定。");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 開 headless Edge ─────────────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "qn-edge-"));
const edge = spawn(
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
const pageErrors = [];

function send(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

function cleanup() {
  try {
    ws?.close();
  } catch {}
  try {
    edge.kill();
  } catch {}
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {}
}

try {
  /* 等 CDP 端點 */
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
  check("headless Edge 與 CDP 就緒", Boolean(version), version ? version["Browser"] : "CDP 端點無回應");
  if (!version) throw new Error("CDP 未就緒");

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("找不到 page target");

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
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(" ");
      consoleLines.push(`${msg.params.type}: ${text}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "unknown");
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      pageErrors.push(msg.params.entry.text);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__qnErrors = [];
      window.addEventListener('error', e => window.__qnErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__qnErrors.push('unhandledrejection: ' + String(e.reason)));
    `,
  });

  await send("Page.navigate", { url: target });
  try {
    await send("Page.bringToFront");
  } catch {}

  /* 等 app boot */
  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const r = await send("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText.trim().length : 0",
        returnByValue: true,
      });
      if ((r.result?.value ?? 0) > 20) {
        booted = true;
        break;
      }
    } catch {}
  }
  check("app 在真瀏覽器裡 boot 起來", booted, booted ? "頁面有內容" : "60s 內頁面仍空白");

  /* 我們的 client 半是否被物化 */
  const applied = consoleLines.find((l) => l.includes("[dsh-quote-note] client half applied"));
  check("client 模組被物化（client half applied）", Boolean(applied), applied ?? `console 未出現（共 ${consoleLines.length} 行）`);

  const pluginErrors = consoleLines.filter((l) => l.includes("[dsh-quote-note]") && l.startsWith("error"));
  check("本插件沒有註冊錯誤", pluginErrors.length === 0, pluginErrors.length ? pluginErrors.join(" | ") : "無");

  /* 在真 DOM 造一個反白選取。
     優先挑頁面上「真的可被使用者選取」的文字（DSH 的 chrome 常帶 user-select:none，
     那種文字程式化選取會得到空字串），挑不到才注入一個暫時元素。 */
  const makeSelection = `(() => {
    const bad = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],input,textarea';
    function structural(el) {
      if (el.hasAttribute('data-dsh-quote-note') || el.querySelector('[data-dsh-quote-note]')) return 'ours';
      if (el.closest(bad)) return 'editable';
      if (el.children.length > 0) return 'not-leaf';
      if ((el.textContent || '').trim().length < 4) return 'too-short';
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return 'invisible';
      return null;
    }
    function trySelect(el) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return sel.toString();
      } catch (e) {
        return '';
      }
    }
    // 不用「預測」哪些文字可選（user-select 不繼承、inert/合成事件等都會影響），
    // 直接選一次、讀回非空才採用。
    let el = null;
    let readBack = '';
    const rejected = {};
    for (const cand of Array.from(document.querySelectorAll('span,div,p,h1,h2,h3,code,a'))) {
      const why = structural(cand);
      if (why) { rejected[why] = (rejected[why] || 0) + 1; continue; }
      const got = trySelect(cand);
      if (!got || !got.trim()) { rejected['select-readback-empty'] = (rejected['select-readback-empty'] || 0) + 1; continue; }
      el = cand;
      readBack = got;
      break;
    }
    let mode = 'real';
    if (!el) {
      mode = 'injected';
      el = document.createElement('div');
      el.setAttribute('data-qn-probe', '1');
      el.textContent = '驗證用可選取文字';
      el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147482000;background:#1b1b1f;color:#fff;padding:4px 8px;font-size:12px;border-radius:4px';
      document.body.appendChild(el);
      readBack = trySelect(el);
    }
    document.dispatchEvent(new Event('selectionchange'));
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim(), mode, readBack, rejected, rect: { w: Math.round(r.width), h: Math.round(r.height) } };
  })()`;

  let selection = null;
  for (let i = 0; i < 20; i++) {
    const r = await send("Runtime.evaluate", { expression: makeSelection, returnByValue: true });
    selection = r.result?.value ?? null;
    if (selection && selection.readBack) break;
    await sleep(1000);
  }
  const selectedText = selection?.text ?? null;
  check(
    "頁面上找到可反白的文字",
    Boolean(selectedText && selection?.readBack),
    selection
      ? `「${String(selectedText).slice(0, 30)}」(${selection.mode}, 選取讀回 ${JSON.stringify(selection.readBack)}, rect ${selection.rect?.w}x${selection.rect?.h}; 被排除 ${JSON.stringify(selection.rejected)})`
      : "找不到候選元素"
  );

  /* 浮動按鈕 */
  let button = false;
  for (let i = 0; i < 20; i++) {
    const r = await send("Runtime.evaluate", {
      expression: `Boolean(document.querySelector('[data-dsh-quote-note="button"]'))`,
      returnByValue: true,
    });
    if (r.result?.value) {
      button = true;
      break;
    }
    await sleep(500);
  }

  /* 不論成敗都讀一次插件自己的診斷（掛載／選取被拒的原因） */
  const diagRes = await send("Runtime.evaluate", { expression: "window.__dshQuoteNote || null", returnByValue: true });
  const diag = diagRes.result?.value ?? null;
  check(
    "反白後浮出「¶ 加想法」按鈕",
    button,
    button ? "shell.overlay 已渲染" : `未出現；diag=${JSON.stringify(diag)}`
  );
  if (diag) {
    console.log(
      `  diag: applied=${diag.applied} inject.requested=${JSON.stringify(diag.inject?.requested)} ` +
        `inject.registered=${JSON.stringify(diag.inject?.registered)} mounted=${JSON.stringify(diag.mounted)} ` +
        `syncs=${diag.syncs} lastReject=${diag.lastReject} lastPick=${JSON.stringify(diag.lastPick)} ` +
        `errors=${JSON.stringify(diag.errors)}`
    );
  }

  /* 點按鈕 → 面板 */
  let panel = false;
  if (button) {
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-dsh-quote-note="button"]').click()`,
      returnByValue: true,
    });
    for (let i = 0; i < 20; i++) {
      const r = await send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector('[data-dsh-quote-note="panel"]'))`,
        returnByValue: true,
      });
      if (r.result?.value) {
        panel = true;
        break;
      }
      await sleep(300);
    }
  }
  check("點擊後想法輸入框出現", panel, panel ? "面板已渲染" : "未出現");

  /* 在面板輸入（走 React 的 onChange） */
  let typed = null;
  if (panel) {
    await send("Runtime.evaluate", {
      expression: `(() => {
        const ta = document.querySelector('[data-dsh-quote-note="textarea"]');
        if (!ta) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '驗證用想法：這段請展開說明');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return ta.value;
      })()`,
      returnByValue: true,
    });
    await sleep(300);
    const r = await send("Runtime.evaluate", {
      expression: `(document.querySelector('[data-dsh-quote-note="textarea"]') || {}).value ?? null`,
      returnByValue: true,
    });
    typed = r.result?.value ?? null;
  }
  check("想法輸入框可輸入", typed === "驗證用想法：這段請展開說明", typed ? `值＝「${typed}」` : "讀不到值");

  /* 按「附加到輸入框」→ 全鏈可觀測結果 */
  let branch = null;
  if (panel) {
    await send("Runtime.evaluate", {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('[data-dsh-quote-note="panel"] button'));
        const b = btns.find(x => (x.textContent || '').includes('附加'));
        if (b) b.click();
        return Boolean(b);
      })()`,
      returnByValue: true,
    });
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const r = await send("Runtime.evaluate", {
        expression: `(() => {
          const panel = document.querySelector('[data-dsh-quote-note="panel"]');
          const chip = document.querySelector('[data-dsh-quote-note="chip"]');
          if (!panel) return { kind: 'closed', chip: chip ? chip.textContent : null };
          const txt = panel.innerText || '';
          return { kind: 'open', text: txt };
        })()`,
        returnByValue: true,
      });
      const v = r.result?.value;
      if (!v) continue;
      if (v.kind === "closed") {
        branch = `面板關閉（成功路徑）；chip＝${v.chip ?? "（無，可能已逾時）"}`;
        break;
      }
      if (/還沒有輸入框|這個版本的輸入框不支援|寫入失敗|附加失敗/.test(v.text)) {
        branch = `面板顯示明確原因：${(v.text.match(/還沒有輸入框[^\n]*|這個版本[^\n]*|寫入失敗[^\n]*|附加失敗[^\n]*/) || [""])[0]}`;
        break;
      }
    }
  }
  check("「附加」全鏈產生可觀測結果", Boolean(branch), branch ?? "10s 內無可觀測變化");

  /* 收尾：移除可能注入的暫時元素 */
  await send("Runtime.evaluate", { expression: `document.querySelector('[data-qn-probe]')?.remove()` });

  /* 頁面層級錯誤 */
  const inPage = await send("Runtime.evaluate", { expression: "window.__qnErrors || []", returnByValue: true });
  const allErrors = [...pageErrors, ...((inPage.result?.value) || [])];
  const relevant = allErrors.filter((e) => /dsh-quote-note|quote-note/.test(String(e)));
  check("沒有本插件相關的頁面錯誤", relevant.length === 0, relevant.length ? relevant.join(" | ") : `無（其他錯誤 ${allErrors.length} 筆）`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通過`);
  console.log(`\n-- 選取文字：${selectedText}\n-- 結果分支：${branch}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("驗證腳本錯誤：", error?.message || error);
  process.exitCode = 2;
} finally {
  cleanup();
  await sleep(150);
}
