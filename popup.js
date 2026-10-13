const actionButtons = [...document.querySelectorAll("[data-action]")];
const statusBox = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const automationToggle = document.querySelector("#automation-toggle");
const earlyCheckoutDialog = document.querySelector("#early-checkout-dialog");
const checkinHint = document.querySelector("#check-in-hint");
const checkoutHint = document.querySelector("#check-out-hint");

const progressMessages = {
  "check-in": "LMS에서 등교 가능 여부를 확인하고 있어요…",
  "check-out": "LMS에서 하교 가능 여부를 확인하고 있어요…"
};

let busy = false;
let checkingStatus = true;
let attendanceStateKnown = false;
let todayCheckInCompleted = false;
let todayCheckOutCompleted = false;

function setBusy(isBusy) {
  busy = isBusy;
  updateActionButtonStates();
}

function updateActionButtonStates() {
  actionButtons.forEach((button) => {
    const completed = button.dataset.action === "check-in"
      ? todayCheckInCompleted
      : todayCheckOutCompleted;
    const checkInRequired =
      attendanceStateKnown &&
      button.dataset.action === "check-out" &&
      !todayCheckInCompleted;
    button.disabled = busy || checkingStatus || completed || checkInRequired;
  });

  checkinHint.textContent = todayCheckInCompleted
    ? "오늘 등교가 완료되었습니다"
    : "실제 LMS 등교 버튼 실행";
  checkoutHint.textContent = todayCheckOutCompleted
    ? "오늘 하교가 완료되었습니다"
    : attendanceStateKnown && !todayCheckInCompleted
      ? "오늘 등교 완료 후 사용할 수 있습니다"
      : "LMS에서 등교 완료를 확인한 뒤 실행";
}

function setStatus(kind, message) {
  statusBox.className = `status ${kind}`;
  statusText.textContent = message;
}

async function runAttendance(action, options = {}) {
  setBusy(true);
  setStatus("loading", progressMessages[action]);

  try {
    const result = await chrome.runtime.sendMessage({
      type: "RUN_ATTENDANCE",
      action,
      confirmedEarlyCheckout: Boolean(options.confirmedEarlyCheckout)
    });

    if (!result) {
      throw new Error("확장 프로그램에서 응답을 받지 못했습니다.");
    }

    setStatus(result.ok ? "success" : "error", result.message);
    if (result.ok) {
      attendanceStateKnown = true;
      if (action === "check-in") {
        todayCheckInCompleted = true;
      } else {
        todayCheckInCompleted = true;
        todayCheckOutCompleted = true;
      }
    } else if (result.code === "CHECK_IN_REQUIRED") {
      attendanceStateKnown = true;
      todayCheckInCompleted = false;
      todayCheckOutCompleted = false;
    }
  } catch (error) {
    setStatus("error", error?.message || "처리 중 알 수 없는 오류가 발생했습니다.");
  } finally {
    setBusy(false);
  }
}

actionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    if (action === "check-out" && AttendanceSchedule.stateFor("check-out").phase === "before") {
      const confirmed = await requestEarlyCheckoutConfirmation();
      if (!confirmed) {
        setStatus("idle", "하교 실행을 취소했습니다.");
        return;
      }
      await runAttendance(action, { confirmedEarlyCheckout: true });
      return;
    }

    await runAttendance(action);
  });
});

function requestEarlyCheckoutConfirmation() {
  return new Promise((resolve) => {
    earlyCheckoutDialog.addEventListener(
      "close",
      () => resolve(earlyCheckoutDialog.returnValue === "confirm"),
      { once: true }
    );
    earlyCheckoutDialog.showModal();
  });
}

automationToggle.addEventListener("change", async () => {
  automationToggle.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "SET_AUTOMATION_ENABLED",
      enabled: automationToggle.checked
    });
    if (result?.error) {
      throw new Error(result.error);
    }
    automationToggle.checked = Boolean(result?.enabled);
    setStatus(
      result?.enabled ? "success" : "idle",
      result?.enabled
        ? "자동 등교·하교 일정을 켰습니다."
        : "자동 실행을 껐습니다. 수동 버튼은 계속 사용할 수 있습니다."
    );
  } catch (error) {
    automationToggle.checked = !automationToggle.checked;
    setStatus("error", "자동 실행 설정을 변경하지 못했습니다.");
  } finally {
    automationToggle.disabled = false;
  }
});

async function loadAutomationStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_AUTOMATION_STATUS" });
    if (result?.error) {
      throw new Error(result.error);
    }
    automationToggle.checked = Boolean(result?.enabled);
  } catch (error) {
    automationToggle.disabled = true;
    setStatus("error", "자동 실행 상태를 불러오지 못했습니다.");
  }
}

async function loadAttendanceStatus() {
  checkingStatus = true;
  updateActionButtonStates();
  setStatus("loading", "현재 LMS 출석 상태를 확인하고 있어요…");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "GET_CURRENT_ATTENDANCE_STATUS"
    });
    if (!result) {
      throw new Error("확장 프로그램에서 응답을 받지 못했습니다.");
    }
    if (!result.ok) {
      throw new Error(result.message || "LMS 출석 상태를 확인하지 못했습니다.");
    }

    attendanceStateKnown = true;
    todayCheckOutCompleted = Boolean(result.checkOut?.ok);
    todayCheckInCompleted = Boolean(result.checkIn?.ok) || todayCheckOutCompleted;

    if (todayCheckOutCompleted) {
      const checkInTime = result.checkIn?.completedAt ? ` ${result.checkIn.completedAt}` : "";
      const checkOutTime = result.checkOut?.completedAt ? ` ${result.checkOut.completedAt}` : "";
      setStatus("success", `오늘 등교${checkInTime} · 하교${checkOutTime} 완료`);
    } else if (todayCheckInCompleted) {
      const checkInTime = result.checkIn?.completedAt ? ` ${result.checkIn.completedAt}` : "";
      setStatus("success", `오늘 등교${checkInTime} 완료 · 하교 전입니다.`);
    } else {
      setStatus("idle", "아직 등교 전입니다.");
    }
  } catch (error) {
    attendanceStateKnown = false;
    setStatus("error", error?.message || "LMS 출석 상태를 확인하지 못했습니다.");
  } finally {
    checkingStatus = false;
    updateActionButtonStates();
  }
}

updateActionButtonStates();
loadAutomationStatus();
loadAttendanceStatus();
