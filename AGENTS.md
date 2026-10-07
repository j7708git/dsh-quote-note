# AGENTS.md — 給 coding agent 的操作說明

這個 repo 是一個 **DSH（DeepSeek Harness）plugin**。
若使用者要你「把這個 repo 裝起來」，照下面做即可，**不需要先讀完所有原始碼**。

---

## 使用者說「幫我裝這個插件」時

### 步驟

1. **確認環境**：`dsh --version` 有回應、`node -v` ≥ 20。
2. **確認要裝進哪個 profile**（只問這一個問題，不要猜）：
   - 用 **DSH Desktop 應用** → `desktop`
   - 用 `dsh web` → `web`
   - 不確定 → 先看 `<DSH_HOME>/profiles/` 底下有哪些目錄，或直接問使用者。
3. **安裝**：
   ```sh
   node tools/install.mjs --profile desktop
   ```
   腳本會自己找 `DSH_HOME`（可用 `--dsh-home` 指定，或用 `DSH_PROFILE` 環境變數決定 profile）。
   先看它會做什麼可以加 `--dry-run`（不寫任何檔）。
4. **驗證**：
   ```sh
   node tools/install.mjs --verify --profile desktop
   ```
   退出碼：`0` 通過／`1` 有項目未通過／`2` 用法或環境錯誤。
5. **告訴使用者必須重啟該 profile** —— 新 bundle 不會熱載入。
   **不要**替他重啟 DSH：那會中斷他正在跑的 session。
6. 要移除時：`node tools/install.mjs --uninstall --profile desktop`

### 這個腳本做了什麼（你可以自行核對）

1. `<DSH_HOME>/profiles/<profile>/package.json`
   - `dsh.profile.bundles` 加入一列 `dsh-quote-note`
   - `dependencies["dsh-quote-note"] = "link:<本 repo 的絕對路徑>"`
2. `<DSH_HOME>/profiles/<profile>/node_modules/dsh-quote-note`
   → 指向本 repo 的 junction（Windows）／symlink（macOS、Linux）
3. 寫入前一定備份 `package.json`；腳本**冪等**，重跑不會重複加條目。
4. `--uninstall` 只刪「連結本身」，**不遞迴進目標目錄**。
5. 讀取設定檔時會容忍 UTF-8 BOM（PowerShell 5.1 的 `Set-Content -Encoding UTF8` 會寫入 BOM，
   而 `JSON.parse` 讀到 BOM 會直接丟 `Unexpected token`、整個 profile 起不來）。

### 禁止事項（踩到會壞事）

- **不要**用 `dsh plugin --profile desktop add` —— `desktop` profile 由 Electron 應用獨占管理，
  CLI 會直接拒絕（`profile "desktop" is managed exclusively by the Electron application`）。
- **不要**對 `desktop` profile 跑 `pnpm install`／`pnpm add`：該 profile 可能有使用者手動建立的
  孤立 junction，pnpm 的 prune 會把它們清掉。
- **不要**用 `host.call` 做 client→host 呼叫：那屬於**動態定義套件**（`cordis_define` +
  `harness.handle`）的機制，**已安裝的一般套件拿不到**。本插件用的是認證的 `/api` route。
- **不要**覆蓋既有連結：腳本遇到指向別處的連結會停手，需 `--force` 才會換；不要主動加 `--force`。
- **不要**改任何 repo 的可見度、不要 `--force` push、不要改寫歷史。
- **不要**替使用者 commit 或 push，除非他明確要求。

---

## 這個插件是什麼

在 DSH 對話裡**反白選取文字** → 就地跳出小輸入框寫下想法 → 按「加入引用」後，
引用**不會進主輸入框**，而是在輸入框**外**上方變成一顆小 chip（多則橫向排列）；
hover／點 chip 會開面板顯示「引用的原文 ＋ 我的想法」，可**編輯想法**或**刪除**。
使用者按送出時，這些引用才由 host 注入成一條額外的 context 訊息帶給模型。

## 架構（兩半都有行為）

```text
client 半（client.js）                        host 半（index.js）
──────────────────────                        ────────────────────
反白 → 浮動想法框                               POST /api/dsh-quote-note/pending
  ↓ 加入引用                                      → 依 sessionId 保管 pending
chip rail（conversation.input.dock）             agent/pre-step：
  · 一則一顆 chip、橫向排列                          · payload.agent.id = SessionId
  · hover／click → 面板：原文／編輯／刪除            · 有 pending → {kind:'enter',
  · 任何變更整份同步給 host（replace 語意）             messages:[...原訊息, 注入訊息]}
  ↓                                                · 清空該 session 的 pending
送出 → host 在 pre-step 注入 → 模型看到 ＋ transcript 可見
```

