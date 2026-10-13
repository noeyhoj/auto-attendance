importScripts("schedule.js");

const LMS_URL = "https://techcourse-lms-plus-web.woowahan.com/crew";
const LMS_PATTERN = "https://techcourse-lms-plus-web.woowahan.com/*";
const ALARM_PREFIX = "attendance:";
const RETRY_INTERVAL_MS = 60_000;
const ACTION_NAMES = ["check-in", "check-out"];
const LEGACY_RESULT_KEYS = [
  "lastResult",
  "completionHistory",
  "dailyAttendance",
  "notificationHistory"
];
const notificationKeys = new Set();

chrome.runtime.onInstalled.addListener((details) => {
  initializeExtension(details).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  resumeAutomation().catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAlarm(alarm).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CURRENT_ATTENDANCE_STATUS") {
    getCurrentAttendanceStatus().then(sendResponse).catch((error) => {
      sendResponse(extensionError(error));
    });
    return true;
  }

  if (message?.type === "RUN_ATTENDANCE") {
    runManualAttendance(message.action, {
      confirmedEarlyCheckout: Boolean(message.confirmedEarlyCheckout)
    }).then(sendResponse).catch((error) => {
      sendResponse(extensionError(error));
    });
    return true;
  }

  if (message?.type === "GET_AUTOMATION_STATUS") {
    getAutomationStatus().then(sendResponse).catch((error) => {
      sendResponse({ enabled: false, error: error?.message });
    });
    return true;
  }

  if (message?.type === "SET_AUTOMATION_ENABLED") {
    setAutomationEnabled(Boolean(message.enabled)).then(sendResponse).catch((error) => {
      sendResponse({ enabled: false, error: error?.message });
    });
    return true;
  }

  return false;
});

clearStoredAttendanceResults()
  .then(ensureSchedule)
  .catch(console.error);

async function clearStoredAttendanceResults() {
  await chrome.storage.local.remove(LEGACY_RESULT_KEYS);
}

async function initializeExtension(details) {
  await clearStoredAttendanceResults();
  const stored = await chrome.storage.local.get("automationEnabled");
  if (typeof stored.automationEnabled !== "boolean") {
    await chrome.storage.local.set({ automationEnabled: true });
  }

  if (details.reason === "update") {
    await clearAttendanceAlarms();
  }

  await ensureSchedule();
  if (details.reason === "update") {
    await maybeCatchUp();
  }
}

async function resumeAutomation() {
  await clearStoredAttendanceResults();
  await ensureSchedule();
  await maybeCatchUp({ includeLateChecks: true });
}

async function getAutomationStatus() {
  const stored = await chrome.storage.local.get({ automationEnabled: true });
  return { enabled: stored.automationEnabled };
}

async function setAutomationEnabled(enabled) {
  await chrome.storage.local.set({ automationEnabled: enabled });

  if (enabled) {
    await ensureSchedule();
    await maybeCatchUp();
  } else {
    await clearAttendanceAlarms();
  }

  return { enabled };
}

async function isAutomationEnabled() {
  const stored = await chrome.storage.local.get({ automationEnabled: true });
  return stored.automationEnabled;
}

async function ensureSchedule() {
  if (!(await isAutomationEnabled())) {
    await clearAttendanceAlarms();
    return;
  }

  for (const action of ACTION_NAMES) {
    await ensureMainAlarm(action, "start");
    await ensureMainAlarm(action, "deadline");
  }
}

async function ensureMainAlarm(action, kind) {
  const name = alarmName(kind, action);
  if (await chrome.alarms.get(name)) {
    return;
  }

  const schedule = AttendanceSchedule.schedules[action];
  const hour = kind === "start" ? schedule.startHour : schedule.deadlineHour;
  const minute = kind === "start" ? schedule.startMinute : schedule.deadlineMinute;
  const offset = kind === "deadline" ? 5_000 : 0;
  const when = AttendanceSchedule.nextWeekdayTimestamp(hour, minute, Date.now() - offset) + offset;
  await chrome.alarms.create(name, { when });
}

