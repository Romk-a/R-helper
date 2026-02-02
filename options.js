(function () {
  "use strict";

  const jiraUrlInput = document.getElementById("jiraUrl");
  const confluenceUrlInput = document.getElementById("confluenceUrl");
  const testCasePrefixInput = document.getElementById("testCasePrefix");
  const testRunPrefixInput = document.getElementById("testRunPrefix");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const statusMessage = document.getElementById("statusMessage");

  function showStatus(text, type) {
    statusMessage.textContent = text;
    statusMessage.className = "rhelper-options-status rhelper-options-status-" + type;
    statusMessage.hidden = false;
  }

  function hideStatus() {
    statusMessage.hidden = true;
  }

  function validateUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function normalizeUrl(value) {
    return value.replace(/\/+$/, "");
  }

  function hostPattern(urlStr) {
    try {
      const url = new URL(urlStr);
      return url.origin + "/*";
    } catch (e) {
      return null;
    }
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get("settings");
    if (data.settings) {
      jiraUrlInput.value = data.settings.jiraUrl || "";
      confluenceUrlInput.value = data.settings.confluenceUrl || "";
      testCasePrefixInput.value = data.settings.testCasePrefix || "";
      testRunPrefixInput.value = data.settings.testRunPrefix || "";
    }
  }

  function clearInputErrors() {
    for (const input of [jiraUrlInput, confluenceUrlInput, testCasePrefixInput, testRunPrefixInput]) {
      input.classList.remove("rhelper-options-input-error");
    }
  }

  saveBtn.addEventListener("click", async () => {
    hideStatus();
    clearInputErrors();

    const jiraUrl = normalizeUrl(jiraUrlInput.value.trim());
    const confluenceUrl = normalizeUrl(confluenceUrlInput.value.trim());
    const testCasePrefix = testCasePrefixInput.value.trim();
    const testRunPrefix = testRunPrefixInput.value.trim();

    let hasError = false;

    if (!jiraUrl || !validateUrl(jiraUrl)) {
      jiraUrlInput.classList.add("rhelper-options-input-error");
      hasError = true;
    }
    if (!confluenceUrl || !validateUrl(confluenceUrl)) {
      confluenceUrlInput.classList.add("rhelper-options-input-error");
      hasError = true;
    }
    if (!testCasePrefix) {
      testCasePrefixInput.classList.add("rhelper-options-input-error");
      hasError = true;
    }
    if (!testRunPrefix) {
      testRunPrefixInput.classList.add("rhelper-options-input-error");
      hasError = true;
    }

    if (hasError) {
      showStatus("Заполните все поля корректно.", "error");
      return;
    }

    // Request host permissions for both domains
    const origins = [];
    const jiraPattern = hostPattern(jiraUrl);
    const confluencePattern = hostPattern(confluenceUrl);
    if (jiraPattern) origins.push(jiraPattern);
    if (confluencePattern) origins.push(confluencePattern);

    if (origins.length > 0) {
      try {
        const granted = await chrome.permissions.request({ origins });
        if (!granted) {
          showStatus("Разрешения не были предоставлены. Настройки не сохранены.", "error");
          return;
        }
      } catch (e) {
        showStatus("Ошибка запроса разрешений: " + e.message, "error");
        return;
      }
    }

    jiraUrlInput.value = jiraUrl;
    confluenceUrlInput.value = confluenceUrl;

    const settings = { jiraUrl, confluenceUrl, testCasePrefix, testRunPrefix };
    await chrome.storage.local.set({ settings });

    try {
      await chrome.runtime.sendMessage({ action: "settingsUpdated" });
    } catch (e) {
      // background may not be ready
    }

    showStatus("Настройки сохранены.", "success");
  });

  testBtn.addEventListener("click", async () => {
    hideStatus();
    clearInputErrors();

    const jiraUrl = normalizeUrl(jiraUrlInput.value.trim());
    if (!jiraUrl || !validateUrl(jiraUrl)) {
      jiraUrlInput.classList.add("rhelper-options-input-error");
      showStatus("Введите корректный Jira URL.", "error");
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "Проверка...";

    try {
      const resp = await fetch(jiraUrl + "/rest/api/2/myself", { credentials: "include" });
      if (resp.ok) {
        const data = await resp.json();
        showStatus("Подключение успешно! Пользователь: " + (data.displayName || data.name), "success");
      } else if (resp.status === 401 || resp.status === 403) {
        showStatus("Требуется авторизация. Войдите в Jira в браузере.", "error");
      } else {
        showStatus("Ошибка: " + resp.status + " " + resp.statusText, "error");
      }
    } catch (e) {
      showStatus("Не удалось подключиться: " + e.message, "error");
    }

    testBtn.disabled = false;
    testBtn.textContent = "Проверить подключение";
  });

  loadSettings();
})();
