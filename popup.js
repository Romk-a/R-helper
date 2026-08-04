(function () {
  "use strict";

  // Тот же ключ, что DOCK_STATE_KEY в content.js: попап пишет в него видимость
  // плавающей панели и сброс её положения, контент-скрипт слушает изменения
  const DOCK_STATE_KEY = "dockState";

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

  let toastTimeout = null;
  function showToast(message, duration = 3000) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.hidden = true; }, duration);
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      const modal = document.getElementById("confirmModal");
      document.getElementById("confirmModalText").textContent = message;
      modal.hidden = false;

      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const cleanup = () => {
        modal.hidden = true;
        document.getElementById("confirmModalOk").removeEventListener("click", onOk);
        document.getElementById("confirmModalCancel").removeEventListener("click", onCancel);
      };

      document.getElementById("confirmModalOk").addEventListener("click", onOk);
      document.getElementById("confirmModalCancel").addEventListener("click", onCancel);
    });
  }

  // Сравнение версий вида "x.y.z": >0 если a новее b, <0 если старше, 0 если равны
  function compareVersions(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  // Баннер «Что нового»: показывает заметки по версиям новее последней просмотренной
  async function showWhatsNew() {
    const banner = document.getElementById("whatsNewBanner");
    if (!banner || !window.RHELPER_CHANGELOG) return;

    const currentVersion = chrome.runtime.getManifest().version;
    const data = await chrome.storage.local.get("lastSeenVersion");
    const lastSeen = data.lastSeenVersion;

    let versions = Object.keys(window.RHELPER_CHANGELOG)
      .filter((v) => compareVersions(v, currentVersion) <= 0);

    if (lastSeen) {
      // Показываем всё, что появилось после прошлого просмотра
      versions = versions.filter((v) => compareVersions(v, lastSeen) > 0);
    } else {
      // Первый запуск с этой фичей — показываем заметки текущей версии (если есть)
      versions = versions.filter((v) => v === currentVersion);
    }

    if (versions.length === 0) {
      // Нечего показывать — молча отмечаем версию как просмотренную
      await chrome.storage.local.set({ lastSeenVersion: currentVersion });
      await sendMessage({ action: "refreshBadge" });
      return;
    }

    versions.sort((a, b) => compareVersions(b, a)); // по убыванию

    const listEl = document.getElementById("whatsNewList");
    listEl.textContent = "";
    for (const v of versions) {
      const verEl = document.createElement("div");
      verEl.className = "rhelper-popup-whatsnew-version";
      verEl.textContent = "v" + v;
      listEl.appendChild(verEl);

      const ul = document.createElement("ul");
      ul.className = "rhelper-popup-whatsnew-items";
      for (const item of window.RHELPER_CHANGELOG[v]) {
        const li = document.createElement("li");
        if (typeof item === "string") {
          li.textContent = item;
        } else {
          // Группа пунктов: заголовок + вложенный список
          li.className = "rhelper-popup-whatsnew-group";
          li.textContent = item.title;
          const subUl = document.createElement("ul");
          subUl.className = "rhelper-popup-whatsnew-subitems";
          for (const sub of item.items || []) {
            const subLi = document.createElement("li");
            subLi.textContent = sub;
            subUl.appendChild(subLi);
          }
          li.appendChild(subUl);
        }
        ul.appendChild(li);
      }
      listEl.appendChild(ul);
    }

    banner.hidden = false;

    document.getElementById("whatsNewDismiss").addEventListener("click", async () => {
      banner.hidden = true;
      await chrome.storage.local.set({ lastSeenVersion: currentVersion });
      await sendMessage({ action: "refreshBadge" });
    }, { once: true });
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

    // Проверка обновлений
    const updateBanner = document.getElementById("updateAvailableBanner");
    const versionResp = await sendMessage({ action: "getVersionCheck" });
    const showUpdate = versionResp && versionResp.updateAvailable;

    if (showUpdate) {
      document.getElementById("latestVersionText").textContent = "v" + versionResp.latestVersion;
      updateBanner.hidden = false;
      const isFirefox = typeof chrome.runtime.getBrowserInfo === "function";
      if (!isFirefox) {
        document.getElementById("openStoreFromUpdateBanner").title =
          "Откроется страница расширений браузера.\nНажмите кнопку «Обновить» в верхней части страницы.";
      }
    } else {
      updateBanner.hidden = true;
    }

    const banner = document.getElementById("notConfiguredBanner");
    const mainContent = document.getElementById("mainContent");
    if (!resp.configured) {
      banner.hidden = false;
      mainContent.hidden = true;
      return;
    }
    banner.hidden = true;
    mainContent.hidden = false;
    document.getElementById("testRunCount").textContent = resp.testRunCacheSize;
    document.getElementById("testCaseCount").textContent = resp.testCaseCacheSize;
    document.getElementById("attachmentsCount").textContent = resp.attachmentsCacheSize;
    document.getElementById("inFlightCount").textContent = resp.inFlightCount;
    document.getElementById("storageSize").textContent = formatBytes(resp.storageBytesUsed || 0);

    const itemsEl = document.getElementById("testRunItems");

    // Видимостью списка управляет только кнопка «Закэшированные прогоны»,
    // здесь лишь наполняем его актуальными данными.
    document.getElementById("emptyMessage").hidden = true;
    document.getElementById("testRunEmpty").hidden = resp.testRuns.length > 0;

    itemsEl.textContent = "";

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

  // ===== In-progress cells =====

  async function loadInProgress() {
    const section = document.getElementById("inProgressSection");
    const countEl = document.getElementById("inProgressCount");
    const listEl = document.getElementById("inProgressList");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { action: "getInProgressCells" });
    } catch (e) {
      return;
    }

    if (!resp || !resp.cells || resp.cells.length === 0) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    countEl.textContent = resp.cells.length;
    listEl.textContent = "";
    resp.cells.forEach((num, i) => {
      if (i > 0) listEl.appendChild(document.createTextNode(", "));
      const link = document.createElement("a");
      link.href = "#";
      link.className = "rhelper-popup-inprogress-link";
      link.textContent = num;
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        await chrome.tabs.sendMessage(tab.id, { action: "scrollToCell", cellNumber: num });
        window.close();
      });
      listEl.appendChild(link);
    });
  }

  // Плавающая панель «Мои в разборе» на странице. Контент-скрипт слушает
  // изменения dockState в storage, поэтому здесь достаточно записи.
  async function initDockToggle() {
    const toggle = document.getElementById("dockToggle");
    const saved = (await chrome.storage.local.get(DOCK_STATE_KEY))[DOCK_STATE_KEY];
    toggle.checked = !(saved && saved.hidden);
    toggle.addEventListener("change", async () => {
      const cur = (await chrome.storage.local.get(DOCK_STATE_KEY))[DOCK_STATE_KEY] || {};
      cur.hidden = !toggle.checked;
      await chrome.storage.local.set({ [DOCK_STATE_KEY]: cur });
    });
  }

  // Текст кнопки лежит в отдельном span — меняем его, иначе затрётся иконка
  function setBtnText(btn, text) {
    btn.querySelector(".rhelper-popup-btn-label").textContent = text;
  }

  async function sendToTab(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      return { error: "Контент-скрипт недоступен. Откройте страницу с разбором." };
    }
  }

  // ===== Page statistics button =====

  document.getElementById("pageStatsBtn").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showToast("Нет активной вкладки");
      return;
    }

    const resp = await sendToTab(tab.id, { action: "showPageStats" });
    if (!resp || resp.error) {
      showToast(resp?.error || "Откройте страницу с разбором");
      return;
    }
    window.close();
  });

  // ===== Prefetch button =====

  const prefetchBtn = document.getElementById("prefetchBtn");
  const prefetchDefaultText = prefetchBtn.querySelector(".rhelper-popup-btn-label").textContent;

  prefetchBtn.addEventListener("click", async () => {
    prefetchBtn.disabled = true;
    setBtnText(prefetchBtn, "Поиск прогонов...");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setBtnText(prefetchBtn, "Нет активной вкладки");
      setTimeout(() => { setBtnText(prefetchBtn, prefetchDefaultText); prefetchBtn.disabled = false; }, 2000);
      return;
    }

    const resp = await sendToTab(tab.id, { action: "getPageTestRunKeys" });

    if (!resp || resp.error) {
      setBtnText(prefetchBtn, resp?.error || "Откройте страницу с разбором");
      setTimeout(() => { setBtnText(prefetchBtn, prefetchDefaultText); prefetchBtn.disabled = false; }, 2000);
      return;
    }

    const keys = resp.keys;
    if (!keys || keys.length === 0) {
      setBtnText(prefetchBtn, "Прогоны не найдены");
      setTimeout(() => { setBtnText(prefetchBtn, prefetchDefaultText); prefetchBtn.disabled = false; }, 2000);
      return;
    }

    let done = 0;
    for (const key of keys) {
      done++;
      setBtnText(prefetchBtn, `Кэширование... (${done}/${keys.length})`);
      await sendMessage({ action: "prefetchTestRun", testRunKey: key });
    }

    setBtnText(prefetchBtn, `Закэшировано! ${keys.length} прогонов`);
    await loadStatus();

    setTimeout(() => {
      setBtnText(prefetchBtn, prefetchDefaultText);
      prefetchBtn.disabled = false;
    }, 2000);
  });

  // ===== Clear cache button =====

  const clearBtn = document.getElementById("clearBtn");
  const clearConfirm = document.getElementById("clearConfirm");

  // Первый клик только спрашивает — очистка выполняется по кнопке «Да»
  clearBtn.addEventListener("click", () => {
    clearConfirm.hidden = !clearConfirm.hidden;
  });

  document.getElementById("clearConfirmNo").addEventListener("click", () => {
    clearConfirm.hidden = true;
  });

  document.getElementById("clearConfirmYes").addEventListener("click", async () => {
    clearConfirm.hidden = true;
    clearBtn.disabled = true;
    setBtnText(clearBtn, "Очистка...");

    await sendMessage({ action: "clearCache" });

    setBtnText(clearBtn, "Очищено!");
    await loadStatus();

    setTimeout(() => {
      setBtnText(clearBtn, "Очистить кэш");
      clearBtn.disabled = false;
    }, 1000);
  });

  // ===== Список закэшированных прогонов (сворачивается кнопкой) =====

  const runsBtn = document.getElementById("runsBtn");
  const runsSection = document.getElementById("testRunList");

  runsBtn.addEventListener("click", () => {
    runsSection.hidden = !runsSection.hidden;
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

  // ===== Settings buttons =====

  document.getElementById("openSettingsFromBanner").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("settingsBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("openStoreFromUpdateBanner").addEventListener("click", async () => {
    const isFirefox = typeof chrome.runtime.getBrowserInfo === "function";
    if (isFirefox) {
      const versionResp = await sendMessage({ action: "getVersionCheck" });
      if (versionResp && versionResp.storeUrl) {
        chrome.tabs.create({ url: versionResp.storeUrl });
      }
    } else {
      chrome.tabs.create({ url: "chrome://extensions/" });
    }
    window.close();
  });

  // ===== Debug mode (Ctrl+click on version) =====

  const debugSection = document.getElementById("debugSection");
  const debugInfo = document.getElementById("debugInfo");
  const debugRawData = document.getElementById("debugRawData");

  document.getElementById("extVersion").addEventListener("click", async (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();

    debugSection.hidden = !debugSection.hidden;
    if (!debugSection.hidden) {
      await updateDebugInfo();
    }
  });

  async function updateDebugInfo() {
    const versionResp = await sendMessage({ action: "getVersionCheck" });
    const manifest = chrome.runtime.getManifest();
    const stored = await chrome.storage.local.get("lastSeenVersion");

    const browser = (typeof chrome.runtime.getBrowserInfo === 'function') ? 'Firefox' : 'Chrome';
    const lines = [
      `Browser: ${browser}`,
      `Extension: v${manifest.version}`,
      `Store latest: ${versionResp?.latestVersion || 'N/A'}`,
      `Update available: ${versionResp?.updateAvailable || false}`,
      `Last check: ${versionResp?.lastCheckTime ? new Date(versionResp.lastCheckTime).toLocaleString('ru-RU') : 'never'}`,
      `What's new seen: ${stored.lastSeenVersion || 'never'}`
    ];
    debugInfo.textContent = lines.join('\n');
    const input = document.getElementById("debugLastSeenInput");
    if (input) input.placeholder = stored.lastSeenVersion || "не задано";
  }

  // Отдельным окном, а не вкладкой: за цифрами наблюдают, продолжая работать со страницей,
  // а popup закрылся бы при первом же клике мимо него
  document.getElementById("debugPerfPanel").addEventListener("click", async () => {
    const url = chrome.runtime.getURL("perf.html");
    try {
      await chrome.windows.create({ url, type: "popup", width: 820, height: 720 });
      window.close();
    } catch (e) {
      // На случай, если windows.create недоступен — открыть вкладкой
      chrome.tabs.create({ url });
    }
  });

  document.getElementById("debugResetVersionCache").addEventListener("click", async () => {
    await chrome.storage.local.remove("versionCheck");
    await sendMessage({ action: "setUpdateBadge", show: false });
    debugRawData.hidden = true;
    await updateDebugInfo();
    await loadStatus();
    showToast("Кэш версии сброшен");
  });

  document.getElementById("debugForceVersionCheck").addEventListener("click", async () => {
    const result = await sendMessage({ action: "forceVersionCheck" });
    await updateDebugInfo();
    await loadStatus();
    showToast(`Проверка выполнена\nLatest: ${result?.latestVersion || 'N/A'}\nUpdate: ${result?.updateAvailable || false}`);
  });

  document.getElementById("debugShowRaw").addEventListener("click", async () => {
    if (!debugRawData.hidden) {
      debugRawData.hidden = true;
      return;
    }
    const data = await chrome.storage.local.get("versionCheck");
    debugRawData.textContent = JSON.stringify(data.versionCheck || null, null, 2);
    debugRawData.hidden = false;
  });

  document.getElementById("debugSimulateUpdate").addEventListener("click", async () => {
    const manifest = chrome.runtime.getManifest();
    const parts = manifest.version.split('.').map(Number);
    parts[parts.length - 1]++;
    const fakeVersion = parts.join('.');

    // Сохраняем фейковые данные в storage
    const fakeVersionCheck = {
      lastCheckTime: Date.now(),
      currentVersion: manifest.version,
      latestVersion: fakeVersion,
      updateAvailable: true,
      storeUrl: (typeof chrome.runtime.getBrowserInfo === 'function')
        ? "https://addons.mozilla.org/ru/firefox/addon/r-helper/"
        : "https://chromewebstore.google.com/detail/fpapambilmojcifjplicmmjodjginmaj",
      simulated: true
    };
    await chrome.storage.local.set({ versionCheck: fakeVersionCheck });

    document.getElementById("latestVersionText").textContent = "v" + fakeVersion;
    document.getElementById("updateAvailableBanner").hidden = false;
    await sendMessage({ action: "setUpdateBadge", show: true });
  });

  document.getElementById("debugResetWhatsNew").addEventListener("click", async () => {
    await chrome.storage.local.remove("lastSeenVersion");
    await sendMessage({ action: "refreshBadge" });
    await updateDebugInfo();
    showToast("Отметка «Что нового» сброшена. Откройте попап заново.");
  });

  // Сбрасывает только координаты — видимость и свёрнутость панели остаются как были
  document.getElementById("debugResetDockPos").addEventListener("click", async () => {
    const cur = (await chrome.storage.local.get(DOCK_STATE_KEY))[DOCK_STATE_KEY] || {};
    cur.top = null;
    cur.left = null;
    await chrome.storage.local.set({ [DOCK_STATE_KEY]: cur });
    showToast("Панель вернулась в правый верхний угол");
  });

  document.getElementById("debugSetLastSeen").addEventListener("click", async () => {
    const input = document.getElementById("debugLastSeenInput");
    const value = input.value.trim();
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      showToast("Введите версию в формате x.y.z");
      return;
    }
    await chrome.storage.local.set({ lastSeenVersion: value });
    input.value = "";
    await sendMessage({ action: "refreshBadge" });
    await updateDebugInfo();
    showToast(`lastSeenVersion = ${value}. Откройте попап заново.`);
  });

  document.getElementById("debugFullReset").addEventListener("click", async () => {
    const confirmed = await showConfirm("Удалить ВСЕ данные расширения?\n\nЭто сбросит:\n- Настройки (Jira/Confluence URL)\n- Весь кэш\n- Кэш версии");
    if (!confirmed) return;

    await chrome.storage.local.clear();
    await sendMessage({ action: "setUpdateBadge", show: false });
    showToast("Все данные удалены. Перезагрузите расширение.");
    setTimeout(() => window.close(), 1500);
  });

  loadStatus();
  loadInProgress();
  initDockToggle();
  showWhatsNew();
})();
