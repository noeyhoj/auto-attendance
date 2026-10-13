(() => {
  if (globalThis.__lmsAttendanceHelperInstalled) {
    return;
  }
  globalThis.__lmsAttendanceHelperInstalled = true;

  const ACTIONS = {
    "check-in": {
      label: "등교",
      buttonPatterns: [
        /^등교(?:하기)?$/,
        /^등교\s*시작(?:\s|$)/,
        /^출석(?:하기)?$/,
        /^학습\s*시작(?:\s|$)/
      ],
      completePatterns: [/등교\s*완료/, /출석\s*완료/]
    },
    "check-out": {
      label: "하교",
      buttonPatterns: [/^하교(?:하기)?$/, /^학습\s*끝(?:\s|$)/],
      completePatterns: [/하교\s*완료/]
    }
  };

  const NETWORK_ERROR_PATTERNS = [
    /허용되지\s*않은\s*위치/,
    /캠퍼스\s*네트워크에서\s*다시\s*시도/,
    /허용되지\s*않은\s*네트워크/
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CLICK_ATTENDANCE") {
      return false;
    }

    clickAttendance(message.action, message.mode || "click")
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          code: "PAGE_ERROR",
          message: error?.message || "LMS 화면 처리 중 오류가 발생했습니다."
        });
      });

    return true;
  });

  async function clickAttendance(actionName, mode) {
    const action = ACTIONS[actionName];
    if (!action) {
      return { ok: false, code: "INVALID_ACTION", message: "지원하지 않는 작업입니다." };
    }

    await waitForPageContent(12_000);

    let pageText = visiblePageText();

    if (looksLikeLoginPage(pageText)) {
      return {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "LMS 로그인이 필요합니다. 사이트에서 로그인한 뒤 다시 시도해 주세요."
      };
    }

    if (matchesAny(pageText, action.completePatterns)) {
      const completedAt = extractCompletionTime(action);
      return {
        ok: true,
        code: "ALREADY_COMPLETE",
        message: completedAt
          ? `${action.label} 처리가 ${completedAt}에 완료되어 있습니다.`
          : `${action.label} 처리가 이미 완료되어 있습니다.`,
        completedAt
      };
    }

    if (matchesAny(pageText, NETWORK_ERROR_PATTERNS)) {
      return {
        ok: false,
        code: "NETWORK_BLOCKED",
        message: "캠퍼스 네트워크로 확인되지 않아 실행하지 않았습니다."
      };
    }

    const button = findAttendanceButton(action);
    if (!button) {
      const visibleLabels = visibleButtonLabels();
      return {
        ok: false,
        code: "BUTTON_NOT_FOUND",
        message: visibleLabels.length > 0
          ? `${action.label} 버튼을 찾지 못했습니다. 화면에서 확인된 버튼: ${visibleLabels.join(", ")}`
          : `${action.label} 버튼을 찾지 못했습니다. LMS 화면 또는 버튼 문구가 변경됐을 수 있습니다.`
      };
    }

    if (!isEnabled(button)) {
      return {
        ok: false,
        code: "BUTTON_DISABLED",
        message: `${action.label} 버튼이 현재 비활성화되어 있습니다.`
      };
    }

    if (mode === "inspect") {
      return {
        ok: false,
        code: "PENDING",
        message: `${action.label} 처리가 아직 완료되지 않았습니다.`
      };
    }

    button.click();
    await clickTargetedConfirmation(action);

    const result = await waitForResult(action, 10_000);
    if (result === "complete") {
      const completedAt = extractCompletionTime(action);
      return {
        ok: true,
        code: "COMPLETE",
        message: completedAt
          ? `${action.label} 처리가 ${completedAt}에 완료되었습니다.`
          : `${action.label} 처리가 완료되었습니다.`,
        completedAt
      };
    }

    if (result === "network") {
      return {
        ok: false,
        code: "NETWORK_BLOCKED",
        message: "캠퍼스 네트워크로 확인되지 않아 처리되지 않았습니다."
      };
    }

    return {
      ok: false,
      code: "UNCONFIRMED",
      message: `${action.label} 버튼은 눌렀지만 완료 상태를 확인하지 못했습니다. LMS에서 결과를 확인해 주세요.`
    };
  }

  function visiblePageText() {
    return normalize(document.body?.innerText || "");
  }

  function normalize(value) {
    return String(value).replace(/\s+/g, " ").trim();
  }

  function matchesAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
  }

  function extractCompletionTime(action) {
    const candidates = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const text = normalize(element.innerText || "");
        return (
          text.length <= 180 &&
          matchesAny(text, action.completePatterns) &&
          /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(text) &&
          isVisible(element)
        );
      });

    const options = candidates.flatMap((element) => {
      const text = normalize(element.innerText || "");
      const labelMatches = action.completePatterns
        .map((pattern) => text.match(pattern))
        .filter(Boolean);
      const labelIndex = Math.min(...labelMatches.map((match) => match.index));
      const timeMatches = [...text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
      return timeMatches.map((match) => ({
        time: `${match[1].padStart(2, "0")}:${match[2]}`,
        score: text.length * 1_000 + Math.abs(match.index - labelIndex)
      }));
    });

    options.sort((left, right) => left.score - right.score);
    return options[0]?.time || null;
  }

  function looksLikeLoginPage(pageText) {
    const hasPasswordField = Boolean(document.querySelector("input[type='password']"));
    const hasLoginLanguage = /(로그인|이메일로\s*계속|계정으로\s*계속)/.test(pageText);
    const hasDashboardLanguage = /(대시보드|등교|하교)/.test(pageText);
    return hasPasswordField || (hasLoginLanguage && !hasDashboardLanguage);
  }

  function findAttendanceButton(action) {
    const candidates = [
      ...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")
    ];

    return candidates.find((element) => {
      if (!isVisible(element)) {
        return false;
      }

      const label = normalize(
        element.innerText ||
          element.value ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          ""
      );

      if (/완료/.test(label)) {
        return false;
      }

      return action.buttonPatterns.some((pattern) => pattern.test(label));
    });
  }

  function visibleButtonLabels() {
    return [
      ...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")
    ]
      .filter(isVisible)
      .map((element) => normalize(
        element.innerText ||
          element.value ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          ""
      ))
      .filter(Boolean)
      .slice(0, 6);
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function isEnabled(element) {
    return !(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      getComputedStyle(element).pointerEvents === "none"
    );
  }

  async function waitForPageContent(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const text = visiblePageText();
      if (text.includes("대시보드") || text.includes("등교") || text.includes("하교")) {
        return;
      }
      await delay(250);
    }
  }

  async function clickTargetedConfirmation(action) {
    await delay(300);

    const dialogs = [...document.querySelectorAll("[role='dialog'], dialog")].filter(isVisible);
    const matchingDialog = dialogs.find((dialog) => normalize(dialog.innerText).includes(action.label));
    if (!matchingDialog) {
      return;
    }

    const confirmButton = [...matchingDialog.querySelectorAll("button, [role='button']")].find((element) => {
      const label = normalize(element.innerText || element.getAttribute("aria-label") || "");
      return isVisible(element) && isEnabled(element) && /^(확인|예|진행)$/.test(label);
    });

    confirmButton?.click();
  }

  async function waitForResult(action, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const text = visiblePageText();
      if (matchesAny(text, action.completePatterns)) {
        return "complete";
      }
      if (matchesAny(text, NETWORK_ERROR_PATTERNS)) {
        return "network";
      }
      await delay(300);
    }

    return "unknown";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
