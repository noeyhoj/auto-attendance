const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../content.js"), "utf8");

function createButton(label, onClick = () => {}) {
  return {
    innerText: label,
    value: "",
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    click: onClick
  };
}

function createPage(initialText, buttons = [], statusElements = []) {
  let listener;
  const body = { innerText: initialText };
  const context = {
    Promise,
    console,
    setTimeout,
    clearTimeout,
    globalThis: null,
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    },
    document: {
      body,
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "body *") {
          return statusElements;
        }
        return selector.includes("button") && !selector.includes("dialog") ? buttons : [];
      }
    },
    getComputedStyle() {
      return { visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" };
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    body,
    send(message) {
      return new Promise((resolve) => listener(message, {}, resolve));
    }
  };
}

(async () => {
  const completed = createPage("대시보드 등교 완료");
  assert.deepEqual(
    JSON.parse(JSON.stringify(await completed.send({
      type: "CLICK_ATTENDANCE",
      action: "check-in",
      mode: "click"
    }))),
    {
      ok: true,
      code: "ALREADY_COMPLETE",
      message: "등교 처리가 이미 완료되어 있습니다.",
      completedAt: null
    }
  );

  const recordedTime = createButton("09:39 9/28(월) 등교 완료");
  const completedWithTime = createPage("대시보드 09:39 등교 완료", [], [recordedTime]);
  const timedResult = await completedWithTime.send({
    type: "CLICK_ATTENDANCE",
    action: "check-in",
    mode: "inspect"
  });
  assert.equal(timedResult.completedAt, "09:39");

  const combinedCard = createButton("09:39 9/28 등교 완료 18:11 9/28 하교 완료");
  const checkoutWithTime = createPage(
    "대시보드 09:39 등교 완료 18:11 하교 완료",
    [],
    [combinedCard]
  );
  const checkoutResult = await checkoutWithTime.send({
    type: "CLICK_ATTENDANCE",
    action: "check-out",
    mode: "inspect"
  });
  assert.equal(checkoutResult.completedAt, "18:11");

  const blocked = createPage("대시보드 허용되지 않은 위치예요. 캠퍼스 네트워크에서 다시 시도 해 주세요.");
  const blockedResult = await blocked.send({ type: "CLICK_ATTENDANCE", action: "check-in", mode: "click" });
  assert.equal(blockedResult.code, "NETWORK_BLOCKED");

  const pendingButton = createButton("등교하기");
  const pending = createPage("대시보드 오늘의 출석", [pendingButton]);
  const pendingResult = await pending.send({ type: "CLICK_ATTENDANCE", action: "check-in", mode: "inspect" });
  assert.equal(pendingResult.code, "PENDING");

  let clickedPage;
  const clickButton = createButton("등교하기", () => {
    clickedPage.body.innerText = "대시보드 등교 완료";
  });
  clickedPage = createPage("대시보드 오늘의 출석", [clickButton]);
  const clickResult = await clickedPage.send({ type: "CLICK_ATTENDANCE", action: "check-in", mode: "click" });
  assert.equal(clickResult.code, "COMPLETE");

  let learningStartPage;
  const learningStartButton = createButton("학습 시작 등교할까요?", () => {
    learningStartPage.body.innerText = "대시보드 등교 완료";
  });
  learningStartPage = createPage("대시보드 등교 전", [learningStartButton]);
  const learningStartResult = await learningStartPage.send({
    type: "CLICK_ATTENDANCE",
    action: "check-in",
    mode: "click"
  });
  assert.equal(learningStartResult.code, "COMPLETE");

  const learningEndButton = createButton("학습 끝 등교 후 하교할 수 있어요");
  const learningEndPage = createPage("대시보드 등교 완료", [learningEndButton]);
  const learningEndResult = await learningEndPage.send({
    type: "CLICK_ATTENDANCE",
    action: "check-out",
    mode: "inspect"
  });
  assert.equal(learningEndResult.code, "PENDING");

  console.log("content tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
