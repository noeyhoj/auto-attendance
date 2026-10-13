const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("../service-worker.js"), "utf8");
const storageWrites = source
  .split("\n")
  .filter((line) => line.includes("chrome.storage.local.set"));

assert.ok(storageWrites.length > 0, "자동 실행 설정 저장은 유지되어야 한다");
for (const line of storageWrites) {
  assert.match(
    line,
    /automationEnabled|pendingLoginTabId/,
    `출석 결과가 아닌 설정만 저장해야 한다: ${line.trim()}`
  );
}

for (const functionName of ["saveLastResult", "markCompleted", "wasCompletedOn"]) {
  assert.doesNotMatch(
    source,
    new RegExp(`function\\s+${functionName}\\b`),
    `${functionName} 함수로 출석 결과를 보관하면 안 된다`
  );
}

for (const legacyKey of [
  "lastResult",
  "completionHistory",
  "dailyAttendance",
  "notificationHistory"
]) {
  assert.match(source, new RegExp(`"${legacyKey}"`), `${legacyKey} 기존 기록을 제거해야 한다`);
}

console.log("storage privacy tests passed");
