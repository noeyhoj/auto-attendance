globalThis.AttendanceSchedule = (() => {
  const SEOUL_OFFSET_HOURS = 9;

  const schedules = Object.freeze({
    "check-in": Object.freeze({
      label: "등교",
      startHour: 9,
      startMinute: 35,
      deadlineHour: 10,
      deadlineMinute: 0
    }),
    "check-out": Object.freeze({
      label: "하교",
      startHour: 18,
      startMinute: 0,
      deadlineHour: 18,
      deadlineMinute: 10
    })
  });

  function dateKeyFromTimestamp(timestamp) {
    const shifted = new Date(timestamp + SEOUL_OFFSET_HOURS * 60 * 60 * 1000);
    return [
      shifted.getUTCFullYear(),
      String(shifted.getUTCMonth() + 1).padStart(2, "0"),
      String(shifted.getUTCDate()).padStart(2, "0")
    ].join("-");
  }

  function parseDateKey(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return { year, month, day };
  }

  function addDays(dateKey, amount) {
    const { year, month, day } = parseDateKey(dateKey);
    const date = new Date(Date.UTC(year, month - 1, day + amount));
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0")
    ].join("-");
  }

  function weekdayForDateKey(dateKey) {
    const { year, month, day } = parseDateKey(dateKey);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  function isWeekday(dateKey) {
    const weekday = weekdayForDateKey(dateKey);
    return weekday >= 1 && weekday <= 5;
  }

  function timestampForSeoul(dateKey, hour, minute) {
    const { year, month, day } = parseDateKey(dateKey);
    return Date.UTC(year, month - 1, day, hour - SEOUL_OFFSET_HOURS, minute, 0, 0);
  }

  function nextWeekdayTimestamp(hour, minute, now = Date.now()) {
    const today = dateKeyFromTimestamp(now);

    for (let offset = 0; offset < 8; offset += 1) {
      const dateKey = addDays(today, offset);
      if (!isWeekday(dateKey)) {
        continue;
      }

      const candidate = timestampForSeoul(dateKey, hour, minute);
      if (candidate > now) {
        return candidate;
      }
    }

    throw new Error("다음 평일 일정을 계산하지 못했습니다.");
  }

  function stateFor(actionName, now = Date.now()) {
    const schedule = schedules[actionName];
    if (!schedule) {
      throw new Error("지원하지 않는 일정입니다.");
    }

    const dateKey = dateKeyFromTimestamp(now);
    const startAt = timestampForSeoul(dateKey, schedule.startHour, schedule.startMinute);
    const deadlineAt = timestampForSeoul(dateKey, schedule.deadlineHour, schedule.deadlineMinute);
    const weekday = isWeekday(dateKey);
    const phase = now < startAt ? "before" : now < deadlineAt ? "window" : "after";

    return { actionName, schedule, dateKey, startAt, deadlineAt, weekday, phase };
  }

  return {
    schedules,
    dateKeyFromTimestamp,
    isWeekday,
    nextWeekdayTimestamp,
    stateFor,
    timestampForSeoul
  };
})();
