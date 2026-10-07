# dsh-quote-note

> **反白對話裡的文字，就地寫下你的想法 —— 它不會擠進你的輸入框，而是變成一顆小 chip 掛在旁邊；按送出時，模型同時看到「你指的是哪一段」與「你想說什麼」。**
> Select text in a DSH conversation, write what you think about it, and hand the model both the quote and your note — without cluttering the composer.

---

## 為什麼需要它

| 沒有這個插件 | 有了這個插件 |
|---|---|
| 「**這裡**的推論我看不懂」→ 模型得猜「這裡」是哪一段 | 被反白的原文會隨訊息一起送到模型，指涉範圍明確 |
| 想精確只能複製貼上原文，再手打「針對上面這段…」 | 反白 → 打字 → 加入，兩步完成 |
| 把引用塞進輸入框 → 佔位子，多則時草稿一團亂 | 引用掛在輸入框**外**的 chip，草稿保持乾淨 |

同一族問題的另一半（**圖片**上的標註）由獨立的 `dsh-annotate` 處理，兩者互不相干、可並存。

## 使用流程

1. **反白** — 在對話中選取任意文字（agent 回覆、你自己的訊息、任何可選取的文字）。
2. **點按鈕** — 選取處浮出「¶ 加想法」。
3. **寫想法** — 跳出的小輸入框可寫下針對這段文字的想法；`Ctrl/⌘+Enter` 加入、`Esc` 取消。
4. **加入引用** — 引用變成輸入框**外**上方的一顆 chip（`💬 引用文字開頭…`）。
   多則時 chip 橫向排列、自動換行，**主輸入框始終保持乾淨**。
5. **管理引用** — hover（或點）chip 會開面板，顯示「**引用的原文**」與可編輯的「**我的想法**」，
   可「儲存想法」或「刪除這則」。
6. **送出** — 照常在主輸入框按送出。host 會在該回合把引用注入成一條額外的 context 訊息，
   模型與 transcript 都看得到。

## 安裝

### 最快：把這個 repo 丟給你的 agent

對你的 coding agent 說一句：

> 把這個 repo 裝進我的 DSH（我在用 DSH Desktop）

它會讀 [`AGENTS.md`](./AGENTS.md) 並執行：

```sh
node tools/install.mjs --profile desktop            # 安裝
node tools/install.mjs --verify --profile desktop   # 驗證（唯讀，0=通過／1=未通過／2=用法或環境錯）
```

你也可以自己跑同一支腳本。`--profile` 省略時會先取環境變數 `DSH_PROFILE`，再退回 `desktop`；
想看它要做什麼而不寫任何檔，加 `--dry-run`。

**裝完必須重啟該 profile**（DSH Desktop 就重啟 Desktop）—— 新 bundle 不會熱載入。

腳本實際做的三件事、以及**不要**踩的坑（例如 `desktop` profile 不能用 `dsh plugin add`、
不要對它跑 pnpm、不要用 `host.call`），都寫在 [`AGENTS.md`](./AGENTS.md)。

### 手動（等同上面腳本做的事）

本插件設計為安裝在**單一 profile**。以 `desktop` profile（DSH Desktop 應用）為例：

```text
1) profile 的 package.json：
   - dependencies 加  "dsh-quote-note": "link:<workspace-root>/dsh-quote-note"
   - dsh.profile.bundles 加一列 "dsh-quote-note"
2) 在 profile 的 node_modules 下建立指向本目錄的目錄 junction／symlink：
   <DSH_HOME>/profiles/desktop/node_modules/dsh-quote-note -> <workspace-root>/dsh-quote-note
3) 重啟 DSH Desktop
```

**為什麼不用 `dsh plugin --profile desktop add`：** 該 profile 由 Electron 應用獨占管理，
CLI 會直接拒絕（`error: profile "desktop" is managed exclusively by the Electron application`）。
非 desktop 的 profile（例如 web）可以用官方指令：

```sh
dsh plugin --profile web add "<workspace-root>/dsh-quote-note"
```

## 移除

```sh
node tools/install.mjs --uninstall --profile desktop
```

只刪「連結本身」，不遞迴進目標目錄；`package.json` 會先備份再還原成安裝前的內容。
本插件不寫任何檔案、不建任何資料目錄，移除後不留殘骸。

## 設計

**兩半都有行為**：

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

| 位置 | slot | 用途 |
|---|---|---|
| `shell.overlay`（root, list） | `id: dsh-quote-note:floating` | 選取處的浮動按鈕與想法輸入框 |
| `conversation.input.dock`（session, list） | `id: dsh-quote-note:rail` | 輸入框**外**的 chip rail（官方 TodoDock／QueueDock 用的同一個座位） |
| `conversation.input.right`（session, list） | `id: dsh-quote-note:bridge` | 取得 `inputActions`，供**降級路徑**使用 |

- **client→host 傳輸**：認證的 `/api` route（`ctx.connection.fetch.register`），
  由 Connection 施加 Host/Origin 信任圍欄與瀏覽器 cookie 認證。
  **不是** `host.call` —— 那屬於動態定義套件（`cordis_define` + `harness.handle`），已安裝套件拿不到。
