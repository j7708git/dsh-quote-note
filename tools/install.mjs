#!/usr/bin/env node
/**
 * dsh-quote-note — 安裝／驗證／移除腳本。
 *
 * 為什麼需要它：DSH 不會自動載入工作區裡的資料夾。要在某個 profile 生效，必須
 * 「登錄」三件事（bundles 條目、dependencies link、node_modules 連結），而這些
 * 都在 <DSH_HOME> 底下、不在本 repo 內。本腳本把那三步變成一個指令。
 *
 * 只用 Node 標準函式庫，Windows／macOS／Linux 共用同一支（DSH 本身就需要 Node）。
 *
 * 用法：
 *   node tools/install.mjs                      # 安裝（profile 預設 desktop，或取 DSH_PROFILE）
 *   node tools/install.mjs --profile web        # 指定 profile
 *   node tools/install.mjs --dry-run            # 只印出將要做的變更，不寫任何檔
 *   node tools/install.mjs --verify             # 唯讀檢查目前是否安裝正確
 *   node tools/install.mjs --uninstall          # 還原（移除連結與兩個登錄條目）
 *   node tools/install.mjs --json               # 以 JSON 輸出結果（給 agent 解析）
 *
 * 安全保證：
 *   - 寫入前一律備份 profile 的 package.json。
 *   - 只動 dsh.profile.bundles 的一列與 dependencies 的一條，其他內容原樣保留。
 *   - 不覆蓋既有連結；目標不符時停下來回報（要覆蓋需明示 --force）。
 *   - --uninstall 只刪「連結本身」，絕不遞迴刪除目標目錄。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_NAME = "dsh-quote-note";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── 純函式（可單獨測試） ──────────────────────────────────────────────────── */

/** profile 名稱必須是安全的路徑段，否則拒絕（防路徑穿越）。 */
export function assertSafeProfileName(name) {
  if (typeof name !== "string" || name.length === 0) throw new Error("profile 名稱不可為空");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw new Error(`profile 名稱不安全（只允許英數與 . _ -，且需以英數開頭）：${name}`);
  }
  return name;
}

/** pnpm 的 link: 規格；一律用正斜線，跨平台都能被 pnpm 接受。 */
export function makeLinkSpec(dir) {
  return "link:" + String(dir).split(sep).join("/");
}

/** 冪等地加入一個字串條目；已存在就不動。 */
export function upsertEntry(list, value) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.includes(value)) return { list: arr, changed: false };
  arr.push(value);
  return { list: arr, changed: true };
}

/** 移除所有相符的條目（含重複）。 */
export function removeEntry(list, value) {
  const arr = Array.isArray(list) ? list : [];
  const next = arr.filter((item) => item !== value);
  return { list: next, changed: next.length !== arr.length };
}

/**
 * 正規化連結目標以便比較。
 * Windows 的 junction 由 readlink 讀出來會帶 `\\?\` 前綴、且大小寫不敏感。
 */
export function normalizeLinkTarget(target, platform = process.platform) {
  let t = String(target ?? "");
  if (t.startsWith("\\\\?\\")) t = t.slice(4);
  t = t.replace(/[\\/]+$/, "");
  if (platform === "win32") return t.split("/").join("\\").toLowerCase();
  return t;
}

/**
 * 備份檔名的時間戳：本機時間、`YYYYMMDD-HHMMSS`。
 * （不要用 toISOString 直接切字串——會在結尾留下小數點，Windows 上尤其難看。）
 */
