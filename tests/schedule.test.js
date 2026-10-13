const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { Date, console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve("../schedule.js"), "utf8"), context);

const schedule = context.AttendanceSchedule;

function utc(value) {
  return new Date(value).getTime();
}

assert.equal(
  schedule.schedules["check-in"].startMinute,
  35,
  "등교 자동 실행은 09:35에 시작해야 한다"
);

assert.equal(
  schedule.nextWeekdayTimestamp(9, 35, utc("2026-09-28T00:34:00Z")),
  utc("2026-09-28T00:35:00Z"),
  "지정 시각 이전에는 같은 날 일정을 예약해야 한다"
);

assert.equal(
  schedule.nextWeekdayTimestamp(9, 35, utc("2026-10-02T00:36:00Z")),
  utc("2026-10-05T00:35:00Z"),
  "금요일 시작 시각이 지나면 다음 월요일을 예약해야 한다"
);

assert.equal(
  schedule.stateFor("check-in", utc("2026-09-28T00:59:00Z")).phase,
  "window",
  "등교 자동 실행 구간은 09:35~10:00이다"
);

assert.equal(
  schedule.stateFor("check-in", utc("2026-09-28T01:00:00Z")).phase,
  "after",
  "10:00부터는 등교 최종 확인 구간이다"
);

assert.equal(
  schedule.stateFor("check-out", utc("2026-09-28T09:05:00Z")).phase,
  "window",
  "하교 자동 실행 구간은 18:00~18:10이다"
);

assert.equal(
  schedule.stateFor("check-out", utc("2026-09-28T08:59:00Z")).phase,
  "before",
  "18시 이전 수동 하교는 조기 하교 확인 대상이다"
);

assert.equal(
  schedule.dateKeyFromTimestamp(utc("2026-09-28T14:59:59Z")),
  "2026-09-28",
  "한국 시간 자정 전에는 이전 날짜이다"
);

assert.equal(
  schedule.dateKeyFromTimestamp(utc("2026-09-28T15:00:00Z")),
  "2026-09-29",
  "한국 시간 자정에 날짜가 초기화되어야 한다"
);

assert.equal(
  schedule.stateFor("check-in", utc("2026-10-03T00:52:00Z")).weekday,
  false,
  "주말에는 자동 실행하지 않아야 한다"
);

console.log("schedule tests passed");