- **送出時注入**：host 在 `agent/pre-step`（官方 waterfall，語意就是「替換進入該 step 的訊息」）
  回傳 `{kind:'enter', messages:[...原訊息, 注入訊息]}`，然後清空該 session 的 pending。
  注入訊息用官方 `createUserMessage`，並帶本插件自己的 `source.kind`（`dsh-quote-note`）與
  `form: 'notice'` —— 這讓 transcript 能以 context 列呈現它。
  **官方 `dsh-session-reference`（`@session` 引用）用的是同一招。**
- **降級路徑**：若 `/api` route 同步失敗（別的 build／非 web 載體），會退回舊行為 ——
  把引用直接 `insertText` 進主輸入框，並顯示原因。內容不會默默丟掉。
- **取用官方 API 用錨點解析**（`host-compat.js`）：本插件的實際目錄不在 profile 的
  `node_modules` 底下，直接 import 官方套件會 `ERR_MODULE_NOT_FOUND`。

## 驗證

```sh
npm test                                        # 單元測試（node:test，直接載入 bundle 測純函式）
node tools/install.mjs --verify --profile <p>   # 安裝驗證（唯讀；0=通過／1=未通過／2=用法或環境錯）
node tools/verify-served.mjs "<url含token>"      # 對已啟動的實例驗證 bundle 真的被服務
node tools/verify-client.mjs "<url含token>"      # headless 瀏覽器：舊的插入流程
node tools/verify-m7.mjs "<url含token>"          # headless 瀏覽器：chip rail 的完整 UX
```

`verify-m7.mjs` 會在真瀏覽器裡驗：模組物化 → 三個 slot 註冊 → rail 掛載 → 反白 → 按鈕 →
面板 → **chip 出現在輸入框外且主輸入框保持空白** → 面板顯示原文與想法 → 編輯儲存 → 刪除。
瀏覽器由常見路徑自動尋找（Edge／Chrome），找不到時用 `--edge <path>` 或環境變數 `QN_BROWSER` 指定。
兩支驗證腳本都需要 Node 20 以上。

## 已知限制

1. **hover 面板在 headless 下無法自動驗證** —— 合成滑鼠事件不觸發 React 的 `onMouseEnter`；
   自動化測試是用「點擊」走同一條狀態路徑驗的。hover 本身請以人手確認。
2. **送出鏈路未在活體 app 上端到端驗證** —— CDP 的自動打字打不進 Lexical 編輯器，
   所以自動化無法完成「打字 → Enter → 檢查注入」。注入機制本身有實證
   （`agent/pre-step` 注入的訊息確實成為 durable 的 `user/message`），host 邏輯有假 ctx 整合測試，
   但「真人按送出」這一哩要靠使用者實測。
3. **pending 只在記憶體** —— 存在 host 的 Map 裡，**重啟 DSH 後消失**；頁面重整時 client 會送一次
   空清單去清掉 host 上的殘留，避免送出時夾帶使用者已看不到的引用。
4. **不帶來源定位** —— 引用區塊只有原文，沒有訊息 id、行號或時間戳；模型靠文字比對定位。
5. **一次最多 20 則**，引用上限 2000 字、想法 4000 字（超過截斷）。
6. **反白範圍不區分來源** —— 不判斷是 agent 回覆或使用者訊息，只看是否為可選取的非編輯區文字。
7. **`desktop` profile 不能用 CLI 驗證** —— 該 profile 由 Electron 獨占管理，
   `dsh --profile desktop --dump-config` 會被拒絕；安裝與驗證只能靠 `tools/install.mjs`。

## 相容性

實機驗證於 **DSH 0.1.7-alpha.2**（`@deepseek-ai/cordis` 4.0.4、Chromium 154 / Edge 154）。
`peerDependencies` 宣告 `@deepseek-ai/cordis: ">=4.0.0"`（optional）。

host 半需要 `connection` 服務（`ctx.connection.fetch.register`）；缺它的載體上插件仍會載入，
但會走降級路徑（引用直接插進輸入框）。

DSH 仍是 developer preview，契約會在小版本之間漂移。本插件把 DSH 專屬呼叫集中在
`client.js` 的 `insertIntoComposer()`／`apply()` 與 `host-compat.js`，契約變動時只需改這幾處。

## 開發

```text
dsh-quote-note/
├─ AGENTS.md             # 給別的 coding agent 的安裝／架構契約說明（「一句話裝好」的入口）
├─ package.json          # dsh.bundle.patch + dsh.client.platform（缺一不可）
├─ cordis.patch.yml      # 安裝時套用的 loader row
├─ index.js              # host 半：/api route ＋ agent/pre-step 注入
├─ host-compat.js        # host 側 DSH seam：錨點解析、payload 驗證、訊息建構
├─ client.js             # client 半：手寫 lazy-CJS bundle，零建置鏈，唯一真實來源
├─ test/                 # 單元測試 ＋ 假 ctx 整合測試 ＋ installer 測試
└─ tools/                # install.mjs（安裝／驗證／移除）＋ 三個真機驗證腳本
```

`client.js` 是手寫產物，不是建置輸出；改它不需要任何 build 步驟，測試會直接載入同一份檔案
（因此不存在「原始碼改了、瀏覽器載到舊 bundle」的新鮮度問題）。

License: MIT