async function rescheduleMainAlarm(action, kind) {
  await chrome.alarms.clear(alarmName(kind, action));
  await ensureMainAlarm(action, kind);
}

async function clearAttendanceAlarms() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => alarm.name.startsWith(ALARM_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );
}

function alarmName(kind, action) {
  return `${ALARM_PREFIX}${kind}:${action}`;
}

function parseAlarmName(name) {
  const match = /^attendance:(start|deadline|retry):(check-in|check-out)$/.exec(name);
  return match ? { kind: match[1], action: match[2] } : null;
}

async function handleAlarm(alarm) {
  const parsed = parseAlarmName(alarm.name);
  if (!parsed || !(await isAutomationEnabled())) {
    return;
  }

  if (parsed.kind === "start") {
    await rescheduleMainAlarm(parsed.action, "start");
    await runScheduledAttempt(parsed.action);
    return;
  }

  if (parsed.kind === "deadline") {
    await rescheduleMainAlarm(parsed.action, "deadline");
    await runDeadlineCheck(parsed.action);
    return;
  }

  await runScheduledAttempt(parsed.action);
}

async function maybeCatchUp({ includeLateChecks = false } = {}) {
  if (!(await isAutomationEnabled())) {
    return;
  }

  for (const action of ACTION_NAMES) {
    const state = AttendanceSchedule.stateFor(action);
    if (state.weekday && state.phase === "window") {
      await runScheduledAttempt(action);
    } else if (
      includeLateChecks &&
      state.weekday &&
      state.phase === "after" &&
      Date.now() < lateCheckCutoff(action, state.dateKey)
    ) {
      await runDeadlineCheck(action);
    }
  }
}

function lateCheckCutoff(action, dateKey) {
  return action === "check-in"
    ? AttendanceSchedule.timestampForSeoul(dateKey, 12, 0)
    : AttendanceSchedule.timestampForSeoul(dateKey, 23, 59);
}

async function runScheduledAttempt(action) {
  const state = AttendanceSchedule.stateFor(action);
  if (!state.weekday || state.phase !== "window") {
    return;
  }

  const result = await runLmsAction(action, { mode: "click", keepUnconfirmedTab: false });

  if (result.ok) {
    await chrome.alarms.clear(alarmName("retry", action));
    await notifyOnce("success", action, state.dateKey, {
      title: `자동 ${state.schedule.label} 완료`,
      message: result.completedAt
        ? `${result.completedAt}에 ${state.schedule.label} 처리가 완료되었습니다.`
        : result.code === "ALREADY_COMPLETE"
          ? `${state.schedule.label} 완료 상태를 확인했습니다.`
          : `${state.schedule.label} 처리가 정상적으로 완료되었습니다.`
    });
    return;
  }

  const retryAt = Date.now() + RETRY_INTERVAL_MS;
  if (retryAt < state.deadlineAt) {
    await chrome.alarms.create(alarmName("retry", action), { when: retryAt });
  }
}

async function runDeadlineCheck(action) {
  const state = AttendanceSchedule.stateFor(action);
  if (!state.weekday) {
    return;
  }

  await chrome.alarms.clear(alarmName("retry", action));
  const result = await runLmsAction(action, { mode: "inspect", keepUnconfirmedTab: false });

  if (result.ok) {
    await notifyOnce("success", action, state.dateKey, {
      title: `${state.schedule.label} 완료 확인`,
      message: result.completedAt
        ? `${result.completedAt}에 ${state.schedule.label} 처리가 완료된 것을 확인했습니다.`
        : `${state.schedule.label} 처리가 완료된 것을 확인했습니다.`
    });
    return;
  }

  await notifyOnce("failure", action, state.dateKey, {
    title: `자동 ${state.schedule.label} 확인 필요`,
    message: failureMessage(action, result, state)
  });
}