export function makeBackupStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** 在物件上掛出 dsh.profile.bundles 的路徑，缺少就建。 */
function ensureBundlesPath(pkg) {
  if (!pkg.dsh || typeof pkg.dsh !== "object") pkg.dsh = {};
  if (!pkg.dsh.profile || typeof pkg.dsh.profile !== "object") pkg.dsh.profile = {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  return pkg.dsh.profile.bundles;
}

/**
 * 計算要把 profile package.json 改成什麼（不動檔案）。
 * @returns {{next: object, changes: string[]}}
 */
export function planWiring(pkg, pluginDir) {
  const next = structuredClone(pkg);
  const changes = [];

  const bundles = ensureBundlesPath(next);
  const bundleResult = upsertEntry(bundles, PLUGIN_NAME);
  if (bundleResult.changed) changes.push(`dsh.profile.bundles 加入 "${PLUGIN_NAME}"`);
  next.dsh.profile.bundles = bundleResult.list;

  if (!next.dependencies || typeof next.dependencies !== "object") next.dependencies = {};
  const spec = makeLinkSpec(pluginDir);
  if (next.dependencies[PLUGIN_NAME] !== spec) {
    changes.push(`dependencies["${PLUGIN_NAME}"] 設為 "${spec}"`);
    next.dependencies[PLUGIN_NAME] = spec;
  }

  return { next, changes };
}

/** 計算要把 profile package.json 還原成什麼（不動檔案）。 */
export function planUnwiring(pkg) {
  const next = structuredClone(pkg);
  const changes = [];

  if (next.dsh?.profile?.bundles) {
    const r = removeEntry(next.dsh.profile.bundles, PLUGIN_NAME);
    if (r.changed) changes.push(`dsh.profile.bundles 移除 "${PLUGIN_NAME}"`);
    next.dsh.profile.bundles = r.list;
  }
  if (next.dependencies && Object.prototype.hasOwnProperty.call(next.dependencies, PLUGIN_NAME)) {
    delete next.dependencies[PLUGIN_NAME];
    changes.push(`dependencies 移除 "${PLUGIN_NAME}"`);
  }

  return { next, changes };
}

/* ── 環境 ─────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = { mode: "install", profile: null, dshHome: null, dryRun: false, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") opts.profile = argv[++i];
    else if (a === "--dsh-home") opts.dshHome = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--verify") opts.mode = "verify";
    else if (a === "--uninstall") opts.mode = "uninstall";
    else if (a === "-h" || a === "--help") opts.mode = "help";
    else throw new Error(`未知參數：${a}`);
  }
  return opts;
}

function resolveHome(opts) {
  if (opts.dshHome) return resolve(opts.dshHome);
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
  return join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
}

function listProfiles(home) {
  try {
    return readdirSync(join(home, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/* ── 各模式 ───────────────────────────────────────────────────────────────── */

const log = (json, opts, payload) => {
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
};

function readPkg(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writePkg(file, pkg) {
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

function backup(file) {
  const target = `${file}.bak-${PLUGIN_NAME}-${makeBackupStamp()}`;
  copyFileSync(file, target);
  return target;
}

function linkPath(profileDir) {
  return join(profileDir, "node_modules", PLUGIN_NAME);
}

/** 檢查 node_modules 底下的連結狀態。 */
function inspectLink(profileDir, pluginDir) {
  const link = linkPath(profileDir);
  if (!existsSync(link) && !isDanglingLink(link)) return { state: "absent", link };
  let lstat;
  try {
    lstat = lstatSync(link);
  } catch {
    return { state: "absent", link };
  }
  if (!lstat.isSymbolicLink()) return { state: "not-a-link", link };
  const raw = readlinkSync(link);
  const matches = normalizeLinkTarget(raw) === normalizeLinkTarget(pluginDir);
  return { state: matches ? "ok" : "wrong-target", link, target: raw };
}

function isDanglingLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function hostHalfLoads(profileDir) {
  const require = createRequire(join(profileDir, "package.json"));
  const entry = require.resolve(PLUGIN_NAME);
  const mod = await import(pathToFileURL(entry).href);
  return { entry, ok: typeof mod.apply === "function" };
}

async function runInstall(opts, home, profileDir, pluginDir) {
  const file = join(profileDir, "package.json");
  if (!existsSync(file)) throw new Error(`找不到 profile 的 package.json：${file}`);

  const pkg = readPkg(file);
  const { next, changes } = planWiring(pkg, pluginDir);
  const link = inspectLink(profileDir, pluginDir);

  const planned = [...changes];
  if (link.state === "absent") planned.push(`建立連結 ${linkPath(profileDir)} → ${pluginDir}`);
  else if (link.state === "wrong-target") planned.push(`連結已存在但指向 ${link.target}（將停手，需 --force）`);
  else if (link.state === "not-a-link") planned.push(`node_modules/${PLUGIN_NAME} 是真實目錄而非連結（將停手）`);
  else planned.push(`連結已存在且指向正確（不動）`);

  if (opts.dryRun) {
    console.log(`[dry-run] profile：${profileDir}`);
    for (const c of planned) console.log(`  - ${c}`);
    console.log("[dry-run] 未寫入任何檔案。");
    return { ok: true, dryRun: true, changes: planned };
  }

  if (link.state === "not-a-link") {
    throw new Error(`${linkPath(profileDir)} 是真實目錄而非連結，為避免刪到你的東西而停手。請自行處理後重試。`);
  }
  if (link.state === "wrong-target" && !opts.force) {
    throw new Error(`${linkPath(profileDir)} 已存在但指向 ${link.target}；本腳本不覆蓋既有連結。確認後可加 --force。`);
  }

  let backupPath = null;
  if (changes.length > 0) {
    backupPath = backup(file);
    mkdirSync(dirname(linkPath(profileDir)), { recursive: true });
    writePkg(file, next);
  }

  if (link.state === "absent") {
    mkdirSync(dirname(linkPath(profileDir)), { recursive: true });
    symlinkSync(pluginDir, linkPath(profileDir), process.platform === "win32" ? "junction" : "dir");
  } else if (link.state === "wrong-target" && opts.force) {
    unlinkSync(linkPath(profileDir));
    symlinkSync(pluginDir, linkPath(profileDir), process.platform === "win32" ? "junction" : "dir");
  }

  const check = await runVerify({ ...opts, json: false }, home, profileDir, pluginDir, { quiet: true });
  return { ok: check.ok, installed: true, changes: planned, backup: backupPath, verify: check };
}

async function runVerify(opts, home, profileDir, pluginDir, extra = {}) {
  const file = join(profileDir, "package.json");
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  add("profile 目錄存在", existsSync(profileDir), profileDir);
  if (existsSync(file)) {
    let pkg = null;
    try {
      pkg = readPkg(file);
      add("profile package.json 可解析", true, "");
    } catch (e) {
      add("profile package.json 可解析", false, String(e.message || e));
    }
    if (pkg) {
      const bundles = pkg.dsh?.profile?.bundles;
      add("bundles 含本插件", Array.isArray(bundles) && bundles.includes(PLUGIN_NAME), Array.isArray(bundles) ? `${bundles.length} 個條目` : "（無 bundles 陣列）");
      const dep = pkg.dependencies?.[PLUGIN_NAME];
      add("dependencies 有 link 條目", typeof dep === "string" && dep.startsWith("link:"), dep ?? "（缺）");
    }
  }

  const link = inspectLink(profileDir, pluginDir);
  add("node_modules 連結指向本 repo", link.state === "ok", link.state === "ok" ? linkPath(profileDir) : `${link.state}${link.target ? " → " + link.target : ""}`);

  try {
    const loaded = await hostHalfLoads(profileDir);
    add("host 半可載入且匯出 apply", loaded.ok, loaded.entry);
  } catch (e) {
    add("host 半可載入且匯出 apply", false, String(e.message || e));
  }

  const ok = results.every((r) => r.ok);
  if (!extra.quiet) {
    if (opts.json) log(true, opts, { ok, results });
    else {
      console.log(`驗證 ${profileDir}`);
      for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
      console.log(ok ? "\n全部通過。" : "\n有項目未通過。");
    }
  }
  return { ok, results };
}

function runUninstall(opts, home, profileDir, pluginDir) {
  const file = join(profileDir, "package.json");
  if (!existsSync(file)) throw new Error(`找不到 profile 的 package.json：${file}`);

  const pkg = readPkg(file);
  const { next, changes } = planUnwiring(pkg);
  const link = inspectLink(profileDir, pluginDir);

  const planned = [...changes];
  if (link.state === "ok" || link.state === "wrong-target") planned.push(`刪除連結本身 ${linkPath(profileDir)}（不遞迴進目標）`);
  else if (link.state === "not-a-link") planned.push(`node_modules/${PLUGIN_NAME} 是真實目錄，不刪除`);
  else planned.push("連結不存在（無需刪除）");

  if (opts.dryRun) {
    console.log(`[dry-run] profile：${profileDir}`);
    for (const c of planned) console.log(`  - ${c}`);
    console.log("[dry-run] 未寫入任何檔案。");
    return { ok: true, dryRun: true, changes: planned };
  }

  let backupPath = null;
  if (changes.length > 0) {
    backupPath = backup(file);
    writePkg(file, next);
  }
  if (link.state === "ok" || link.state === "wrong-target") unlinkSync(linkPath(profileDir));

  return { ok: true, uninstalled: true, changes: planned, backup: backupPath };
}

const HELP = `dsh-quote-note 安裝工具

  node tools/install.mjs [--profile <名稱>] [--dsh-home <路徑>] [--dry-run] [--json]
  node tools/install.mjs --verify    [--profile <名稱>]
  node tools/install.mjs --uninstall [--profile <名稱>] [--dry-run]

profile 預設取環境變數 DSH_PROFILE，沒有就用 desktop。
安裝後必須重啟該 profile（DSH Desktop 就重啟 Desktop），新 bundle 不會熱載入。`;

/* ── 進入點 ───────────────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = resolveHome(opts);
  const pluginDir = REPO_ROOT;

  if (opts.mode === "help") {
    console.log(HELP);
    return 0;
  }

  // 確認自己真的是本插件（避免被複製到別處後亂動 profile）
  const own = readPkg(join(pluginDir, "package.json"));
  if (own.name !== PLUGIN_NAME) throw new Error(`本目錄的 package.json 不是 ${PLUGIN_NAME}（讀到 ${own.name}）`);

  const profile = opts.profile || process.env.DSH_PROFILE || "desktop";
  assertSafeProfileName(profile);
  const profileDir = join(home, "profiles", profile);

  if (!existsSync(profileDir)) {
    const available = listProfiles(home);
    throw new Error(
      `找不到 profile "${profile}"：${profileDir}\n可用的 profile：${available.length ? available.join(", ") : "（無）"}`
    );
  }

  let result;
  if (opts.mode === "verify") result = await runVerify(opts, home, profileDir, pluginDir);
  else if (opts.mode === "uninstall") result = runUninstall(opts, home, profileDir, pluginDir);
  else result = await runInstall(opts, home, profileDir, pluginDir);

  if (opts.json) {
    log(true, opts, { mode: opts.mode, profile, profileDir, pluginDir, ...result });
    return result.ok === false ? 1 : 0;
  }

  if (opts.mode === "install" && !opts.dryRun) {
    console.log(`\nprofile：${profile}`);
    for (const c of result.changes) console.log(`  - ${c}`);
    if (result.backup) console.log(`  備份：${result.backup}`);
    if (opts.json === false && result.verify) {
      for (const r of result.verify.results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    }
    console.log(result.ok ? "\n安裝完成。**請重啟該 profile（DSH Desktop 就重啟 Desktop）**，新 bundle 不會熱載入。" : "\n安裝未完全成功，請看上面 FAIL 的項目。");
    console.log(`移除：node tools/install.mjs --uninstall --profile ${profile}`);
  } else if (opts.mode === "uninstall" && !opts.dryRun) {
    console.log(`\nprofile：${profile}`);
    for (const c of result.changes) console.log(`  - ${c}`);
    if (result.backup) console.log(`  備份：${result.backup}`);
    console.log("\n已還原。**請重啟該 profile** 讓變更生效。");
  }

  return result.ok === false ? 1 : 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`錯誤：${error.message || error}`);
      if (/找不到 profile/.test(String(error.message))) {
        console.error(HELP.split("\n").slice(0, 6).join("\n"));
      }
      process.exitCode = 2;
    });
}
