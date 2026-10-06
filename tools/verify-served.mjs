/**
 * 驗證一個「已啟動的 DSH 實例」是否真的把 dsh-quote-note 的 client bundle 送出去。
 *
 * 用法：
 *   node tools/verify-served.mjs "http://127.0.0.1:<port>/?token=<token>"
 *
 * 檢查項：
 *   1. 用 token 換 cookie 後，首頁 HTML 的啟動 manifest 含本插件的 client entry
 *   2. 該 entry 的 client bundle URL 取得到（200），且內容含本插件標記
 *   3. 送出的 bundle 與本目錄的 client.js 逐字相同（DSH 只會附加 sourcemap trailer）
 *
 * 只讀，不修改任何東西。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_CLIENT = join(HERE, "..", "client.js");
const PLUGIN_ID = "dsh-quote-note";
const MARKER = "¶ 加想法";

const target = process.argv[2];
if (!target) {
  console.error("用法: node tools/verify-served.mjs <baseUrl含token>");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const url = new URL(target);
const base = url.origin;

/* 1) token → cookie */
let cookie = "";
try {
  const first = await fetch(url, { redirect: "manual" });
  const raw = typeof first.headers.getSetCookie === "function" ? first.headers.getSetCookie() : [];
  cookie = raw.map((c) => c.split(";")[0]).join("; ");
  check("token 換 cookie", first.status < 400, `HTTP ${first.status}${cookie ? ", 取得 cookie" : "（無 Set-Cookie）"}`);
} catch (error) {
  check("token 換 cookie", false, String(error.message || error));
  process.exit(1);
}

/* 2) 首頁啟動 manifest */
const index = await fetch(`${base}/`, { headers: cookie ? { cookie } : {} });
const html = await index.text();
check("首頁可取 (200)", index.status === 200, `HTTP ${index.status}, ${html.length} bytes`);
check("啟動 manifest 含本插件 id", html.includes(`"${PLUGIN_ID}"`), html.includes(`"${PLUGIN_ID}"`) ? "命中" : "未命中");

/* 3) 取出 client entry 的 url */
let clientPath = null;
const entryRe = new RegExp(`\\{[^{}]*"id"\\s*:\\s*"${PLUGIN_ID}"[^{}]*\\}`);
const entryMatch = html.match(entryRe);
if (entryMatch) {
  const urlField = entryMatch[0].match(/"url"\s*:\s*"([^"]+)"/);
  if (urlField) {
    clientPath = urlField[1]
      .replace(/\\u0026/gi, "&")
      .replace(/&amp;/g, "&")
      .replace(/\\\//g, "/");
  }
}
check("取到 client entry 的 url", Boolean(clientPath), clientPath ?? `manifest 片段：${(entryMatch && entryMatch[0]) || "（找不到）"}`);

if (clientPath) {
  const absolute = new URL(clientPath.startsWith("/") ? clientPath : `/${clientPath}`, base);
  const bundle = await fetch(absolute, { headers: cookie ? { cookie } : {} });
  const body = await bundle.text();
  check("client bundle 可取 (200)", bundle.status === 200, `HTTP ${bundle.status}, ${body.length} bytes, ${absolute.pathname}`);
  check("bundle 含本插件標記", body.includes(MARKER), body.includes(MARKER) ? `命中「${MARKER}」` : "未命中");

  const local = readFileSync(LOCAL_CLIENT, "utf8");
  const same = body === local;
  const dshAdded = body.length - local.length;
  check(
    "送出的 bundle 與本目錄 client.js 一致",
    same || (body.startsWith(local) && dshAdded > 0),
    same ? "逐字相同" : `本目錄檔案為其前綴，DSH 追加 ${dshAdded} bytes（sourcemap trailer）`
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
// 用 exitCode 而非 process.exit()：Windows 上強制結束會踩到 libuv 的
// UV_HANDLE_CLOSING assert，讓退出碼變成 1（假失敗）。
process.exitCode = failed.length ? 1 : 0;
// 讓 keep-alive socket 有機會收乾淨，避免事件迴圈被 undici 連線池拖住。
await new Promise((resolve) => setTimeout(resolve, 100));