function failureMessage(action, result, state) {
  const prefixByCode = {
    LOGIN_REQUIRED: "LMS 로그인이 풀려 있습니다.",
    NETWORK_BLOCKED: "캠퍼스 네트워크로 확인되지 않았습니다.",
    BUTTON_DISABLED: "LMS 버튼이 비활성화되어 있습니다.",
    BUTTON_NOT_FOUND: "LMS에서 출석 버튼을 찾지 못했습니다.",
    PAGE_UNAVAILABLE: "LMS 화면을 불러오지 못했습니다.",
    CHECK_IN_REQUIRED: "등교 완료 상태를 확인하지 못했습니다.",
    PENDING: "아직 완료되지 않았습니다.",
    UNCONFIRMED: "버튼 실행 후 완료 상태를 확인하지 못했습니다."
  };
  const prefix = prefixByCode[result.code] || `${AttendanceSchedule.schedules[action].label} 완료를 확인하지 못했습니다.`;
  if (action === "check-in") {
    const attendanceDeadline = AttendanceSchedule.timestampForSeoul(state.dateKey, 10, 0);
    return Date.now() < attendanceDeadline
      ? `${prefix} 10시 전 직접 LMS에서 확인해 주세요.`
      : `${prefix} 등교 마감 시각이 지났으므로 LMS 상태를 직접 확인해 주세요.`;
  }
  return `${prefix} LMS에서 하교 상태를 확인해 주세요.`;
}

async function notifyOnce(kind, action, dateKey, options) {
  const key = `${kind}:${action}`;
  const datedKey = `${key}:${dateKey}`;
  if (notificationKeys.has(datedKey)) {
    return;
  }

  notificationKeys.add(datedKey);
  await chrome.notifications.create(`attendance-${kind}-${action}-${dateKey}`, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: options.title,
    message: options.message,
    priority: kind === "failure" ? 2 : 0
  });
}

async function runManualAttendance(action, options = {}) {
  if (
    action === "check-out" &&
    AttendanceSchedule.stateFor("check-out").phase === "before" &&
    !options.confirmedEarlyCheckout
  ) {
    const result = {
      ok: false,
      code: "EARLY_CHECKOUT_CONFIRMATION_REQUIRED",
      message: "18시 이전 하교는 사용자 확인 후에만 실행할 수 있습니다."
    };
    return result;
  }

  const result = await runLmsAction(action, { mode: "click", keepUnconfirmedTab: true });
  return result;
}

