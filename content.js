(async () => {
  "use strict";

  const settingsData = await chrome.storage.local.get("settings");
  if (!settingsData.settings || !settingsData.settings.jiraUrl || !settingsData.settings.confluenceUrl) return;

  const JIRA_BASE = settingsData.settings.jiraUrl;
  const TEST_CASE_PREFIX = settingsData.settings.testCasePrefix;
  const TEST_RUN_PREFIX = settingsData.settings.testRunPrefix;
  const HOVER_DELAY = 300;
  const COMMENT_PREVIEW_LENGTH = 200;

  let currentTooltip = null;
  let hoverTimeout = null;
  let tooltipRequestId = 0;
  let currentPopup = null;
  let currentColorPalette = null;
  let currentPaletteCell = null;
  let currentHighlightedCell = null;
  let highlightOverlay = null;
  let currentUserName = null;

  // ===== Utility =====

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent || "";
  }

  function extractVmNames(htmlComment) {
    const withNewlines = htmlComment
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr)>/gi, "\n");
    const text = stripHtml(withNewlines);
    const names = new Set();
    const patterns = [
      /Restoring snapshot .+? for virtual machine (\S+)/gi,
      /the virtual machine (\S+) was declared here/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        names.add(m[1]);
      }
    }
    return Array.from(names);
  }

  function formatFileSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function getStatusClass(status) {
    if (!status) return "rhelper-status-not-executed";
    const s = status.toLowerCase();
    if (s === "pass") return "rhelper-status-pass";
    if (s === "fail") return "rhelper-status-fail";
    if (s === "in progress") return "rhelper-status-in-progress";
    if (s === "blocked") return "rhelper-status-blocked";
    return "rhelper-status-not-executed";
  }

  function getStatusLabel(status) {
    if (!status) return "Not Executed";
    return status;
  }

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

  // ===== Communication with background =====

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ error: "Extension was reloaded. Please refresh the page." });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve({ error: "Extension was reloaded. Please refresh the page." });
      }
    });
  }

  async function ensureCurrentUser() {
    if (currentUserName) return currentUserName;
    const resp = await sendMessage({ action: "getCurrentUser" });
    if (resp && !resp.error && resp.name) {
      currentUserName = resp.name;
    }
    return currentUserName;
  }

  function ensureHighlightOverlay() {
    if (highlightOverlay) return highlightOverlay;
    const el = document.createElement("div");
    el.className = "rhelper-highlight-overlay";
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

    sendMessage({
      action: "getTestResult",
      testRunKey: keys.testRunKey,
      testCaseKey: keys.testCaseKey,
      includeAttachments: false,
    }).then((resp) => {
      if (requestId !== tooltipRequestId) return;

      const tooltip = document.createElement("div");
      tooltip.className = "rhelper-tooltip";

      if (!resp || resp.error) {
        const errSpan = document.createElement("span");
        errSpan.style.color = "#ff8a80";
        errSpan.textContent = resp?.error || "Error loading data";
        tooltip.appendChild(errSpan);
        mountTooltip(tooltip, cell);
        return;
      }

      if (!resp.found) {
        const nfSpan = document.createElement("span");
        nfSpan.style.color = "#999";
        nfSpan.textContent = "Test result not found";
        tooltip.appendChild(nfSpan);
        mountTooltip(tooltip, cell);
        return;
      }

      // Build comment preview as a DocumentFragment (no innerHTML)
      let commentFragment = null;
      if (resp.comment) {
        const withNewlines = resp.comment
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(?:p|div|li|tr)>/gi, "\n");
        const plain = stripHtml(withNewlines);

        // Find the last .testo filename reference
        const testoRe = /BT[-_]T\d+\.testo/gi;
        let lastTestoIdx = -1;
        let m;
        while ((m = testoRe.exec(plain)) !== null) {
          lastTestoIdx = m.index;
        }

        let excerpt;
        if (lastTestoIdx !== -1) {
          excerpt = plain.substring(lastTestoIdx);
        } else {
          const marker = "Error while";
          const markerIdx = plain.indexOf(marker);
          excerpt = markerIdx !== -1 ? plain.substring(markerIdx) : plain;
        }

        commentFragment = document.createDocumentFragment();

        // If .testo reference found, make it clickable for copying to clipboard
        if (lastTestoIdx !== -1) {
          const linkMatch = excerpt.match(/^(BT[-_]T\d+\.testo:\d+:\d+)/);
          if (linkMatch) {
            const copyText = linkMatch[1];
            const rest = excerpt.substring(copyText.length);
            const restTruncated = rest.length > COMMENT_PREVIEW_LENGTH
              ? rest.substring(0, COMMENT_PREVIEW_LENGTH) + "..."
              : rest;

            const testoSpan = document.createElement("span");
            testoSpan.className = "rhelper-tooltip-testo-link";
            testoSpan.dataset.copy = copyText;
            testoSpan.textContent = copyText;
            commentFragment.appendChild(testoSpan);
            commentFragment.appendChild(document.createTextNode(restTruncated));
          }
        }

        // Fallback: plain text preview
        if (commentFragment.childNodes.length === 0) {
          const text = excerpt.length > COMMENT_PREVIEW_LENGTH
            ? excerpt.substring(0, COMMENT_PREVIEW_LENGTH) + "..."
            : excerpt;
          commentFragment.appendChild(document.createTextNode(text));
        }
      }

      const painterClass = [...cell.classList].find(c => c.startsWith("rhelper-painter-"));
      const painter = painterClass ? painterClass.substring("rhelper-painter-".length) : "";

      if (painter && !cell.hasAttribute("title") && cell.hasAttribute("data-highlight-colour")) {
        const painterSpan = document.createElement("span");
        painterSpan.className = "rhelper-tooltip-painter";
        painterSpan.textContent = painter;
        tooltip.appendChild(painterSpan);
      }

      const vmNames = resp.comment ? extractVmNames(resp.comment) : [];
      for (const n of vmNames) {
        const vmSpan = document.createElement("span");
        vmSpan.className = "rhelper-tooltip-vm";
        vmSpan.textContent = n;
        tooltip.appendChild(vmSpan);
      }

      if (commentFragment) {
        const commentDiv = document.createElement("div");
        commentDiv.className = "rhelper-tooltip-comment";
        commentDiv.appendChild(commentFragment);
        tooltip.appendChild(commentDiv);
      }

      mountTooltip(tooltip, cell);

      const copyEl = tooltip.querySelector(".rhelper-tooltip-testo-link");
      if (copyEl) {
        copyEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          navigator.clipboard.writeText(copyEl.dataset.copy).then(() => {
            const original = copyEl.textContent;
            copyEl.textContent = "\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u043e!";
            setTimeout(() => { copyEl.textContent = original; }, 1000);
          });
        });
      }
    });
  }

  // ===== Lightbox =====

  let currentLightbox = null;

  function removeLightbox() {
    if (currentLightbox) {
      currentLightbox.remove();
      currentLightbox = null;
    }
  }

  function showLightbox(imgUrl, alt) {
    removeLightbox();

    const overlay = document.createElement("div");
    overlay.className = "rhelper-lightbox";
    overlay.addEventListener("click", removeLightbox);

    const img = document.createElement("img");
    img.src = imgUrl;
    img.alt = alt || "";
    img.addEventListener("click", (e) => e.stopPropagation());

    overlay.appendChild(img);
    document.body.appendChild(overlay);
    currentLightbox = overlay;
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

    const overlay = document.createElement("div");
    overlay.className = "rhelper-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) removePopup();
    });

    const popup = document.createElement("div");
    popup.className = "rhelper-popup";

    // Header
    const header = document.createElement("div");
    header.className = "rhelper-popup-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "rhelper-popup-header-left";
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
    headerLeft.appendChild(titleSpan);
    header.appendChild(headerLeft);

    const closeBtn = document.createElement("button");
    closeBtn.className = "rhelper-popup-close";
    closeBtn.title = "Close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", removePopup);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Body — loading state
    const body = document.createElement("div");
    body.className = "rhelper-popup-body";
    const loadingDiv = document.createElement("div");
    loadingDiv.className = "rhelper-loading";
    const spinnerDiv = document.createElement("div");
    spinnerDiv.className = "rhelper-spinner";
    loadingDiv.appendChild(spinnerDiv);
    loadingDiv.appendChild(document.createTextNode(" Loading test result..."));
    body.appendChild(loadingDiv);
    popup.appendChild(body);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    currentPopup = overlay;

    sendMessage({
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

      renderPopupContent(body, resp, keys);
    });
  }

  function renderPopupContent(body, data, keys) {
    body.textContent = "";

    // Comment section
    const commentSection = document.createElement("div");
    commentSection.className = "rhelper-popup-section";
    const commentTitle = document.createElement("div");
    commentTitle.className = "rhelper-popup-section-title";
    commentTitle.textContent = "Comment";
    commentSection.appendChild(commentTitle);
    let commentDiv = null;
    if (data.comment) {
      commentDiv = document.createElement("div");
      commentDiv.className = "rhelper-popup-comment";
      const commentDoc = new DOMParser().parseFromString(data.comment, "text/html");
      while (commentDoc.body.firstChild) {
        commentDiv.appendChild(document.adoptNode(commentDoc.body.firstChild));
      }
      commentSection.appendChild(commentDiv);
    } else {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "rhelper-popup-empty";
      emptyDiv.textContent = "No comment";
      commentSection.appendChild(emptyDiv);
    }
    body.appendChild(commentSection);

    // Attachments section
    const attachSection = document.createElement("div");
    attachSection.className = "rhelper-popup-section";
    const attachTitle = document.createElement("div");
    attachTitle.className = "rhelper-popup-section-title";
    attachTitle.textContent = "Attachments";
    attachSection.appendChild(attachTitle);

    if (data.attachments && data.attachments.length > 0) {
      const list = document.createElement("ul");
      list.className = "rhelper-attachments-list";

      data.attachments.forEach((att) => {
        const attName = att.fileName || att.filename || att.name || "unnamed";
        const attSize = att.fileSize || att.size;

        const li = document.createElement("li");
        li.className = "rhelper-attachment-item";

        const info = document.createElement("div");
        info.className = "rhelper-attachment-info";
        const nameSpan = document.createElement("span");
        nameSpan.className = "rhelper-attachment-name";
        nameSpan.title = attName;
        nameSpan.textContent = attName;
        const sizeSpan = document.createElement("span");
        sizeSpan.className = "rhelper-attachment-size";
        sizeSpan.textContent = formatFileSize(attSize);
        info.appendChild(nameSpan);
        info.appendChild(sizeSpan);

        const btn = document.createElement("button");
        btn.className = "rhelper-attachment-download";
        btn.textContent = "Download";
        btn.addEventListener("click", () => {
          sendMessage({
            action: "downloadAttachment",
            attachmentId: att.id,
            fileName: attName,
          });
        });

        li.appendChild(info);
        li.appendChild(btn);
        list.appendChild(li);

        // Inline preview for PNG/JPG images
        if (attName.toLowerCase().match(/\.(png|jpe?g)$/)) {
          const preview = document.createElement("div");
          preview.className = "rhelper-attachment-preview";
          const imgUrl = `${JIRA_BASE}/rest/tests/1.0/attachment/${att.id}`;
          const img = document.createElement("img");
          img.src = imgUrl;
          img.alt = attName;
          img.loading = "lazy";
          img.className = "rhelper-attachment-preview-link";
          img.addEventListener("click", (e) => {
            e.stopPropagation();
            showLightbox(imgUrl, attName);
          });
          preview.appendChild(img);
          list.appendChild(preview);
        }
      });

      attachSection.appendChild(list);
    } else {
      const emptyAttDiv = document.createElement("div");
      emptyAttDiv.className = "rhelper-popup-empty";
      emptyAttDiv.textContent = "No attachments";
      attachSection.appendChild(emptyAttDiv);
    }
    body.appendChild(attachSection);

    if (commentDiv) {
      requestAnimationFrame(() => {
        let scrollTarget = null;
        let node;

        // 1. Find last .testo:line:col in text nodes and make it clickable (before DOM modifications)
        const testoRe = /BT[-_]T\d+\.testo:\d+:\d+/g;
        const walker1 = document.createTreeWalker(commentDiv, NodeFilter.SHOW_TEXT);
        let lastNode = null;
        let lastIdx = -1;
        let lastStr = null;
        while ((node = walker1.nextNode())) {
          let m;
          testoRe.lastIndex = 0;
          while ((m = testoRe.exec(node.textContent)) !== null) {
            lastNode = node;
            lastIdx = m.index;
            lastStr = m[0];
          }
        }
        if (lastNode && lastStr) {
          const after = lastNode.splitText(lastIdx);
          after.splitText(lastStr.length);
          const link = document.createElement("span");
          link.className = "rhelper-testo-link";
          link.textContent = lastStr;
          link.title = "Копировать в буфер";
          after.parentNode.replaceChild(link, after);
          link.addEventListener("click", (ev) => {
            ev.stopPropagation();
            navigator.clipboard.writeText(lastStr).then(() => {
              const original = link.textContent;
              link.textContent = "Скопировано!";
              setTimeout(() => { link.textContent = original; }, 1000);
            });
          });
          scrollTarget = link;
        }

        // 2. Highlight "Error while performing action"
        const phrase = "Error while performing action";
        const walker2 = document.createTreeWalker(commentDiv, NodeFilter.SHOW_TEXT);
        while ((node = walker2.nextNode())) {
          const idx = node.textContent.indexOf(phrase);
          if (idx !== -1) {
            const after = node.splitText(idx);
            const rest = after.splitText(phrase.length);
            const highlight = document.createElement("span");
            highlight.className = "rhelper-error-highlight";
            after.parentNode.replaceChild(highlight, after);
            highlight.appendChild(after);
            if (!scrollTarget) scrollTarget = highlight;
            walker2.currentNode = rest;
          }
        }

        if (scrollTarget) {
          const lineHeight = 14 * 1.6;
          const offset = scrollTarget.offsetTop - body.offsetTop - 5 * lineHeight;
          body.scrollTop = Math.max(0, offset);
        }
      });
    }
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

    PALETTE_COLORS.forEach(({ color, title }) => {
      const swatch = document.createElement("div");
      swatch.className = "rhelper-color-swatch";
      swatch.style.backgroundColor = color;
      swatch.dataset.color = color;
      swatch.addEventListener("click", (ev) => {
        ev.stopPropagation();
        applyHighlight(cell, color, title);
        removeColorPalette();
      });
      palette.appendChild(swatch);
    });

    const removeSwatch = document.createElement("div");
    removeSwatch.className = "rhelper-color-swatch rhelper-color-remove";
    removeSwatch.title = "Убрать заливку";
    removeSwatch.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeHighlight(cell);
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
    if (!cell || !isTestCaseCell(cell)) return;

    currentHighlightedCell = cell;
    positionHighlightOverlay(cell);

    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    hoverTimeout = setTimeout(() => {
      showTooltip(cell, e);
    }, HOVER_DELAY);
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
    if (!cell || !isTestCaseCell(cell)) return;
    if (isEditorContext(cell)) {
      e.preventDefault();
    }
  }

  function handleClick(e) {
    const cell = e.target.closest("td, th");
    if (!cell || !isTestCaseCell(cell)) {
      clearCellHighlight();
      removeColorPalette();
      return;
    }

    if (isEditorContext(cell)) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        showPopup(cell);
      } else if (currentColorPalette && currentPaletteCell === cell) {
        removeColorPalette();
        showTooltip(cell, e);
      } else {
        showColorPalette(cell, e);
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    showPopup(cell);
  }

  function handleKeyDown(e) {
    if (e.key === "Escape") {
      if (currentColorPalette) {
        removeColorPalette();
      } else if (currentLightbox) {
        removeLightbox();
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
  });
})();
