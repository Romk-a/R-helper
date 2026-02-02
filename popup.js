(function () {
  "use strict";

  async function sendMessage(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { error: "Не удалось связаться с фоновым процессом расширения." };
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
    return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
  }

  async function loadStatus() {
    const resp = await sendMessage({ action: "getCacheStatus" });

    if (resp.error) {
      document.getElementById("emptyMessage").textContent = resp.error;
      document.getElementById("emptyMessage").hidden = false;
      return;
    }

    document.getElementById("extName").textContent = resp.name;
    document.getElementById("extVersion").textContent = "v" + resp.version;
    document.getElementById("testRunCount").textContent = resp.testRunCacheSize;
    document.getElementById("attachmentsCount").textContent = resp.attachmentsCacheSize;
    document.getElementById("inFlightCount").textContent = resp.inFlightCount;
    document.getElementById("storageSize").textContent = formatBytes(resp.storageBytesUsed || 0);

    const listEl = document.getElementById("testRunList");
    const itemsEl = document.getElementById("testRunItems");
    const emptyEl = document.getElementById("emptyMessage");

    itemsEl.textContent = "";

    if (resp.testRuns.length === 0) {
      listEl.hidden = true;
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      listEl.hidden = false;
      for (const run of resp.testRuns) {
        const li = document.createElement("li");
        const keySpan = document.createElement("span");
        keySpan.className = "rhelper-popup-run-key";
        keySpan.textContent = run.key;
        const right = document.createElement("span");
        right.className = "rhelper-popup-run-right";
        const countSpan = document.createElement("span");
        countSpan.className = "rhelper-popup-run-count";
        countSpan.textContent = run.resultsCount + " рез.";
        const delBtn = document.createElement("button");
        delBtn.className = "rhelper-popup-run-delete";
        delBtn.title = "Удалить из кэша";
        delBtn.textContent = "\u00d7";
        delBtn.addEventListener("click", async () => {
          delBtn.disabled = true;
          await sendMessage({ action: "deleteCacheEntry", testRunKey: run.key });
          await loadStatus();
        });
        right.appendChild(countSpan);
        right.appendChild(delBtn);
        li.appendChild(keySpan);
        li.appendChild(right);
        itemsEl.appendChild(li);
      }
    }
  }

  // ===== Prefetch button =====

  async function sendToTab(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      return { error: "Контент-скрипт недоступен. Откройте страницу Confluence." };
    }
  }

  const prefetchBtn = document.getElementById("prefetchBtn");
  const prefetchDefaultText = prefetchBtn.textContent;

  prefetchBtn.addEventListener("click", async () => {
    prefetchBtn.disabled = true;
    prefetchBtn.textContent = "Поиск прогонов...";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      prefetchBtn.textContent = "Нет активной вкладки";
      setTimeout(() => { prefetchBtn.textContent = prefetchDefaultText; prefetchBtn.disabled = false; }, 2000);
      return;
    }

    const resp = await sendToTab(tab.id, { action: "getPageTestRunKeys" });

    if (!resp || resp.error) {
      prefetchBtn.textContent = resp?.error || "Откройте страницу Confluence";
      setTimeout(() => { prefetchBtn.textContent = prefetchDefaultText; prefetchBtn.disabled = false; }, 2000);
      return;
    }

    const keys = resp.keys;
    if (!keys || keys.length === 0) {
      prefetchBtn.textContent = "Прогоны не найдены";
      setTimeout(() => { prefetchBtn.textContent = prefetchDefaultText; prefetchBtn.disabled = false; }, 2000);
      return;
    }

    let done = 0;
    for (const key of keys) {
      done++;
      prefetchBtn.textContent = `Кэширование... (${done}/${keys.length})`;
      await sendMessage({ action: "prefetchTestRun", testRunKey: key });
    }

    prefetchBtn.textContent = `Закэшировано! ${keys.length} прогонов`;
    await loadStatus();

    setTimeout(() => {
      prefetchBtn.textContent = prefetchDefaultText;
      prefetchBtn.disabled = false;
    }, 2000);
  });

  // ===== Clear cache button =====

  const clearBtn = document.getElementById("clearBtn");
  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    clearBtn.textContent = "Очистка...";

    await sendMessage({ action: "clearCache" });

    clearBtn.textContent = "Очищено!";
    await loadStatus();

    setTimeout(() => {
      clearBtn.textContent = "Очистить кэш";
      clearBtn.disabled = false;
    }, 1000);
  });

  const logBtn = document.getElementById("logBtn");
  const logSection = document.getElementById("logSection");
  const logContent = document.getElementById("logContent");

  logBtn.addEventListener("click", async () => {
    if (!logSection.hidden) {
      logSection.hidden = true;
      return;
    }
    logContent.textContent = "Загрузка...";
    logSection.hidden = false;
    const resp = await sendMessage({ action: "getCacheLog" });
    if (resp.error) {
      logContent.textContent = resp.error;
      return;
    }
    if (!resp.log || resp.log.length === 0) {
      logContent.textContent = "Лог пуст";
      return;
    }
    logContent.textContent = "";
    const entries = resp.log.slice().reverse();
    for (const e of entries) {
      const t = new Date(e.ts).toLocaleTimeString("ru-RU", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const entry = document.createElement("div");
      entry.className = "rhelper-popup-log-entry";
      const timeSpan = document.createElement("span");
      timeSpan.className = "rhelper-popup-log-time";
      timeSpan.textContent = t;
      const actionSpan = document.createElement("span");
      actionSpan.className = "rhelper-popup-log-action";
      actionSpan.textContent = e.action;
      entry.appendChild(timeSpan);
      entry.appendChild(document.createTextNode(" "));
      entry.appendChild(actionSpan);
      entry.appendChild(document.createTextNode(" " + e.details));
      logContent.appendChild(entry);
    }
  });

  loadStatus();
})();
