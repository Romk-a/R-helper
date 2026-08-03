// content-jira.js — R-Helper content script for Jira Tests.jspa pages
// Shows tooltips/popups for BT-E execution links on test case pages
(async () => {
  "use strict";

  const settingsData = await chrome.storage.local.get("settings");
  if (!settingsData.settings || !settingsData.settings.jiraUrl) return;

  const R = window.RHelper;
  const JIRA_BASE = settingsData.settings.jiraUrl;
  const PROJECT_KEY = settingsData.settings.projectKey
    || (settingsData.settings.testCasePrefix || "").replace(/-T$/, "");
  if (!PROJECT_KEY) return;
  const TEST_CASE_PREFIX = PROJECT_KEY + "-T";
  const EXEC_PREFIX = PROJECT_KEY + "-E";

  let currentTooltip = null;
  let hoverTimeout = null;
  let tooltipRequestId = 0;
  let currentPopup = null;
  let active = false;

  // ===== Page detection =====

  function getTestCaseKeyFromHash() {
    const match = location.hash.match(/#\/testCase\/([\w-]+)/);
    return match ? match[1] : null;
  }

  const execRe = new RegExp("^" + EXEC_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d+$");

  function isExecutionLink(el) {
    if (!el || el.tagName !== "A") return null;
    const text = el.textContent.trim();
    return execRe.test(text) ? text : null;
  }

  // ===== Tooltip =====

  function removeTooltip() {
    tooltipRequestId++;
    if (currentTooltip) {
      currentTooltip.remove();
      currentTooltip = null;
    }
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
  }

  function showTooltip(link) {
    removeTooltip();

    const executionKey = link.textContent.trim();
    const testCaseKey = getTestCaseKeyFromHash();
    if (!testCaseKey) return;

    const requestId = ++tooltipRequestId;

    R.sendMessage({
      action: "getTestCaseResults",
      testCaseKey,
      executionKey,
      includeAttachments: false,
    }).then((resp) => {
      if (requestId !== tooltipRequestId) return;

      const tooltip = R.buildTooltipContent(resp, {
        onMore: () => showPopup(link),
        projectKey: PROJECT_KEY,
        testCaseKey,
        jiraBase: JIRA_BASE,
      });

      // Position to the right of the link
      const rect = link.getBoundingClientRect();
      tooltip.style.left = (rect.right + 8 + window.scrollX) + "px";
      tooltip.style.top = (rect.top + window.scrollY) + "px";

      document.body.appendChild(tooltip);
      currentTooltip = tooltip;

      tooltip.addEventListener("mouseenter", () => {
        if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
      });
      tooltip.addEventListener("mouseleave", () => {
        removeTooltip();
      });
    });
  }

  // ===== Popup =====

  function removePopup() {
    if (currentPopup) {
      currentPopup.remove();
      currentPopup = null;
    }
  }

  function showPopup(link) {
    removePopup();
    removeTooltip();

    const executionKey = link.textContent.trim();
    const testCaseKey = getTestCaseKeyFromHash();
    if (!testCaseKey) return;

    // Build header
    const titleSpan = document.createElement("span");
    titleSpan.className = "rhelper-popup-title";
    titleSpan.appendChild(document.createTextNode("Выполнение: "));
    const exLink = document.createElement("a");
    exLink.href = JIRA_BASE + "/secure/Tests.jspa#/testPlayer/testExecution/" + executionKey;
    exLink.target = "_blank";
    exLink.rel = "noopener";
    exLink.textContent = executionKey;
    titleSpan.appendChild(exLink);
    titleSpan.appendChild(document.createTextNode(" / Тест-кейс: "));
    const tcLink = document.createElement("a");
    tcLink.href = JIRA_BASE + "/secure/Tests.jspa#/testCase/" + testCaseKey;
    tcLink.target = "_blank";
    tcLink.rel = "noopener";
    tcLink.textContent = testCaseKey;
    titleSpan.appendChild(tcLink);

    const { overlay, body, setRemovePopup } = R.createPopupShell(titleSpan);

    document.body.appendChild(overlay);
    currentPopup = overlay;
    setRemovePopup(removePopup);

    R.sendMessage({
      action: "getTestCaseResults",
      testCaseKey,
      executionKey,
      includeAttachments: true,
    }).then((resp) => {
      if (!currentPopup || currentPopup !== overlay) return;

      if (!resp || resp.error) {
        body.textContent = "";
        const errDiv = document.createElement("div");
        errDiv.className = "rhelper-error";
        errDiv.textContent = resp?.error || "Не удалось загрузить данные. Проверьте, что вы авторизованы в Jira.";
        body.appendChild(errDiv);
        return;
      }

      if (!resp.found) {
        body.textContent = "";
        const nfDiv = document.createElement("div");
        nfDiv.className = "rhelper-error";
        nfDiv.textContent = "Result " + executionKey + " not found for test case " + testCaseKey + ".";
        body.appendChild(nfDiv);
        return;
      }

      R.renderPopupContent(body, resp, JIRA_BASE, PROJECT_KEY);
    });
  }

  // ===== Event handlers =====

  function onMouseOver(e) {
    const link = e.target.closest("a");
    if (!isExecutionLink(link)) return;

    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    hoverTimeout = setTimeout(() => {
      showTooltip(link);
    }, R.HOVER_DELAY);
  }

  function onMouseOut(e) {
    if (currentTooltip && currentTooltip.contains(e.relatedTarget)) return;
    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    hoverTimeout = setTimeout(() => removeTooltip(), 150);
  }

  function onClick(e) {
    const link = e.target.closest("a");
    if (!isExecutionLink(link)) return;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      showPopup(link);
    }
    // Normal click — default browser behavior (navigate)
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      if (R.hasLightbox()) {
        R.removeLightbox();
      } else if (currentPopup) {
        removePopup();
      }
    }
  }

  // ===== Activation / Deactivation =====

  function activate() {
    if (active) return;
    active = true;
    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.removeEventListener("mouseover", onMouseOver);
    document.removeEventListener("mouseout", onMouseOut);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown);
    removeTooltip();
    removePopup();
    R.removeLightbox();
  }

  function checkPage() {
    if (getTestCaseKeyFromHash()) {
      activate();
    } else {
      deactivate();
    }
  }

  // ===== Init =====

  // Auto-click tab if rhelper_tab param is present (e.g. opened from Confluence popup)
  function handleAutoTab() {
    const params = new URLSearchParams(location.search);
    const tab = params.get("rhelper_tab");
    if (!tab) return;

    // Clean up URL immediately
    params.delete("rhelper_tab");
    const clean = location.pathname + (params.size ? "?" + params : "") + location.hash;
    history.replaceState(null, "", clean);

    // Wait for AngularJS to render the tab, then click it
    const selector = 'li[on-select*="' + tab + '"] a';
    const tryClick = () => {
      const el = document.querySelector(selector);
      if (el) { el.click(); return true; }
      return false;
    };
    if (tryClick()) return;

    // Tab not yet rendered — observe DOM
    const observer = new MutationObserver(() => {
      if (tryClick()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Safety timeout — stop observing after 10s
    setTimeout(() => observer.disconnect(), 10000);
  }

  handleAutoTab();
  window.addEventListener("hashchange", checkPage);
  checkPage();
})();