**為什麼是這條路**：client 端**沒有送出事件**，引用又刻意不放在草稿裡，所以只能在 host 的
`agent/pre-step` 注入。官方 `dsh-session-reference`（`@session` 引用）用的是同一招：
「每份快照都插入到引用它的訊息緊後」。

---

## 改這個插件時要遵守的架構契約

違反會在執行期才炸（或被 Guard 拒絕）：

1. **`client.js` 是手寫的 lazy-CJS bundle，不是建置產物。** 改它不需要任何 build 步驟。
   信封格式固定為 `window.__ModuleLoader__.load({ id: "dsh-quote-note", factory })`，
   且 `id` **必須**等於 `package.json` 的套件名。
2. **client 半必須宣告 `exports.inject = ["slots"]`。** cordis Guard 會拒絕未宣告的 `ctx.slots` 存取。
3. **host 半必須宣告 `export const inject = ["connection"]`。** `ctx.get('connection')` 在 `apply`
   當下會拿到 `undefined`（服務還沒被提供）—— 實測踩過。宣告 inject 後 cordis 會等到服務就緒。
4. **list slot 註冊必須帶 `id`**，且 slot 未宣告時註冊會丟錯 → 一律走 `ctx.slots.inject`。
5. **跨 slot 子樹溝通一律走 module 層 bus。** `shell.overlay`（root）與
   `conversation.input.dock`（session）沒有共同父層。
6. **引用不得寫進主輸入框**（那正是這個改動要解決的問題）。寫入 composer 的
   `captureInsertion()` + `insertText()` 只在**降級路徑**使用：當 host route 同步失敗時，
   為了不讓內容默默丟掉，才退回插入草稿。
   **不得**直接改寫 DOM 輸入框、**不得**攔送出事件。
7. **host 注入必須走 `agent/pre-step`**，並且**消費後清空**該 session 的 pending
   （否則下一輪會重複注入）。注入訊息要用 `createUserMessage` 並帶自己的
   `source.kind`（`MessageSourceMap` 是可合併擴充的，沒有共用 catch-all kind）。
8. **取用官方 API 必須做錨點解析**（見 `host-compat.js`）：本插件的實際目錄不在 profile 的
   `node_modules` 底下，直接 `import "@deepseek-ai/dsh-llm"` 會 `ERR_MODULE_NOT_FOUND`（實測）。
   全部錨點都失敗時**必須有後備**（手動建構訊息），不可讓插件整個壞掉。
9. **不得引入任何 runtime 依賴**：`dependencies` 永遠保持為空（只有一個 optional peer）。
10. **純函式要 export 出來**，讓 `test/` 能直接測（client 用假 loader、host 用假 ctx），
    不要為了「方便」加打包器或測試框架。
11. **DSH 專屬呼叫要集中並 feature-detect**：client 集中在 `insertIntoComposer()`／`apply()`，
    host 集中在 `host-compat.js`。DSH 仍是 developer preview，契約會在小版本之間漂移。
12. **失敗要如實回報**，不要靜默：`window.__dshQuoteNote` 是給排查用的診斷
    （只放計數與拒絕原因，**不得**放對話內容）。

---

## 驗證指令

```sh
node --test                                       # 單元 ＋ 假 ctx 整合測試
node tools/install.mjs --verify --profile <p>     # 安裝驗證（唯讀，退出碼 0/1/2）
node tools/verify-served.mjs "<url含token>"        # 對已啟動實例驗證 bundle 真的被服務
node tools/verify-client.mjs "<url含token>"        # headless 瀏覽器端到端（舊的插入流程）
node tools/verify-m7.mjs "<url含token>"            # headless 瀏覽器：chip rail 的完整 UX
```

- `verify-m7.mjs` 加 `QN_SEND=1` 會嘗試真的送出以驗證注入 —— 但**已知限制**：
  CDP 的自動打字打不進 Lexical 編輯器，所以這條鏈在 headless 下跑不完，
  要靠人手動送出驗證。
- 需要 Chromium 系瀏覽器；會自動尋找常見路徑，可用 `--edge <path>` 或 `QN_BROWSER` 指定。

---

## 隱私（本 repo 是**公開**的）

不得寫入憑證、真名、私人 email、帳號 ID、內網位址或**個人**絕對路徑。
路徑請用 `<DSH_HOME>`、`<workspace-root>`、`~` 這類佔位符 —— 本 repo 內刻意不出現任何
使用者機器的真實路徑。

commit 前請確認 git 的 `user.email` 是 GitHub noreply 位址或你願意公開的位址，
**不要**用私人 email 提交到公開 repo。
