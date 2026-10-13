const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../popup.js"), "utf8");

function createElement(extra = {}) {
  return {
    addEventListener() {},
    className: "",
    disabled: false,
    textContent: "",
    ...extra
  };
}

async function renderPopup(attendanceResult) {
  const checkInButton = createElement({ dataset: { action: "check-in" } });
  const checkOutButton = createElement({ dataset: { action: "check-out" } });
  const elements = {
    "#status": createElement(),
    "#status-text": createElement(),
    "#automation-toggle": createElement({ checked: false }),
    "#early-checkout-dialog": createElement(),
    "#check-in-hint": createElement(),
    "#check-out-hint": createElement()
  };
  const context = {
    Promise,
    console,
    globalThis: null,
    AttendanceSchedule: {
      stateFor() {
        return { phase: "after" };
      }
    },
    document: {
      querySelector(selector) {
        return elements[selector];
      },
      querySelectorAll(selector) {
        return selector === "[data-action]" ? [checkInButton, checkOutButton] : [];
      }
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "GET_AUTOMATION_STATUS") {
            return { enabled: true };
          }
          if (message.type === "GET_CURRENT_ATTENDANCE_STATUS") {
            return attendanceResult;
          }
          throw new Error(`예상하지 못한 메시지: ${message.type}`);
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));

  return { checkInButton, checkOutButton, elements };
}

(async () => {
  const beforeCheckIn = await renderPopup({
    ok: true,
    checkIn: { ok: false, code: "PENDING" },
    checkOut: { ok: false, code: "PENDING" }
  });
  assert.equal(beforeCheckIn.elements["#status-text"].textContent, "아직 등교 전입니다.");
  assert.equal(beforeCheckIn.checkInButton.disabled, false);
  assert.equal(beforeCheckIn.checkOutButton.disabled, true);

  const afterCheckIn = await renderPopup({
    ok: true,
    checkIn: { ok: true, code: "ALREADY_COMPLETE", completedAt: "09:42" },
    checkOut: { ok: false, code: "PENDING" }
  });
  assert.equal(
    afterCheckIn.elements["#status-text"].textContent,
    "오늘 등교 09:42 완료 · 하교 전입니다."
  );
  assert.equal(afterCheckIn.checkInButton.disabled, true);
  assert.equal(afterCheckIn.checkOutButton.disabled, false);

  const afterCheckOut = await renderPopup({
    ok: true,
    checkIn: { ok: true, code: "ALREADY_COMPLETE", completedAt: "09:42" },
    checkOut: { ok: true, code: "ALREADY_COMPLETE", completedAt: "18:03" }
  });
  assert.equal(
    afterCheckOut.elements["#status-text"].textContent,
    "오늘 등교 09:42 · 하교 18:03 완료"
  );
  assert.equal(afterCheckOut.checkInButton.disabled, true);
  assert.equal(afterCheckOut.checkOutButton.disabled, true);

  console.log("popup live status tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
