/**
 * 安裝腳本的單元測試：只測純函式與「計畫」邏輯，不碰真實 profile。
 * 真機安裝／移除由 tools/install.mjs 對臨時 profile 實跑驗證（見驗收紀錄）。
 * 跑法：node --test
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_NAME,
  assertSafeProfileName,
  makeBackupStamp,
  makeLinkSpec,
  normalizeLinkTarget,
  planUnwiring,
  planWiring,
  removeEntry,
  upsertEntry,
} from "../tools/install.mjs";

test("assertSafeProfileName：接受正常名稱", () => {
  for (const name of ["desktop", "web", "headless", "my-profile", "p1.test", "a_b"]) {
    assert.equal(assertSafeProfileName(name), name);
  }
});

test("assertSafeProfileName：拒絕路徑穿越與不安全名稱", () => {
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "-lead", "..hidden", "a b", "a\u0000b"]) {
    assert.throws(() => assertSafeProfileName(bad), /不安全|不可為空/);
  }
});

test("makeLinkSpec：一律用正斜線", () => {
  const spec = makeLinkSpec("D:\\dev\\dsh-quote-note");
  assert.equal(spec.startsWith("link:"), true);
  assert.equal(spec.includes("\\"), false, "link: 規格不該含反斜線");
  assert.match(spec, /^link:[A-Za-z]:\/dev\/dsh-quote-note$/);
});

test("upsertEntry：加入一次、之後不再重複", () => {
  const a = upsertEntry(undefined, PLUGIN_NAME);
  assert.equal(a.changed, true);
  assert.deepEqual(a.list, [PLUGIN_NAME]);

  const b = upsertEntry(a.list, PLUGIN_NAME);
  assert.equal(b.changed, false, "第二次應為不變（冪等）");
  assert.deepEqual(b.list, [PLUGIN_NAME]);

  const c = upsertEntry(["x", PLUGIN_NAME, "y"], PLUGIN_NAME);
  assert.equal(c.changed, false);
  assert.deepEqual(c.list, ["x", PLUGIN_NAME, "y"], "既有順序不變");
});

test("removeEntry：移除所有相符項，不存在時回報不變", () => {
  assert.deepEqual(removeEntry(["a", PLUGIN_NAME, "b", PLUGIN_NAME], PLUGIN_NAME), { list: ["a", "b"], changed: true });
  assert.deepEqual(removeEntry(["a", "b"], PLUGIN_NAME), { list: ["a", "b"], changed: false });
  assert.deepEqual(removeEntry(undefined, PLUGIN_NAME), { list: [], changed: false });
});

test("makeBackupStamp：本機時間、格式固定、結尾不得有小數點", () => {
  const stamp = makeBackupStamp(new Date(2026, 9, 7, 3, 45, 23));
  assert.equal(stamp, "20261007-034523");
  assert.doesNotMatch(stamp, /[.\-:]$/, "結尾不該有標點");
  assert.match(stamp, /^\d{8}-\d{6}$/);
});

test("normalizeLinkTarget：處理 Windows junction 的 \\\\?\\ 前綴與大小寫", () => {
  assert.equal(
    normalizeLinkTarget("\\\\?\\D:\\Agent\\dsh-quote-note", "win32"),
    normalizeLinkTarget("d:/agent/dsh-quote-note/", "win32")
  );
  assert.equal(normalizeLinkTarget("/opt/plugin-root/", "linux"), "/opt/plugin-root");
});

test("planWiring：加入 bundles 與 dependencies，且不改動其他內容", () => {
  const before = {
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-win-notify"] } },
  };
  const snapshot = structuredClone(before);
  const { next, changes } = planWiring(before, "D:\\dev\\dsh-quote-note");

  assert.deepEqual(before, snapshot, "不得改動輸入物件");
  assert.equal(changes.length, 2);
  assert.deepEqual(next.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "dsh-win-notify", PLUGIN_NAME]);
  assert.equal(next.dependencies[PLUGIN_NAME], "link:D:/dev/dsh-quote-note");
  assert.equal(next.name, "dsh-profile-desktop", "其他欄位原樣保留");
  assert.equal(next.private, true);
});

test("planWiring：冪等——對已安裝的結果再跑一次不會有任何變更", () => {
  const first = planWiring({ dependencies: {}, dsh: { profile: { bundles: [] } } }, "/dev/dsh-quote-note");
  const second = planWiring(first.next, "/dev/dsh-quote-note");
  assert.deepEqual(second.changes, []);
});

test("planWiring：缺少 dsh／profile／bundles 時會建立", () => {
  const { next, changes } = planWiring({ name: "p" }, "/dev/dsh-quote-note");
  assert.deepEqual(next.dsh.profile.bundles, [PLUGIN_NAME]);
  assert.equal(changes.length, 2);
});

test("planUnwiring：移除兩個條目，其他 bundle 不動", () => {
  const installed = {
    dependencies: { other: "link:/elsewhere", [PLUGIN_NAME]: "link:/dev/dsh-quote-note" },
    dsh: { profile: { bundles: ["base", PLUGIN_NAME, "keep-me"] } },
  };
  const { next, changes } = planUnwiring(installed);
  assert.equal(changes.length, 2);
  assert.deepEqual(next.dsh.profile.bundles, ["base", "keep-me"]);
  assert.deepEqual(Object.keys(next.dependencies), ["other"]);
});

test("planUnwiring：未安裝時無變更且不丟錯", () => {
  assert.deepEqual(planUnwiring({ dependencies: {}, dsh: { profile: { bundles: ["base"] } } }).changes, []);
  assert.deepEqual(planUnwiring({}).changes, []);
});

test("planWiring／planUnwiring 互為反向（round-trip）", () => {
  const original = { name: "p", dependencies: { a: "link:/a" }, dsh: { profile: { bundles: ["base"] } } };
  const wired = planWiring(original, "/dev/dsh-quote-note").next;
  const unwired = planUnwiring(wired).next;
  assert.deepEqual(unwired, original);
});
