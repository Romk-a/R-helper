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

  // Состояние плавающей панели «Мои в разборе» (сама панель — в конце файла).
  // Объявлено здесь, потому что attachIframe() дёргает scheduleDockUpdate() ещё
  // на синхронном проходе скрипта — объявления ниже попали бы в TDZ.
  const DOCK_STATE_KEY = "dockState"; // тот же ключ объявлен в popup.js — менять парой
  const DOCK_UPDATE_DELAY = 300;
  const DOCK_DEFAULT_TOP = 92;    // ниже плавающей шапки Confluence
  const DOCK_MARGIN = 16;
  const DOCK_HEAD_KEEP = 80;      // столько пикселей панели держим видимыми у нижнего края
  const DOCK_COLUMNS = 4;         // максимум номеров в ряду
  // Таблицы появляются не сразу: в режиме просмотра — вскоре после document_idle,
  // в редакторе — только когда прогрузится и отрисуется iframe
  const DOCK_RETRY_DELAYS = [1500, 3000, 6000, 10000, 15000];

  let dockEl = null;
  let dockUpdateTimeout = null;
  // Пока состояние не прочитано из storage, панель не строим: иначе скрытая
  // крестиком панель успела бы мелькнуть на ранних пересчётах
  let dockStateLoaded = false;
  // top/left — null, пока панель не перетаскивали: тогда она сама встаёт в правый верхний угол
  let dockState = { hidden: false, collapsed: false, top: null, left: null };

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

      const painter = getPainterName(cell);
      const painterName = (painter && !cell.hasAttribute("title") && cell.hasAttribute("data-highlight-colour")) ? painter : null;

      const tooltip = R.buildTooltipContent(resp, {
        onMore: () => showPopup(cell),
        painterName,
        painterTime: painterName ? getLastPaintTime(cell) : null,
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

    const titleBlock = document.createElement("div");
    titleBlock.className = "rhelper-popup-title-block";
    titleBlock.appendChild(titleSpan);
    const subtitleDiv = document.createElement("div");
    subtitleDiv.className = "rhelper-popup-subtitle";
    titleBlock.appendChild(subtitleDiv);
    const packageDiv = document.createElement("div");
    packageDiv.className = "rhelper-popup-package";
    titleBlock.appendChild(packageDiv);

    const { overlay, body, setRemovePopup } = R.createPopupShell(titleBlock);

    document.body.appendChild(overlay);
    currentPopup = overlay;
    setRemovePopup(removePopup);

    R.sendMessage({
      action: "getTestCaseInfo",
      testCaseKey: keys.testCaseKey,
    }).then((info) => {
      if (!currentPopup || currentPopup !== overlay) return;
      if (info && !info.error) {
        if (info.name) subtitleDiv.textContent = info.name;
        const pkg = info.customFields && info.customFields["Package"];
        if (pkg) {
          const labelSpan = document.createElement("span");
          labelSpan.className = "rhelper-popup-package-label";
          labelSpan.textContent = "Пакеты: ";
          const valueSpan = document.createElement("span");
          valueSpan.className = "rhelper-popup-package-value";
          valueSpan.textContent = pkg;
          packageDiv.appendChild(labelSpan);
          packageDiv.appendChild(valueSpan);
        }
      }
    });

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
        errDiv.textContent = resp?.error || "Не удалось загрузить данные. Проверьте, что вы авторизованы в Jira.";
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
      const painter = getPainterName(cell);
      if (painter && cell.hasAttribute("data-highlight-colour")) {
        const painterSpan = document.createElement("span");
        painterSpan.className = "rhelper-tooltip-painter";
        painterSpan.textContent = painter;
        const paintTime = getLastPaintTime(cell);
        if (paintTime) painterSpan.title = paintTime;
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

  // Цвет «ячейка в разборе»
  const IN_PROGRESS_COLOR = "#ffe380";
  const IN_PROGRESS_SLOT = "ffe380"; // как цвет записан в rhh-классах истории
  const IN_PROGRESS_SELECTOR = `td[data-highlight-colour="${IN_PROGRESS_COLOR}" i]`;

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

  // Метка времени последней покраски ячейки (из rhh-* классов вида rhh-<ts>-<цвет>-<юзер>),
  // 0 если истории нет. colorSlot («ffe380») ограничивает поиск покраской в конкретный цвет.
  function getLastPaintTs(cell, colorSlot) {
    let maxTs = 0;
    for (const cls of cell.classList) {
      if (!cls.startsWith("rhh-")) continue;
      const parts = cls.split("-");
      if (colorSlot && parts[2] !== colorSlot) continue;
      const ts = Number(parts[1]) || 0;
      if (ts > maxTs) maxTs = ts;
    }
    return maxTs;
  }

  function formatPaintTs(ts) {
    return new Date(ts).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }

  // Возвращает абсолютное время последней покраски ячейки (из rhh-* классов)
  // в виде строки для title, либо null если истории нет.
  function getLastPaintTime(cell) {
    const ts = getLastPaintTs(cell);
    return ts ? "Покрашено: " + formatPaintTs(ts) : null;
  }

  function getPainterName(cell) {
    const cls = [...cell.classList].find(c => c.startsWith("rhelper-painter-"));
    return cls ? cls.substring("rhelper-painter-".length) : null;
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
        scheduleDockUpdate();
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
      scheduleDockUpdate();
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

  // Вызывает fn для документа каждого доступного (same-origin) iframe страницы
  function forEachIframeDoc(fn) {
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) fn(doc);
      } catch (e) { /* cross-origin */ }
    }
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
        // Таблицы редактора живут в iframe — панель считаем после его готовности
        scheduleDockUpdate();
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

  // ===== Page statistics =====

  const UNKNOWN_PAINTER = "Неизвестно";
  const FLASH_DURATION = 1500; // синхронно с анимацией .rhelper-flash в content.css
  const COMMENT_HEADER_RE = /^коммент/i;
  const COMMENT_HEADER_ROWS = 2; // шапка таблицы занимает до двух строк

  // Ищет столбец комментариев в шапке: { row, index } или null.
  function findCommentColumn(table) {
    const rows = Math.min(COMMENT_HEADER_ROWS, table.rows.length);
    for (let r = 0; r < rows; r++) {
      const cells = table.rows[r].children;
      for (let i = 0; i < cells.length; i++) {
        if (COMMENT_HEADER_RE.test(cells[i].textContent.trim())) return { row: r, index: i };
      }
    }
    return null;
  }

  function getRowComment(row, index) {
    const cell = row.children[index];
    if (!cell) return "";
    return cell.textContent.replace(/\s+/g, " ").trim();
  }

  // Раскладывает ячейки строки заголовка по индексам колонок (с учётом colspan)
  function mapHeaderRow(row, transform) {
    const map = [];
    let idx = 0;
    for (const cell of row.children) {
      const value = transform(cell.textContent.trim());
      const span = cell.colSpan || 1;
      for (let i = 0; i < span; i++) map[idx + i] = value;
      idx += span;
    }
    return map;
  }

  // Вторая строка шапки (названия стендов): в колонках прогонов стоит текст, а не номера тестов.
  function isSubHeaderRow(row, runKeys) {
    let hasText = false;
    for (const cell of row.children) {
      if (!runKeys[getCellColumnIndex(cell)]) continue;
      const text = cell.textContent.trim();
      if (!text) continue;
      if (extractTestCaseNumber(text)) return false;
      hasText = true;
    }
    return hasText;
  }

  // Проходит по всем таблицам документа и раскладывает ячейки прогонов
  // (числа в колонках вида C12345) на неразобранные / в разборе / разобранные.
  function collectPageStats(doc, stats) {
    for (const table of doc.querySelectorAll("table")) {
      const headerRow = table.rows[0];
      if (!headerRow) continue;

      // Индекс колонки → ключ прогона (с учётом colspan в заголовке)
      const runKeys = mapHeaderRow(headerRow, extractTestRunKey);
      if (!runKeys.some(Boolean)) continue;

      // Индекс колонки → название стенда из второй строки шапки («Смоленск», «Воронеж», …)
      const subHeader = table.rows[1] && isSubHeaderRow(table.rows[1], runKeys) ? table.rows[1] : null;
      const colLabels = subHeader ? mapHeaderRow(subHeader, (text) => text) : [];

      const commentCol = findCommentColumn(table);
      const firstDataRow = subHeader ? 2 : 1;

      for (let r = firstDataRow; r < table.rows.length; r++) {
        for (const cell of table.rows[r].children) {
          const colIdx = getCellColumnIndex(cell);
          const testRunKey = runKeys[colIdx];
          if (!testRunKey) continue;
          const num = extractTestCaseNumber(cell.textContent);
          if (!num) continue;

          stats.runKeys.add(testRunKey);
          stats.total++;

          const colour = (cell.getAttribute("data-highlight-colour") || "").toLowerCase();
          if (!colour) {
            stats.unpainted++;
          } else if (colour === IN_PROGRESS_COLOR) {
            stats.inProgress.push({
              cell,
              number: num,
              testRunKey,
              painter: getPainterName(cell),
              // время именно последней покраски в жёлтый — от него считается «сколько в разборе»
              ts: getLastPaintTs(cell, IN_PROGRESS_SLOT),
              columnLabel: colLabels[colIdx] || "",
              comment: commentCol ? getRowComment(table.rows[r], commentCol.index) : "",
            });
          } else {
            stats.done++;
          }
        }
      }
    }
    return stats;
  }

  function collectPageStatsAll() {
    const stats = { total: 0, unpainted: 0, done: 0, inProgress: [], runKeys: new Set() };
    collectPageStats(document, stats);
    forEachIframeDoc((doc) => collectPageStats(doc, stats));
    return stats;
  }

  // Единый порядок ячеек «в разборе» для статистики и панели: сначала те, что взяты
  // в разбор раньше. Время покраски неизвестно (красили не через R-Helper) — в конец,
  // при равном времени порядок задаёт номер, иначе он скакал бы между пересчётами.
  function compareByPaintTime(a, b) {
    return (a.ts || Infinity) - (b.ts || Infinity) || Number(a.number) - Number(b.number);
  }

  function scrollToCellElement(cell) {
    const ownerDoc = cell.ownerDocument;
    if (ownerDoc !== document) {
      const iframe = findIframeFor(ownerDoc);
      if (iframe) iframe.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    cell.scrollIntoView({ behavior: "smooth", block: "center" });
    cell.classList.add("rhelper-flash");
    setTimeout(() => cell.classList.remove("rhelper-flash"), FLASH_DURATION);
  }

  function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  // Сколько прошло времени: «3 дня 8 часов», «5 часов 12 минут», «7 минут»
  function formatElapsed(ms) {
    const totalMin = Math.max(0, Math.floor(ms / 60000));
    if (totalMin === 0) return "меньше минуты";

    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;

    const parts = [];
    if (days > 0) {
      parts.push(days + " " + pluralRu(days, "день", "дня", "дней"));
      if (hours > 0) parts.push(hours + " " + pluralRu(hours, "час", "часа", "часов"));
    } else if (hours > 0) {
      parts.push(hours + " " + pluralRu(hours, "час", "часа", "часов"));
      if (mins > 0) parts.push(mins + " " + pluralRu(mins, "минута", "минуты", "минут"));
    } else {
      parts.push(mins + " " + pluralRu(mins, "минута", "минуты", "минут"));
    }
    return parts.join(" ");
  }

  const COMMENT_HINT_LIMIT = 300;

  function truncate(text, limit) {
    return text.length > limit ? text.slice(0, limit).trimEnd() + "…" : text;
  }

  // Помечает строку, по которой кликнули. Снимаем метку по всему попапу, а не только
  // внутри своей группы художника — иначе в каждой группе останется по подсвеченной строке.
  function markActiveRow(row) {
    const scope = row.closest(".rhelper-popup-body") || row.parentElement;
    for (const el of scope.querySelectorAll(".rhelper-stats-row-active")) {
      el.classList.remove("rhelper-stats-row-active");
    }
    row.classList.add("rhelper-stats-row-active");
  }

  // На время вспышки делает попап полупрозрачным, чтобы под ним была видна ячейка
  let peekTimeout = null;
  function peekAtPage() {
    if (!currentPopup) return;
    currentPopup.classList.add("rhelper-overlay-peek");
    clearTimeout(peekTimeout);
    peekTimeout = setTimeout(() => {
      if (currentPopup) currentPopup.classList.remove("rhelper-overlay-peek");
      peekTimeout = null;
    }, FLASH_DURATION);
  }

  function buildStatTile(value, label, modifier, hint) {
    const tile = document.createElement("div");
    tile.className = "rhelper-stat-tile" + (modifier ? " " + modifier : "");
    if (hint) tile.title = hint;
    const valueEl = document.createElement("div");
    valueEl.className = "rhelper-stat-tile-value";
    valueEl.textContent = value;
    const labelEl = document.createElement("div");
    labelEl.className = "rhelper-stat-tile-label";
    labelEl.textContent = label;
    tile.appendChild(valueEl);
    tile.appendChild(labelEl);
    return tile;
  }

  function renderPageStats(body, stats) {
    body.textContent = "";

    if (stats.total === 0) {
      const empty = document.createElement("div");
      empty.className = "rhelper-popup-empty";
      empty.textContent = "На странице не найдено таблиц с колонками прогонов (C…).";
      body.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "rhelper-stats-grid";
    grid.appendChild(buildStatTile(stats.total, "Всего ячеек", "", "Все ячейки с номерами тест-кейсов в колонках прогонов"));
    grid.appendChild(buildStatTile(stats.unpainted, "Не разобрано", "rhelper-stat-tile-plain", "Ячейки без заливки"));
    grid.appendChild(buildStatTile(stats.inProgress.length, "В разборе", "rhelper-stat-tile-progress", "Ячейки, закрашенные жёлтым"));
    grid.appendChild(buildStatTile(stats.done, "Разобрано", "rhelper-stat-tile-done", "Ячейки, закрашенные любым цветом, кроме жёлтого"));
    body.appendChild(grid);

    const section = document.createElement("div");
    section.className = "rhelper-popup-section";
    const title = document.createElement("div");
    title.className = "rhelper-popup-section-title";
    title.textContent = "В разборе — " + stats.inProgress.length;
    section.appendChild(title);

    if (stats.inProgress.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rhelper-popup-empty";
      empty.textContent = "Нет ячеек в разборе.";
      section.appendChild(empty);
      body.appendChild(section);
      return;
    }

    // Группировка по художнику: сначала те, у кого ячеек больше
    const groups = new Map();
    for (const item of stats.inProgress) {
      const painter = item.painter || UNKNOWN_PAINTER;
      if (!groups.has(painter)) groups.set(painter, []);
      groups.get(painter).push(item);
    }
    const sortedGroups = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ru"));

    for (const [painter, items] of sortedGroups) {
      items.sort(compareByPaintTime);

      const group = document.createElement("div");
      group.className = "rhelper-stats-group";

      const head = document.createElement("div");
      head.className = "rhelper-stats-group-head";
      const nameEl = document.createElement("span");
      nameEl.className = "rhelper-stats-painter";
      nameEl.textContent = painter;
      if (painter === UNKNOWN_PAINTER) nameEl.title = "Ячейка закрашена не через R-Helper";
      const countEl = document.createElement("span");
      countEl.className = "rhelper-stats-painter-count";
      countEl.textContent = items.length;
      head.appendChild(nameEl);
      head.appendChild(countEl);
      group.appendChild(head);

      const list = document.createElement("div");
      list.className = "rhelper-stats-cells";
      const now = Date.now();
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "rhelper-stats-row";

        const chip = document.createElement("a");
        chip.className = "rhelper-stats-cell";
        chip.href = "#";
        chip.textContent = item.number;
        chip.title = (item.columnLabel ? item.columnLabel + " · " : "")
          + item.testRunKey + " — показать ячейку на странице";
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          markActiveRow(row);
          peekAtPage();
          scrollToCellElement(item.cell);
        });
        row.appendChild(chip);

        if (item.columnLabel) {
          const columnEl = document.createElement("span");
          columnEl.className = "rhelper-stats-row-column";
          columnEl.textContent = item.columnLabel.charAt(0).toUpperCase();
          columnEl.title = item.columnLabel;
          row.appendChild(columnEl);
        }

        const commentEl = document.createElement("span");
        commentEl.className = "rhelper-stats-row-comment";
        if (item.comment) {
          commentEl.textContent = item.comment;
          commentEl.title = truncate(item.comment, COMMENT_HINT_LIMIT);
        } else {
          commentEl.textContent = "без комментария";
          commentEl.classList.add("rhelper-stats-row-comment-empty");
        }
        row.appendChild(commentEl);

        if (item.ts) {
          const timeEl = document.createElement("span");
          timeEl.className = "rhelper-stats-row-time";
          timeEl.textContent = formatPaintTs(item.ts);
          row.appendChild(timeEl);

          const elapsedEl = document.createElement("span");
          elapsedEl.className = "rhelper-stats-row-elapsed";
          elapsedEl.textContent = formatElapsed(now - item.ts) + " в разборе";
          row.appendChild(elapsedEl);
        } else {
          const unknownEl = document.createElement("span");
          unknownEl.className = "rhelper-stats-row-time rhelper-stats-row-time-unknown";
          unknownEl.textContent = "время покраски неизвестно";
          unknownEl.title = "Ячейка покрашена не через R-Helper или до появления истории покраски";
          row.appendChild(unknownEl);
        }

        list.appendChild(row);
      }
      group.appendChild(list);
      section.appendChild(group);
    }

    body.appendChild(section);
  }

  function showPageStatsPopup() {
    removePopup();
    removeTooltip();
    removeColorPalette();
    clearCellHighlight();

    const stats = collectPageStatsAll();

    const titleBlock = document.createElement("div");
    titleBlock.className = "rhelper-popup-title-block";
    const titleSpan = document.createElement("span");
    titleSpan.className = "rhelper-popup-title";
    titleSpan.textContent = "Статистика страницы";
    titleBlock.appendChild(titleSpan);
    const subtitle = document.createElement("div");
    subtitle.className = "rhelper-popup-subtitle";
    if (stats.runKeys.size > 0) {
      subtitle.textContent = "Прогонов на странице: " + stats.runKeys.size;
    }
    titleBlock.appendChild(subtitle);

    const { overlay, body, setRemovePopup } = R.createPopupShell(titleBlock);
    document.body.appendChild(overlay);
    currentPopup = overlay;
    setRemovePopup(removePopup);

    renderPageStats(body, stats);
  }

  // ===== Плавающая панель «Мои в разборе» =====
  //
  // Живёт только в главном документе (content script зарегистрирован с allFrames: false),
  // поэтому position: fixed прибит к окну, а не к iframe редактора. Ячейки при этом
  // ищутся и в главном документе, и в iframe — через collectPageStatsAll().

  // Расширение перезагрузили, а страницу — нет: chrome.runtime.id пропадает,
  // а обращения к storage либо бросают TypeError, либо реджектят промис
  function isExtensionAlive() {
    return !!(chrome.runtime && chrome.runtime.id);
  }

  // Панель переживает потерю контекста молча: положение просто не сохранится
  function saveDockState() {
    if (!isExtensionAlive()) return;
    try {
      const saving = chrome.storage.local.set({ [DOCK_STATE_KEY]: dockState });
      // set() возвращает промис — без catch его отказ всплыл бы как unhandled rejection
      if (saving && typeof saving.catch === "function") saving.catch(() => {});
    } catch (e) {
      // Extension context invalidated
    }
  }

  // Мои жёлтые ячейки в том же порядке, что и в «Статистике страницы»:
  // взятые в разбор раньше — первыми
  function collectMyInProgress() {
    if (!currentUserName) return [];
    return collectPageStatsAll().inProgress
      .filter((item) => item.painter === currentUserName)
      .sort(compareByPaintTime);
  }

  function removeDock() {
    if (dockEl) {
      dockEl.remove();
      dockEl = null;
    }
  }

  // Страница открыта в режиме редактирования, если появился iframe с телом TinyMCE —
  // тот же признак, по которому isEditorContext() решает, писать ли историю покраски.
  function isEditorPage() {
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const body = iframe.contentDocument && iframe.contentDocument.body;
        if (body && body.classList.contains("mce-content-body")) return true;
      } catch (e) {
        // Cross-origin iframe, ignore
      }
    }
    return false;
  }

  function scheduleDockUpdate() {
    clearTimeout(dockUpdateTimeout);
    dockUpdateTimeout = setTimeout(updateDock, DOCK_UPDATE_DELAY);
  }

  function buildDockButton(className, text, title, onClick) {
    const btn = document.createElement("button");
    btn.className = "rhelper-dock-btn " + className;
    btn.type = "button";
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function buildDock() {
    const dock = document.createElement("div");
    dock.className = "rhelper-dock";
    R.applyThemeToElement(dock);

    const head = document.createElement("div");
    head.className = "rhelper-dock-head";
    head.title = "Перетащите, чтобы переставить панель";

    const dot = document.createElement("span");
    dot.className = "rhelper-dock-dot";
    head.appendChild(dot);

    const title = document.createElement("span");
    title.className = "rhelper-dock-title";
    title.textContent = "Мои в разборе";
    head.appendChild(title);

    const count = document.createElement("span");
    count.className = "rhelper-dock-count";
    head.appendChild(count);

    // Надпись и подсказка зависят от состояния — их проставит applyDockCollapsed()
    const collapseBtn = buildDockButton("rhelper-dock-collapse", "−", "Свернуть", () => {
      dockState.collapsed = !dockState.collapsed;
      saveDockState();
      applyDockCollapsed();
      positionDock(); // свёрнутая панель уже развёрнутой — правый предел сдвинулся
    });
    head.appendChild(collapseBtn);

    head.appendChild(buildDockButton("rhelper-dock-close", "×", "Скрыть панель (вернуть — в панели расширения)", () => {
      dockState.hidden = true;
      saveDockState();
      removeDock();
    }));

    dock.appendChild(head);

    const list = document.createElement("div");
    list.className = "rhelper-dock-list";
    dock.appendChild(list);

    dock._count = count;
    dock._list = list;
    dock._collapseBtn = collapseBtn;

    makeDockDraggable(dock, head);
    return dock;
  }

  function applyDockCollapsed() {
    if (!dockEl) return;
    dockEl.classList.toggle("rhelper-dock-is-collapsed", !!dockState.collapsed);
    dockEl._collapseBtn.textContent = dockState.collapsed ? "+" : "−";
    dockEl._collapseBtn.title = dockState.collapsed ? "Развернуть" : "Свернуть";
  }

  // Держит панель в пределах окна. Сверху предела нет (0), чтобы её можно было
  // поставить вплотную к штатным панелям Confluence; снизу оставляем видимой шапку.
  // Ширину можно передать: при перетаскивании она не меняется, и повторное чтение
  // offsetWidth после записи style заставляло бы браузер пересчитывать раскладку на каждый шаг.
  function clampDockPosition(left, top, width) {
    // Ширина плавающая (панель ужимается по номерам), поэтому меряем фактическую
    const dockWidth = width === undefined ? dockEl.offsetWidth : width;
    const maxLeft = Math.max(DOCK_MARGIN, window.innerWidth - dockWidth - DOCK_MARGIN);
    const maxTop = Math.max(0, window.innerHeight - DOCK_HEAD_KEEP);
    return {
      left: Math.min(Math.max(left, DOCK_MARGIN), maxLeft),
      top: Math.min(Math.max(top, 0), maxTop),
    };
  }

  // Ставит панель по сохранённой позиции, а если её нет — в правый верхний угол.
  // Сохранённая позиция могла остаться от другого размера окна, поэтому её тоже подрезаем.
  function positionDock() {
    if (!dockEl) return;
    // left === null означает «прижать к правому краю» — Infinity подрежется до максимума
    const { left, top } = clampDockPosition(
      dockState.left === null ? Infinity : dockState.left,
      dockState.top === null ? DOCK_DEFAULT_TOP : dockState.top
    );
    dockEl.style.left = left + "px";
    dockEl.style.top = top + "px";
  }

  // Перетаскивание на Pointer Events с захватом указателя: с mousemove на документе
  // панель отставала от курсора, стоило увести его на iframe редактора или за окно —
  // события доставались iframe, а mouseup там же терялся, и перетаскивание залипало.
  // setPointerCapture адресует все события ручке, пока кнопка не отпущена.
  function makeDockDraggable(dock, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".rhelper-dock-btn")) return;
      e.preventDefault();
      const rect = dock.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      dock.classList.add("rhelper-dock-dragging");
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        // Подрезаем здесь же, иначе в storage уедет позиция за краем экрана.
        // Ширину берём из замера на старте — она за время перетаскивания не меняется
        const pos = clampDockPosition(ev.clientX - offsetX, ev.clientY - offsetY, rect.width);
        dockState.left = pos.left;
        dockState.top = pos.top;
        // Пишем стиль напрямую, а не через positionDock(): тот снова замерил бы
        // offsetWidth, и чтение вперемешку с записью упёрлось бы в пересчёт раскладки
        dock.style.left = pos.left + "px";
        dock.style.top = pos.top + "px";
      };
      // Захват снимается браузером сам на pointerup/pointercancel — остаётся убрать слушатели
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        dock.classList.remove("rhelper-dock-dragging");
        saveDockState();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  // Панель минималистичная: только кликабельные номера, без подсказок при наведении.
  // Стенд, время в разборе и комментарий строки показывает «Статистика страницы».
  function renderDockList(items) {
    const list = dockEl._list;
    // Список пересобирается целиком на каждый пересчёт — место прокрутки возвращаем сами
    const scrollTop = list.scrollTop;
    list.textContent = "";
    dockEl._count.textContent = items.length;
    // Колонок не больше, чем самих номеров: пустые треки держали бы ширину панели
    const columns = Math.max(1, Math.min(items.length, DOCK_COLUMNS));
    list.style.gridTemplateColumns = `repeat(${columns}, minmax(50px, max-content))`;

    for (const item of items) {
      const num = document.createElement("a");
      num.className = "rhelper-dock-num";
      num.href = "#";
      num.textContent = item.number;
      num.addEventListener("click", (e) => {
        e.preventDefault();
        scrollToCellElement(item.cell);
      });
      list.appendChild(num);
    }

    list.scrollTop = scrollTop;
  }

  function updateDock() {
    clearTimeout(dockUpdateTimeout);
    dockUpdateTimeout = null;
    if (!dockStateLoaded) return;
    // Панель нужна только при разборе, то есть в режиме редактирования страницы
    if (dockState.hidden || !isEditorPage()) {
      removeDock();
      return;
    }

    const items = collectMyInProgress();
    if (items.length === 0) {
      removeDock();
      return;
    }

    if (!dockEl) dockEl = buildDock();
    // Confluence перерисовывает body — панель могло вынести вместе с ним
    if (!document.body.contains(dockEl)) document.body.appendChild(dockEl);

    applyDockCollapsed();
    renderDockList(items);
    // Позиционируем после отрисовки: от числа номеров зависит ширина, а от неё —
    // насколько панель можно сдвинуть вправо. Иначе прижатая к правому краю
    // панель вылезала бы за окно по мере добавления ячеек.
    positionDock();
  }

  async function initDock() {
    try {
      if (isExtensionAlive()) {
        const data = await chrome.storage.local.get(DOCK_STATE_KEY);
        if (data[DOCK_STATE_KEY]) Object.assign(dockState, data[DOCK_STATE_KEY]);
      }
    } catch (e) {
      // Extension context invalidated — работаем с состоянием по умолчанию
    }
    dockStateLoaded = true;
    await ensureCurrentUser();
    // Несколько попыток: пока таблицы не отрисованы, список пуст и панели нет,
    // а вручную её позвать нечем — остаётся ждать покраски ячейки.
    // Как только панель построилась, оставшиеся попытки становятся холостыми.
    for (const delay of DOCK_RETRY_DELAYS) {
      setTimeout(() => {
        if (!dockEl) updateDock();
      }, delay);
    }
  }

  initDock();
  window.addEventListener("resize", positionDock);

  // Панель расширения включает/выключает док через storage. Реагируем только на
  // смену видимости: позицию и свёрнутость пишем отсюда же, и перерисовывать
  // список на каждое перетаскивание не нужно.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[DOCK_STATE_KEY]) return;
    const next = changes[DOCK_STATE_KEY].newValue || {};

    // Сброс положения из дебаг-меню: свои записи при перетаскивании всегда числа,
    // поэтому null здесь означает именно сброс, а не эхо собственного сохранения
    if (next.top === null && next.left === null && (dockState.top !== null || dockState.left !== null)) {
      dockState.top = null;
      dockState.left = null;
      positionDock();
    }

    if (!!next.hidden === !!dockState.hidden) return;
    dockState.hidden = !!next.hidden;
    updateDock();
  });

  // ===== Message listener for popup =====

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getPageTestRunKeys") {
      const keys = collectTestRunKeys(document);
      forEachIframeDoc((doc) => collectTestRunKeys(doc, keys));
      sendResponse({ keys: Array.from(keys) });
    }

    if (message.action === "showPageStats") {
      showPageStatsPopup();
      // Заодно запасной способ поднять панель, если при загрузке таблиц ещё не было
      scheduleDockUpdate();
      sendResponse({ ok: true });
    }

    if (message.action === "scrollToCell") {
      const num = message.cellNumber;
      let target = null;

      function findCell(doc) {
        if (target) return;
        const cells = doc.querySelectorAll(IN_PROGRESS_SELECTOR);
        for (const cell of cells) {
          if (cell.textContent.trim() === num) { target = cell; return; }
        }
      }

      findCell(document);
      if (!target) forEachIframeDoc(findCell);

      if (target) scrollToCellElement(target);
      sendResponse({ found: !!target });
    }

    if (message.action === "getInProgressCells") {
      (async () => {
        const username = await ensureCurrentUser();
        if (!username) {
          sendResponse({ username: null, cells: [] });
          return;
        }
        // Тот же источник, что и у панели на странице, — иначе счётчики расходятся
        sendResponse({ username, cells: collectMyInProgress().map((item) => item.number) });
      })();
      return true;
    }
  });
})();