async function getCurrentAttendanceStatus() {
  const { tab, created } = await getOrCreateLmsTab();

  try {
    await waitForTabReady(tab.id, 25_000);
    const currentTab = await chrome.tabs.get(tab.id);

    if (!currentTab.url?.startsWith("https://techcourse-lms-plus-web.woowahan.com/")) {
      return {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "LMS 로그인이 필요합니다. 등교 또는 하교 버튼을 누르면 로그인 화면을 엽니다."
      };
    }

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const checkIn = await sendAttendanceMessage(tab.id, "check-in", "inspect");

    if (new Set(["LOGIN_REQUIRED", "NETWORK_BLOCKED", "PAGE_UNAVAILABLE"]).has(checkIn.code)) {
      return checkIn;
    }

    const checkOut = await sendAttendanceMessage(tab.id, "check-out", "inspect");
    if (new Set(["LOGIN_REQUIRED", "NETWORK_BLOCKED", "PAGE_UNAVAILABLE"]).has(checkOut.code)) {
      return checkOut;
    }

    return { ok: true, checkIn, checkOut };
  } finally {
    if (created) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function runLmsAction(action, options) {
  if (!ACTION_NAMES.includes(action)) {
    return { ok: false, code: "INVALID_ACTION", message: "지원하지 않는 작업입니다." };
  }

  const { tab, created } = await getOrCreateLmsTab();
  let keepCreatedTab = false;

  try {
    await waitForTabReady(tab.id, 25_000);
    const currentTab = await chrome.tabs.get(tab.id);

    if (!currentTab.url?.startsWith("https://techcourse-lms-plus-web.woowahan.com/")) {
      keepCreatedTab = true;
      await revealLoginTab(tab.id);
      return {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "LMS 로그인이 필요해 로그인 화면을 열었습니다. 로그인한 뒤 자동으로 다시 확인합니다."
      };
    }

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });

    if (action === "check-out" && options.mode === "click") {
      const checkInResult = await sendAttendanceMessage(tab.id, "check-in", "inspect");
      if (checkInResult.code === "LOGIN_REQUIRED") {
        keepCreatedTab = true;
        await revealLoginTab(tab.id);
        return {
          ok: false,
          code: "LOGIN_REQUIRED",
          message: "LMS 로그인이 필요해 로그인 화면을 열었습니다. 로그인한 뒤 자동으로 다시 확인합니다."
        };
      }

      if (!checkInResult.ok) {
        return {
          ok: false,
          code: "CHECK_IN_REQUIRED",
          message: "오늘 등교 완료가 확인되지 않아 하교를 실행하지 않았습니다. 먼저 등교 상태를 확인해 주세요."
        };
      }
    }

    const result = await sendAttendanceMessage(tab.id, action, options.mode);
    if (result.code === "LOGIN_REQUIRED") {
      keepCreatedTab = true;
      await revealLoginTab(tab.id);
      result.message = "LMS 로그인이 필요해 로그인 화면을 열었습니다. 로그인한 뒤 자동으로 다시 확인합니다.";
      return result;
    }

    await clearPendingLoginTab(tab.id);
    if (options.keepUnconfirmedTab && new Set(["PAGE_UNAVAILABLE", "UNCONFIRMED"]).has(result.code)) {
      keepCreatedTab = true;
      result.message += " 확인을 위해 LMS 탭은 백그라운드에 그대로 두었습니다.";
    }
    return result;
  } finally {
    if (created && !keepCreatedTab) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function getOrCreateLmsTab() {
  const stored = await chrome.storage.local.get("pendingLoginTabId");
  if (Number.isInteger(stored.pendingLoginTabId)) {
    try {
      const pendingLoginTab = await chrome.tabs.get(stored.pendingLoginTabId);
      return { tab: pendingLoginTab, created: false };
    } catch (error) {
      await chrome.storage.local.remove("pendingLoginTabId");
    }
  }

  const tabs = await chrome.tabs.query({ url: LMS_PATTERN });
  const existing = tabs.find((tab) => tab.url?.includes("/crew")) || tabs[0];

  if (existing) {
    if (!existing.url?.includes("/crew")) {
      await chrome.tabs.update(existing.id, { url: LMS_URL });
    }
    return { tab: existing, created: false };
  }

  const tab = await chrome.tabs.create({ url: LMS_URL, active: false });
  return { tab, created: true };
}

async function revealLoginTab(tabId) {
  const stored = await chrome.storage.local.get("pendingLoginTabId");
  const alreadyRevealed = stored.pendingLoginTabId === tabId;
  await chrome.storage.local.set({ pendingLoginTabId: tabId });

  if (!alreadyRevealed) {
    await chrome.tabs.update(tabId, { active: true });
  }
}

async function clearPendingLoginTab(tabId) {
  const stored = await chrome.storage.local.get("pendingLoginTabId");
  if (stored.pendingLoginTabId === tabId) {
    await chrome.storage.local.remove("pendingLoginTabId");
  }
}

async function waitForTabReady(tabId, timeoutMs) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("LMS 페이지를 불러오는 데 시간이 너무 오래 걸립니다."));
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function sendAttendanceMessage(tabId, action, mode) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "CLICK_ATTENDANCE",
      action,
      mode
    });
  } catch (error) {
    return {
      ok: false,
      code: "PAGE_UNAVAILABLE",
      message: "LMS 화면을 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요."
    };
  }
}

function extensionError(error) {
  return {
    ok: false,
    code: "EXTENSION_ERROR",
    message: error?.message || "확장 프로그램 처리 중 오류가 발생했습니다."
  };
}
