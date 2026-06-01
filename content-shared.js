// content-shared.js — Shared library for R-Helper content scripts
// Exports window.RHelper used by content.js (Confluence) and content-jira.js (Jira)
"use strict";

(function () {
  const HOVER_DELAY = 300;
  const COMMENT_PREVIEW_LENGTH = 200;

  // ===== Theme =====

  let currentTheme = "auto";
  chrome.storage.local.get("theme", (data) => {
    currentTheme = data.theme || "auto";
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.theme) {
      currentTheme = changes.theme.newValue || "auto";
      document.querySelectorAll("[data-rhelper-themed]").forEach((el) => {
        if (currentTheme === "auto") el.removeAttribute("data-theme");
        else el.setAttribute("data-theme", currentTheme);
      });
    }
  });

  function applyThemeToElement(el) {
    el.setAttribute("data-rhelper-themed", "1");
    if (currentTheme !== "auto") el.setAttribute("data-theme", currentTheme);
  }

  // ===== Utilities =====

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

  // ===== Communication =====

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
    overlay.setAttribute("data-mce-bogus", "all");
    applyThemeToElement(overlay);
    overlay.addEventListener("click", removeLightbox);

    const img = document.createElement("img");
    img.src = imgUrl;
    img.alt = alt || "";
    img.addEventListener("click", (e) => e.stopPropagation());

    overlay.appendChild(img);
    document.body.appendChild(overlay);
    currentLightbox = overlay;
  }

  function hasLightbox() {
    return !!currentLightbox;
  }

  // ===== Tooltip building =====

  function linkifyBugsInDom(root, jiraBase) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const re = /\bbug\s+([A-Z]+-\d+)/gi;
    for (const node of nodes) {
      re.lastIndex = 0;
      if (!re.test(node.textContent)) continue;
      const frag = linkifyBugs(node.textContent, jiraBase);
      node.parentNode.replaceChild(frag, node);
    }
  }

  function linkifyBugs(text, jiraBase) {
    const frag = document.createDocumentFragment();
    const re = /\bbug\s+([A-Z]+-\d+)/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.substring(last, m.index)));
      }
      const a = document.createElement("a");
      a.className = "rhelper-tooltip-bug-link";
      a.href = (jiraBase || "") + "/browse/" + m[1];
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = m[0];
      frag.appendChild(a);
      last = re.lastIndex;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.substring(last)));
    }
    return frag;
  }

  function buildTooltipContent(resp, opts) {
    const onMore = opts && opts.onMore;
    const painterName = opts && opts.painterName;
    const projectKey = (opts && opts.projectKey) || "BT";
    const testCaseKey = opts && opts.testCaseKey;
    const escapedKey = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const tooltip = document.createElement("div");
    tooltip.className = "rhelper-tooltip";
    tooltip.setAttribute("data-mce-bogus", "all");

    function appendMoreButton() {
      if (onMore) {
        const btn = document.createElement("button");
        btn.className = "rhelper-tooltip-more";
        btn.textContent = "Ещё";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onMore();
        });
        tooltip.appendChild(btn);
      }
    }

    if (!resp || resp.error) {
      const errSpan = document.createElement("span");
      errSpan.style.color = "#ff8a80";
      errSpan.textContent = resp?.error || "Error loading data";
      tooltip.appendChild(errSpan);
      appendMoreButton();
      return tooltip;
    }

    if (!resp.found) {
      const nfSpan = document.createElement("span");
      nfSpan.style.color = "#999";
      nfSpan.textContent = "Test result not found";
      tooltip.appendChild(nfSpan);
      appendMoreButton();
      return tooltip;
    }

    // Build comment preview
    let commentFragment = null;
    if (resp.comment) {
      const withNewlines = resp.comment
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|li|tr)>/gi, "\n");
      const plain = stripHtml(withNewlines);

      const testoRe = new RegExp(escapedKey + "[-_]T\\d+\\.testo", "gi");
      let lastTestoIdx = -1;
      let m;
      while ((m = testoRe.exec(plain)) !== null) {
        lastTestoIdx = m.index;
      }

      let excerpt;
      if (lastTestoIdx !== -1) {
        excerpt = plain.substring(lastTestoIdx);
      } else {
        const markers = ["Error while", "PASSED in"];
        let bestIdx = -1;
        for (const mk of markers) {
          const idx = plain.indexOf(mk);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
        }
        excerpt = bestIdx !== -1 ? plain.substring(bestIdx) : plain;
      }

      commentFragment = document.createDocumentFragment();

      if (lastTestoIdx !== -1) {
        const linkMatch = excerpt.match(new RegExp("^(" + escapedKey + "[-_]T\\d+\\.testo:\\d+:\\d+)"));
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

      if (commentFragment.childNodes.length === 0) {
        if (testCaseKey) {
          const keySpan = document.createElement("span");
          keySpan.className = "rhelper-tooltip-testo-link";
          keySpan.dataset.copy = testCaseKey;
          keySpan.textContent = testCaseKey;
          commentFragment.appendChild(keySpan);
          commentFragment.appendChild(document.createTextNode(" "));
        }
        const text = excerpt.length > COMMENT_PREVIEW_LENGTH
          ? excerpt.substring(0, COMMENT_PREVIEW_LENGTH) + "..."
          : excerpt;
        commentFragment.appendChild(document.createTextNode(text));
      }
    }
    if (!commentFragment && testCaseKey) {
      commentFragment = document.createDocumentFragment();
      const keySpan = document.createElement("span");
      keySpan.className = "rhelper-tooltip-testo-link";
      keySpan.dataset.copy = testCaseKey;
      keySpan.textContent = testCaseKey;
      commentFragment.appendChild(keySpan);
      const noComment = document.createElement("span");
      noComment.style.color = "#999";
      noComment.textContent = " Нет комментария";
      commentFragment.appendChild(noComment);
    }

    // Painter name (Confluence-specific, optional)
    if (painterName) {
      const painterSpan = document.createElement("span");
      painterSpan.className = "rhelper-tooltip-painter";
      painterSpan.textContent = painterName;
      tooltip.appendChild(painterSpan);
    }

    // Header badges (run name + VM pills) wrapped in a flex row so they wrap
    // cleanly onto multiple lines without overlapping.
    const vmNames = resp.comment ? extractVmNames(resp.comment) : [];
    if (resp.testRunName || vmNames.length > 0) {
      const badgesRow = document.createElement("div");
      badgesRow.className = "rhelper-tooltip-badges";

      // Test run name (placed before VM pills)
      if (resp.testRunName) {
        const parenMatch = resp.testRunName.match(/\(([^)]+)\)/);
        const runSpan = document.createElement("span");
        runSpan.className = "rhelper-tooltip-run-name";
        runSpan.textContent = parenMatch ? parenMatch[1].trim() : resp.testRunName;
        badgesRow.appendChild(runSpan);
      }

      // VM names
      for (const n of vmNames) {
        const vmSpan = document.createElement("span");
        vmSpan.className = "rhelper-tooltip-vm";
        vmSpan.textContent = n;
        badgesRow.appendChild(vmSpan);
      }

      tooltip.appendChild(badgesRow);
    }

    // Comment
    if (commentFragment) {
      const commentDiv = document.createElement("div");
      commentDiv.className = "rhelper-tooltip-comment";
      commentDiv.appendChild(commentFragment);
      tooltip.appendChild(commentDiv);
    }

    // Linked bugs
    const jiraBase = opts && opts.jiraBase;
    if (resp.issueLinks && resp.issueLinks.length > 0 && jiraBase) {
      const bugsDiv = document.createElement("div");
      bugsDiv.className = "rhelper-tooltip-bugs";
      const bugsTitle = document.createElement("div");
      bugsTitle.className = "rhelper-tooltip-bugs-title";
      bugsTitle.textContent = "Прикрепленные задачи:";
      bugsDiv.appendChild(bugsTitle);
      const ul = document.createElement("ul");
      ul.className = "rhelper-tooltip-bugs-list";
      for (const issue of resp.issueLinks) {
        const li = document.createElement("li");
        const bugLink = document.createElement("a");
        const isProjectBug = issue.key.startsWith(projectKey + "-");
        bugLink.className = isProjectBug ? "rhelper-tooltip-bug-link" : "rhelper-tooltip-ext-link";
        bugLink.href = jiraBase + "/browse/" + issue.key;
        bugLink.target = "_blank";
        bugLink.rel = "noopener";
        bugLink.textContent = issue.key + " " + issue.summary;
        li.appendChild(bugLink);
        ul.appendChild(li);
      }
      bugsDiv.appendChild(ul);
      tooltip.appendChild(bugsDiv);
    }

    appendMoreButton();

    // Set up .testo link copy handler
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

    return tooltip;
  }

  // ===== Popup shell =====

  function createPopupShell(headerNode) {
    const overlay = document.createElement("div");
    overlay.className = "rhelper-overlay";
    overlay.setAttribute("data-mce-bogus", "all");
    applyThemeToElement(overlay);

    const popup = document.createElement("div");
    popup.className = "rhelper-popup";

    // Header
    const header = document.createElement("div");
    header.className = "rhelper-popup-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "rhelper-popup-header-left";
    headerLeft.appendChild(headerNode);
    header.appendChild(headerLeft);

    const closeBtn = document.createElement("button");
    closeBtn.className = "rhelper-popup-close";
    closeBtn.title = "Close";
    closeBtn.textContent = "\u00d7";
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Body with loading state
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

    let _removePopup = null;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && _removePopup) _removePopup();
    });
    closeBtn.addEventListener("click", () => {
      if (_removePopup) _removePopup();
    });

    return {
      overlay,
      body,
      setRemovePopup(fn) { _removePopup = fn; },
    };
  }

  // ===== Popup content rendering =====

  function renderPopupContent(body, data, jiraBase, projectKey) {
    projectKey = projectKey || "BT";
    const escapedKey = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      linkifyBugsInDom(commentDiv, jiraBase);
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
          const imgUrl = `${jiraBase}/rest/tests/1.0/attachment/${att.id}`;
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

        // 1. Find last .testo:line:col in text nodes and make it clickable
        const testoRe = new RegExp(escapedKey + "[-_]T\\d+\\.testo:\\d+:\\d+", "g");
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

  // ===== Export =====

  window.RHelper = {
    HOVER_DELAY,
    COMMENT_PREVIEW_LENGTH,
    stripHtml,
    extractVmNames,
    formatFileSize,
    getStatusClass,
    getStatusLabel,
    sendMessage,
    showLightbox,
    removeLightbox,
    hasLightbox,
    buildTooltipContent,
    createPopupShell,
    renderPopupContent,
    applyThemeToElement,
  };
})();
