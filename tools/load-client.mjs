/**
 * 測試輔助：以假的 window.__ModuleLoader__ 載入 client.js（lazy-CJS 信封），
 * 讓我們不必建置、也不必跑瀏覽器就能測 bundle 內的純函式。
 * 同時驗證信封本身：id 必須等於套件名，且 factory 必須回傳含 apply/inject 的 exports。
 *
 * 放在 tools/ 而非 test/ —— Node 的測試探索會把 test/ 底下所有 .js 當成測試檔。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLIENT_PATH = join(HERE, "..", "client.js");

/** 只夠讓模組層級程式碼與純函式跑起來的 React 假物件。 */
export const reactStub = {
  createElement() {
    return null;
  },
  useState() {
    return [null, () => {}];
  },
  useEffect() {},
  useRef() {
    return { current: null };
  },
};

/**
 * @param {{react?: object, document?: object}} [options]
 * @returns {{id: string, exports: object, loaded: boolean}}
 */
export function loadClient(options = {}) {
  const source = readFileSync(CLIENT_PATH, "utf8");
  const registered = [];
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        registered.push(entry);
      },
    },
  };
  const requireStub = (name) => {
    if (name === "react") return options.react ?? reactStub;
    throw new Error("unexpected require in client bundle: " + name);
  };

  // client.js 頂層只讀 window；document 只在函式內用到。
  const run = new Function("window", "document", source);
  run(windowStub, options.document);

  if (registered.length !== 1) {
    throw new Error(`client.js 應該只註冊一個 factory，實際 ${registered.length} 個`);
  }
  const entry = registered[0];
  const exports = entry.factory(requireStub);
  return { id: entry.id, exports, loaded: true };
}
