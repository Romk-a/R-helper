(async () => {
  "use strict";

  const settingsData = await chrome.storage.local.get("settings");
  if (!settingsData.settings || !settingsData.settings.jiraUrl || !settingsData.settings.confluenceUrl) return;

  const R = window.RHelper;
  const JIRA_BASE = settingsData.settings.jiraUrl;
  const PROJECT_KEY = settingsData.settings.projectKey
    || (settingsData.settings.testCasePrefix || "").replace(/-T$/, "");
  if (!PROJECT_KEY) return;
  const TEST_CASE_PREFIX = PROJECT_KEY + "-T";
  const TEST_RUN_PREFIX = PROJECT_KEY + "-C";
  const PAINT_HISTORY_ENABLED = settingsData.settings.paintHistoryEnabled === true;
  const HISTORY_LIMIT = 20;

  let currentTooltip = null;
  let hoverTimeout = null;
  let tooltipRequestId = 0;
  let currentPopup = null;
  let currentColorPalette = null;
  let currentPaletteCell = null;
  let currentHighlightedCell = null;
  let highlightOverlay = null;
  let currentUserName = null;

  // ===== Table cell detection =====

  function getCellColumnIndex(cell) {
    let idx = 0;
    let prev = cell.previousElementSibling;
    while (prev) {
      idx += prev.colSpan || 1;
      prev = prev.previousElementSibling;
    }
    return idx;
  }

  function getColumnHeader(cell) {
    const table = cell.closest("table");
    if (!table) return null;

    const colIdx = getCellColumnIndex(cell);
    const headerRow = table.querySelector("tr");
    if (!headerRow) return null;

    let currentIdx = 0;
    for (const th of headerRow.children) {
      const span = th.colSpan || 1;
      if (colIdx >= currentIdx && colIdx < currentIdx + span) {
        return th.textContent.trim();
      }
      currentIdx += span;
    }
    return null;
  }

  function extractTestRunKey(headerText) {
    if (!headerText) return null;
    const match = headerText.match(/^C(\d+)$/);
    return match ? TEST_RUN_PREFIX + match[1] : null;
  }

  function extractTestCaseNumber(cellText) {
    const trimmed = cellText.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    return null;
  }

  function isTestCaseCell(cell) {
    if (cell.tagName !== "TD" && cell.tagName !== "TH") return false;
    const text = cell.textContent.trim();
    const num = extractTestCaseNumber(text);
    if (!num) return false;
    const header = getColumnHeader(cell);
    const runKey = extractTestRunKey(header);
    return !!runKey;
  }

  function getKeysFromCell(cell) {
    const text = cell.textContent.trim();
    const num = extractTestCaseNumber(text);
    if (!num) return null;
    const header = getColumnHeader(cell);
    const testRunKey = extractTestRunKey(header);
    if (!testRunKey) return null;
    return {
      testCaseKey: TEST_CASE_PREFIX + num,
      testRunKey,
    };
  }

  // ===== "Актуализация" table detection =====

  const testCasePrefixRe = new RegExp("^" + TEST_CASE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d+$");

  function isTestCaseKeyCell(cell) {
    if (cell.tagName !== "TD" && cell.tagName !== "TH") return false;
    return testCasePrefixRe.test(cell.textContent.trim());
  }

  function detectCell(cell) {
    if (!cell || (cell.tagName !== "TD" && cell.tagName !== "TH")) return null;
    const keys = getKeysFromCell(cell);
    if (keys) return { type: "testRun", ...keys };
    if (isTestCaseKeyCell(cell)) return { type: "testCase", testCaseKey: cell.textContent.trim() };
    return null;
  }

  // ===== Communication with background =====

  async function ensureCurrentUser() {
    if (currentUserName) return currentUserName;
    const resp = await R.sendMessage({ action: "getCurrentUser" });
    if (resp && !resp.error && resp.name) {
      currentUserName = resp.name;
    }
    return currentUserName;
  }

  function ensureHighlightOverlay() {
    if (highlightOverlay) return highlightOverlay;
    const el = document.createElement("div");
    el.className = "rhelper-highlight-overlay";
    el.setAttribute("data-mce-bogus", "all");
    el.style.display = "none";
    document.body.appendChild(el);
    highlightOverlay = el;
    return el;
  }

  function positionHighlightOverlay(cell) {
    const overlay = ensureHighlightOverlay();
    const rect = cell.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;

    const ownerDoc = cell.ownerDocument;
    if (ownerDoc !== document) {
      const iframe = findIframeFor(ownerDoc);
      if (iframe) {
        const iframeRect = iframe.getBoundingClientRect();
        left += iframeRect.left;
        top += iframeRect.top;
      }
    }

    overlay.style.left = (left + window.scrollX) + "px";
    overlay.style.top = (top + window.scrollY) + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    overlay.style.display = "block";
  }

  function clearCellHighlight() {
    if (highlightOverlay) {
      highlightOverlay.style.display = "none";
    }
    currentHighlightedCell = null;
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

  function positionTooltip(tooltip, cell) {
    const rect = cell.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top;

    const ownerDoc = cell.ownerDocument;
    if (ownerDoc !== document) {
      const iframe = findIframeFor(ownerDoc);
      if (iframe) {
        const iframeRect = iframe.getBoundingClientRect();
        left += iframeRect.left;
        top += iframeRect.top;
      }
    }

    tooltip.style.left = left + window.scrollX + "px";
    tooltip.style.top = top + window.scrollY + "px";
  }

  function mountTooltip(tooltip, cell) {
    positionTooltip(tooltip, cell);
    document.body.appendChild(tooltip);
    currentTooltip = tooltip;

    tooltip.addEventListener("mouseenter", () => {
      if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    });
    tooltip.addEventListener("mouseleave", () => {
      removeTooltip();
    });
  }

  function showTooltip(cell, e) {
    removeTooltip();

    const keys = getKeysFromCell(cell);
    if (!keys) return;

    const requestId = ++tooltipRequestId;

    R.sendMessage({
      action: "getTestResult",
      testRunKey: keys.testRunKey,
      testCaseKey: keys.testCaseKey,
      includeAttachments: false,
    }).then((resp) => {
      if (requestId !== tooltipRequestId) return;

      const painterClass = [...cell.classList].find(c => c.startsWith("rhelper-painter-"));
      const painter = painterClass ? painterClass.substring("rhelper-painter-".length) : "";
      const painterName = (painter && !cell.hasAttribute("title") && cell.hasAttribute("data-highlight-colour")) ? painter : null;

      const tooltip = R.buildTooltipContent(resp, {
        onMore: () => showPopup(cell),
        painterName,
        projectKey: PROJECT_KEY,
        testCaseKey: keys.testCaseKey,
      });

      mountTooltip(tooltip, cell);
    });
  }

  // ===== Popup =====

  function removePopup() {
    if (currentPopup) {
      currentPopup.remove();
      currentPopup = null;
    }
  }

  function showPopup(cell) {
    removePopup();
    removeTooltip();
    clearCellHighlight();

    const keys = getKeysFromCell(cell);
    if (!keys) return;

    // Build Confluence-specific header
    const titleSpan = document.createElement("span");
    titleSpan.className = "rhelper-popup-title";
    titleSpan.appendChild(document.createTextNode("Тест-кейс: "));
    const tcLink = document.createElement("a");
    tcLink.href = JIRA_BASE + "/secure/Tests.jspa#/testCase/" + keys.testCaseKey;
    tcLink.target = "_blank";
    tcLink.rel = "noopener";
    tcLink.textContent = keys.testCaseKey;
    titleSpan.appendChild(tcLink);
    titleSpan.appendChild(document.createTextNode(" / Прогон: "));
    const trLink = document.createElement("a");
    trLink.href = JIRA_BASE + "/secure/Tests.jspa#/testPlayer/" + keys.testRunKey;
    trLink.target = "_blank";
    trLink.rel = "noopener";
    trLink.textContent = keys.testRunKey;
    titleSpan.appendChild(trLink);
    titleSpan.appendChild(document.createTextNode(" / "));
    const allRunsLink = document.createElement("a");
    allRunsLink.href = JIRA_BASE + "/secure/Tests.jspa?rhelper_tab=TEST_RESULTS#/testCase/" + keys.testCaseKey;
    allRunsLink.target = "_blank";
    allRunsLink.rel = "noopener";
    allRunsLink.textContent = "Все запуски теста";
    titleSpan.appendChild(allRunsLink);

    const { overlay, body, setRemovePopup } = R.createPopupShell(titleSpan);

    document.body.appendChild(overlay);
    currentPopup = overlay;
    setRemovePopup(removePopup);

    R.sendMessage({
      action: "getTestResult",
      testRunKey: keys.testRunKey,
      testCaseKey: keys.testCaseKey,
    }).then((resp) => {
      if (!currentPopup || currentPopup !== overlay) return;

      if (!resp || resp.error) {
        body.textContent = "";
        const errDiv = document.createElement("div");
        errDiv.className = "rhelper-error";
        errDiv.textContent = resp?.error || "Error loading data. Make sure you are logged into Jira.";
        body.appendChild(errDiv);
        return;
      }

      if (!resp.found) {
        body.textContent = "";
        const nfDiv = document.createElement("div");
        nfDiv.className = "rhelper-error";
        nfDiv.textContent = "Test result for " + keys.testCaseKey + " not found in test run " + keys.testRunKey + ".";
        body.appendChild(nfDiv);
        return;
      }

      R.renderPopupContent(body, resp, JIRA_BASE, PROJECT_KEY);
    });
  }

  // ===== Test case info tooltip (Актуализация tables) =====

  function formatEstimatedTime(ms) {
    if (!ms || ms <= 0) return null;
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 60) return totalMin + " мин";
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? h + " ч " + m + " мин" : h + " ч";
  }

  function showTestCaseTooltip(cell, testCaseKey) {
    removeTooltip();

    const requestId = ++tooltipRequestId;

    R.sendMessage({
      action: "getTestCaseInfo",
      testCaseKey,
    }).then((resp) => {
      if (requestId !== tooltipRequestId) return;
      if (!resp || resp.error) return;

      const tooltip = document.createElement("div");
      tooltip.className = "rhelper-tooltip";
      tooltip.setAttribute("data-mce-bogus", "all");

      // Painter badge
      const painterClass = [...cell.classList].find(c => c.startsWith("rhelper-painter-"));
      if (painterClass && cell.hasAttribute("data-highlight-colour")) {
        const painterSpan = document.createElement("span");
        painterSpan.className = "rhelper-tooltip-painter";
        painterSpan.textContent = painterClass.substring("rhelper-painter-".length);
        tooltip.appendChild(painterSpan);
      }

      const fields = [];
      const cf = resp.customFields || {};
      if (cf["Режим ОС"]) fields.push(["Режим ОС", cf["Режим ОС"]]);
      if (cf["Package"]) fields.push(["Package", cf["Package"]]);
      if (resp.objective) fields.push(["Objective", resp.objective]);
      if (resp.component) fields.push(["Component", resp.component]);
      if (resp.folder) fields.push(["Folder", resp.folder]);
      const time = formatEstimatedTime(resp.estimatedTime);
      if (time) fields.push(["Время", time]);

      for (const [label, value] of fields) {
        const div = document.createElement("div");
        div.className = "rhelper-tooltip-field";
        const labelSpan = document.createElement("span");
        labelSpan.className = "rhelper-tooltip-field-label";
        labelSpan.textContent = label + ": ";
        div.appendChild(labelSpan);
        const valueSpan = document.createElement("span");
        valueSpan.innerHTML = value;
        div.appendChild(valueSpan);
        tooltip.appendChild(div);
      }

      if (fields.length === 0 && !tooltip.hasChildNodes()) {
        const emptySpan = document.createElement("span");
        emptySpan.style.color = "#999";
        emptySpan.textContent = "Нет данных";
        tooltip.appendChild(emptySpan);
      }

      mountTooltip(tooltip, cell);
    });
  }

  // ===== Color Palette =====

  const PALETTE_COLORS = [
    { color: "#ff8f73", title: "Умеренный красный 65 %" },
    { color: "#ffe380", title: "Умеренный жёлтый 45 %" },
    { color: "#79f2c0", title: "Умеренный зелёный 45 %" },
    { color: "#4c9aff", title: "Умеренный синий 65 %" },
    { color: "#998dd9", title: "Умеренный багровый 65 %" },
    { color: "#c1c7d0", title: "Умеренный серый 45 %" },
  ];

  function applyHighlight(cell, color, title) {
    for (const cls of [...cell.classList]) {
      if (cls.startsWith("highlight-") || cls.startsWith("rhelper-painter-")) cell.classList.remove(cls);
    }
    cell.classList.add("highlight-" + color);
    cell.setAttribute("data-highlight-colour", color);
    cell.removeAttribute("title");
    if (currentUserName) {
      cell.classList.add("rhelper-painter-" + currentUserName);
    }
  }

  function removeHighlight(cell) {
    for (const cls of [...cell.classList]) {
      if (cls.startsWith("highlight-") || cls.startsWith("rhelper-painter-")) cell.classList.remove(cls);
    }
    cell.removeAttribute("data-highlight-colour");
    cell.removeAttribute("title");
  }

  function pushHistoryClass(cell, colorOrNull, user) {
    if (!PAINT_HISTORY_ENABLED) return;
    if (!isEditorContext(cell)) return;
    if (!user) return;

    const ts = Date.now();
    const colorSlot = colorOrNull === null
      ? "000000"
      : String(colorOrNull).replace(/^#/, "").toLowerCase();
    const newClass = `rhh-${ts}-${colorSlot}-${user}`;

    const existing = [...cell.classList].filter(c => c.startsWith("rhh-"));
    for (const c of existing) cell.classList.remove(c);

    const all = [...existing, newClass]
      .sort((a, b) => {
        const ta = Number(a.split("-")[1]) || 0;
        const tb = Number(b.split("-")[1]) || 0;
        return ta - tb;
      })
      .slice(-HISTORY_LIMIT);

    for (const c of all) cell.classList.add(c);
  }

  function removeColorPalette() {
    if (currentColorPalette) {
      if (currentColorPalette._outsideListener) {
        document.removeEventListener("mousedown", currentColorPalette._outsideListener);
        if (currentColorPalette._cellDoc) {
          currentColorPalette._cellDoc.removeEventListener("mousedown", currentColorPalette._outsideListener);
        }
      }
      currentColorPalette.remove();
      currentColorPalette = null;
      currentPaletteCell = null;
    }
  }

  function showColorPalette(cell, e) {
    removeColorPalette();
    removeTooltip();
    clearCellHighlight();
    ensureCurrentUser();

    const palette = document.createElement("div");
    palette.className = "rhelper-color-palette";
    palette.setAttribute("data-mce-bogus", "all");
    R.applyThemeToElement(palette);

    PALETTE_COLORS.forEach(({ color, title }) => {
      const swatch = document.createElement("div");
      swatch.className = "rhelper-color-swatch";
      swatch.style.backgroundColor = color;
      swatch.dataset.color = color;
      swatch.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const user = await ensureCurrentUser();
        applyHighlight(cell, color, title);
        pushHistoryClass(cell, color, user);
        removeColorPalette();
      });
      palette.appendChild(swatch);
    });

    const removeSwatch = document.createElement("div");
    removeSwatch.className = "rhelper-color-swatch rhelper-color-remove";
    removeSwatch.title = "Убрать заливку";
    removeSwatch.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const user = await ensureCurrentUser();
      removeHighlight(cell);
      pushHistoryClass(cell, null, user);
      removeColorPalette();
    });
    palette.appendChild(removeSwatch);

    // Position above and slightly left of the cell
    const rect = cell.getBoundingClientRect();
    let left = rect.left - 4;
    let top = rect.top;

    const ownerDoc = cell.ownerDocument;
    if (ownerDoc !== document) {
      const iframe = findIframeFor(ownerDoc);
      if (iframe) {
        const iframeRect = iframe.getBoundingClientRect();
        left += iframeRect.left;
        top += iframeRect.top;
      }
    }

    document.body.appendChild(palette);
    currentColorPalette = palette;
    currentPaletteCell = cell;

    const paletteHeight = palette.offsetHeight;
    palette.style.left = (left + window.scrollX) + "px";
    palette.style.top = (top + window.scrollY - paletteHeight - 4) + "px";

    // Close on click outside
    const cellDoc = cell.ownerDocument;
    const outsideListener = (ev) => {
      if (!palette.contains(ev.target) && !cell.contains(ev.target)) {
        removeColorPalette();
      }
    };
    palette._outsideListener = outsideListener;
    palette._cellDoc = cellDoc !== document ? cellDoc : null;
    setTimeout(() => {
      document.addEventListener("mousedown", outsideListener);
      if (cellDoc !== document) {
        cellDoc.addEventListener("mousedown", outsideListener);
      }
    }, 0);
  }

  // ===== Event handling =====

  function handleMouseOver(e) {
    const cell = e.target.closest("td, th");
    const detected = detectCell(cell);
    if (!detected) return;

    currentHighlightedCell = cell;
    positionHighlightOverlay(cell);

    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    hoverTimeout = setTimeout(() => {
      if (detected.type === "testRun") {
        showTooltip(cell, e);
      } else {
        showTestCaseTooltip(cell, detected.testCaseKey);
      }
    }, R.HOVER_DELAY);
  }

  function handleMouseOut(e) {
    const cell = e.target.closest("td, th");
    if (cell && currentHighlightedCell === cell) {
      clearCellHighlight();
    }
    // Don't hide if mouse is moving to/within the tooltip
    if (currentTooltip && currentTooltip.contains(e.relatedTarget)) return;
    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    hoverTimeout = setTimeout(() => removeTooltip(), 150);
  }

  function findIframeFor(doc) {
    if (doc === document) return null;
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument === doc) return iframe;
      } catch (e) { /* cross-origin */ }
    }
    return null;
  }

  function isEditorContext(cell) {
    const body = cell.ownerDocument.body;
    return body && body.classList.contains("mce-content-body");
  }

  function handleMouseDown(e) {
    const cell = e.target.closest("td, th");
    if (!detectCell(cell)) return;
    if (isEditorContext(cell)) {
      e.preventDefault();
    }
  }

  function handleClick(e) {
    const cell = e.target.closest("td, th");
    const detected = detectCell(cell);
    if (!detected) {
      clearCellHighlight();
      removeColorPalette();
      return;
    }

    if (isEditorContext(cell)) {
      if (detected.type === "testCase" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        const link = cell.querySelector("a[href]");
        if (link) (window.top || window).open(link.href, "_blank");
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        showPopup(cell);
      } else if (currentColorPalette && currentPaletteCell === cell) {
        removeColorPalette();
        if (detected.type === "testRun") {
          showTooltip(cell, e);
        }
      } else {
        showColorPalette(cell, e);
      }
      return;
    }

    // View mode
    if (detected.type === "testRun") {
      e.preventDefault();
      e.stopPropagation();
      showPopup(cell);
    }
    // testCase в просмотре → переход по ссылке (не блокируем)
  }

  function handleKeyDown(e) {
    if (e.key === "Escape") {
      if (currentColorPalette) {
        removeColorPalette();
      } else if (R.hasLightbox()) {
        R.removeLightbox();
      } else {
        removePopup();
      }
    }
  }

  // ===== Init =====

  const attachedRoots = new WeakSet();

  function attach(root) {
    if (attachedRoots.has(root)) return;
    attachedRoots.add(root);
    root.addEventListener("mouseover", handleMouseOver);
    root.addEventListener("mouseout", handleMouseOut);
    root.addEventListener("mousedown", handleMouseDown);
    root.addEventListener("click", handleClick);
    root.addEventListener("keydown", handleKeyDown);
  }

  function injectCssInto(doc) {
    if (doc.querySelector("link[data-rhelper-css]")) return;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("content.css");
    link.setAttribute("data-rhelper-css", "1");
    (doc.head || doc.documentElement).appendChild(link);
  }

  function attachIframe(iframe) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (iframeDoc && iframeDoc.body) {
        injectCssInto(iframeDoc);
        attach(iframeDoc);
      }
    } catch (e) {
      // Cross-origin iframe, ignore
    }
  }

  function tryAttachIframe(iframe) {
    // Attach now if ready
    attachIframe(iframe);
    // Also attach on load (editor iframe may not have content yet)
    iframe.addEventListener("load", () => attachIframe(iframe));
  }

  // Attach to main document
  attach(document);

  // Observe for new iframes (Confluence editor)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "IFRAME") {
          tryAttachIframe(node);
        }
        // Also check nested iframes inside added subtrees
        if (node.querySelectorAll) {
          node.querySelectorAll("iframe").forEach(tryAttachIframe);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Attach to any existing iframes
  document.querySelectorAll("iframe").forEach(tryAttachIframe);

  // ===== Collect test run keys from page =====

  function collectTestRunKeys(doc, existingSet) {
    const keys = existingSet || new Set();
    const tables = doc.querySelectorAll("table");
    for (const table of tables) {
      const headerRow = table.querySelector("tr");
      if (!headerRow) continue;
      for (const cell of headerRow.children) {
        const runKey = extractTestRunKey(cell.textContent.trim());
        if (runKey) keys.add(runKey);
      }
    }
    return keys;
  }

  // ===== Message listener for popup =====

  function collectInProgressCells(doc, username, results) {
    const cells = doc.querySelectorAll('td[data-highlight-colour="#ffe380"]');
    cells.forEach((cell) => {
      if (!cell.classList.contains("rhelper-painter-" + username)) return;
      const text = cell.textContent.trim();
      const num = extractTestCaseNumber(text);
      if (num) {
        results.push(num);
      } else if (isTestCaseKeyCell(cell)) {
        results.push(text);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getPageTestRunKeys") {
      const keys = collectTestRunKeys(document);
      document.querySelectorAll("iframe").forEach((iframe) => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc) collectTestRunKeys(doc, keys);
        } catch (e) { /* cross-origin */ }
      });
      sendResponse({ keys: Array.from(keys) });
    }

    if (message.action === "scrollToCell") {
      const num = message.cellNumber;
      let target = null;

      function findCell(doc) {
        if (target) return;
        const cells = doc.querySelectorAll('td[data-highlight-colour="#ffe380"]');
        for (const cell of cells) {
          if (cell.textContent.trim() === num) { target = cell; return; }
        }
      }

      findCell(document);
      if (!target) {
        document.querySelectorAll("iframe").forEach((iframe) => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc) findCell(doc);
          } catch (e) { /* cross-origin */ }
        });
      }

      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("rhelper-flash");
        setTimeout(() => target.classList.remove("rhelper-flash"), 1500);
      }
      sendResponse({ found: !!target });
    }

    if (message.action === "getInProgressCells") {
      (async () => {
        const username = await ensureCurrentUser();
        if (!username) {
          sendResponse({ username: null, cells: [] });
          return;
        }
        const cells = [];
        collectInProgressCells(document, username, cells);
        document.querySelectorAll("iframe").forEach((iframe) => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc) collectInProgressCells(doc, username, cells);
          } catch (e) { /* cross-origin */ }
        });
        sendResponse({ username, cells });
      })();
      return true;
    }
  });
})();
