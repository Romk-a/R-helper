let JIRA_BASE = "";
const CACHE_TTL = 15 * 24 * 60 * 60 * 1000; // 15 дней
const VERSION_CHECK_TTL = 2 * 60 * 60 * 1000; // 2 часа
const VERSION_CHECK_ALARM = "version-check-alarm";
const AMO_API_URL = "https://addons.mozilla.org/api/v5/addons/addon/r-helper/";
const CWS_EXTENSION_ID = "fpapambilmojcifjplicmmjodjginmaj";
const CWS_UPDATE_URL = `https://clients2.google.com/service/update2/crx?response=updatecheck&x=id%3D${CWS_EXTENSION_ID}%26uc&prodversion=999&acceptformat=crx3`;
const CWS_STORE_URL = `https://chromewebstore.google.com/detail/${CWS_EXTENSION_ID}`;

const testRunCache = new Map();
const attachmentsCache = new Map();
const testCaseCache = new Map();
const testCaseInfoCache = new Map();
const inFlightResults = new Map();
const inFlightTestCases = new Map();
const inFlightTestCaseInfo = new Map();
let cachedCurrentUser = null;

const cacheLog = [];
const CACHE_LOG_MAX = 500;

const CONTENT_SCRIPT_ID = "rhelper-content-script";
const JIRA_CONTENT_SCRIPT_ID = "rhelper-jira-content-script";

function logCache(action, details) {
  cacheLog.push({ ts: Date.now(), action, details });
  if (cacheLog.length > CACHE_LOG_MAX) cacheLog.splice(0, cacheLog.length - CACHE_LOG_MAX);
}

function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    logCache("EXPIRED", key);
    return null;
  }
  return entry.data;
}

function setCache(cache, key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache === testRunCache) {
    persistCache("testRunCache", testRunCache);
  } else if (cache === attachmentsCache) {
    persistCache("attachmentsCache", attachmentsCache);
  } else if (cache === testCaseCache) {
    persistCache("testCaseCache", testCaseCache);
  } else if (cache === testCaseInfoCache) {
    persistCache("testCaseInfoCache", testCaseInfoCache);
  }
}

async function persistCache(name, map) {
  try {
    const plain = {};
    for (const [key, entry] of map) {
      const data = entry.data instanceof Map ? [...entry.data] : entry.data;
      plain[key] = { data, ts: entry.ts };
    }
    await chrome.storage.local.set({ [name]: plain });
    logCache("PERSIST", name + ": " + map.size + " entries");
  } catch (e) {
    logCache("PERSIST_ERR", name + ": " + e.message);
  }
}

async function restoreCaches() {
  try {
    const data = await chrome.storage.local.get(["testRunCache", "attachmentsCache", "testCaseCache", "testCaseInfoCache", "currentUser"]);
    if (data.testRunCache || data.attachmentsCache || data.testCaseCache || data.testCaseInfoCache) {
      const now = Date.now();
      let expired = 0;
      if (data.testRunCache) {
        for (const [key, value] of Object.entries(data.testRunCache)) {
          if (value && value.ts && now - value.ts <= CACHE_TTL) {
            const d = Array.isArray(value.data) ? new Map(value.data) : value.data;
            testRunCache.set(key, { data: d, ts: value.ts });
          } else {
            expired++;
          }
        }
      }
      if (data.attachmentsCache) {
        for (const [key, value] of Object.entries(data.attachmentsCache)) {
          if (value && value.ts && now - value.ts <= CACHE_TTL) {
            attachmentsCache.set(key, value);
          } else {
            expired++;
          }
        }
      }
      if (data.testCaseCache) {
        for (const [key, value] of Object.entries(data.testCaseCache)) {
          if (value && value.ts && now - value.ts <= CACHE_TTL) {
            testCaseCache.set(key, value);
          } else {
            expired++;
          }
        }
      }
      if (data.testCaseInfoCache) {
        for (const [key, value] of Object.entries(data.testCaseInfoCache)) {
          if (value && value.ts && now - value.ts <= CACHE_TTL) {
            testCaseInfoCache.set(key, value);
          } else {
            expired++;
          }
        }
      }
      if (data.currentUser && data.currentUser.ts && now - data.currentUser.ts <= CACHE_TTL) {
        cachedCurrentUser = data.currentUser.data;
      }
      logCache("RESTORE", "testRuns: " + testRunCache.size + ", attachments: " + attachmentsCache.size + ", testCases: " + testCaseCache.size + ", testCaseInfo: " + testCaseInfoCache.size + ", expired: " + expired);
      if (expired > 0) {
        persistCache("testRunCache", testRunCache);
        persistCache("attachmentsCache", attachmentsCache);
        persistCache("testCaseCache", testCaseCache);
        persistCache("testCaseInfoCache", testCaseInfoCache);
      }
    } else {
      logCache("RESTORE", "storage empty");
    }
  } catch (e) {
    logCache("RESTORE_ERR", e.message);
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get("settings");
  if (data.settings && data.settings.jiraUrl) {
    JIRA_BASE = data.settings.jiraUrl;
    logCache("SETTINGS", "jiraUrl=" + JIRA_BASE);
    await registerContentScript(data.settings.confluenceUrl);
    await registerJiraContentScript(data.settings.jiraUrl);
  } else {
    JIRA_BASE = "";
    logCache("SETTINGS", "not configured");
  }
}

// ===== Version check functions =====

async function detectBrowser() {
  if (typeof chrome.runtime.getBrowserInfo === 'function') {
    try {
      await chrome.runtime.getBrowserInfo();
      return 'firefox';
    } catch (e) {
      return 'chrome';
    }
  }
  return 'chrome';
}

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

async function checkForUpdates() {
  const browser = await detectBrowser();
  const manifest = chrome.runtime.getManifest();
  const currentVersion = manifest.version;

  if (browser === 'chrome') {
    try {
      logCache("VERSION_CHECK", "Chrome: checking CWS for updates...");
      const resp = await fetch(CWS_UPDATE_URL, { credentials: "omit" });

      if (!resp.ok) {
        logCache("VERSION_CHECK_ERR", `CWS update API returned ${resp.status}`);
        return null;
      }

      const xml = await resp.text();
      const match = xml.match(/<updatecheck[^>]+version=["']([^"']+)["']/);
      const latestVersion = match?.[1];

      if (!latestVersion) {
        logCache("VERSION_CHECK_ERR", "No version in CWS response");
        return null;
      }

      logCache("VERSION_CHECK", `Current: ${currentVersion}, CWS latest: ${latestVersion}`);

      const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;

      const versionCheck = {
        lastCheckTime: Date.now(),
        currentVersion,
        latestVersion,
        updateAvailable,
        storeUrl: CWS_STORE_URL,
        browser
      };

      await chrome.storage.local.set({ versionCheck });
      await setUpdateBadge(updateAvailable);
      logCache("VERSION_CHECK", updateAvailable ? "Update available!" : "Up to date");

      return versionCheck;
    } catch (err) {
      logCache("VERSION_CHECK_ERR", `Chrome: ${err.message}`);
      return null;
    }
  }

  try {
    logCache("VERSION_CHECK", "Checking AMO for updates...");
    const resp = await fetch(AMO_API_URL, { credentials: "omit" });

    if (!resp.ok) {
      logCache("VERSION_CHECK_ERR", `AMO API returned ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const latestVersion = data?.current_version?.version;

    if (!latestVersion) {
      logCache("VERSION_CHECK_ERR", "No version in AMO response");
      return null;
    }

    logCache("VERSION_CHECK", `Current: ${currentVersion}, Latest: ${latestVersion}`);

    const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;

    const versionCheck = {
      lastCheckTime: Date.now(),
      currentVersion,
      latestVersion,
      updateAvailable,
      storeUrl: "https://addons.mozilla.org/ru/firefox/addon/r-helper/",
      browser
    };

    await chrome.storage.local.set({ versionCheck });
    await setUpdateBadge(updateAvailable);
    logCache("VERSION_CHECK", updateAvailable ? "Update available!" : "Up to date");

    return versionCheck;
  } catch (err) {
    logCache("VERSION_CHECK_ERR", err.message);
    return null;
  }
}

async function getCachedVersionCheck() {
  const data = await chrome.storage.local.get("versionCheck");
  const cached = data.versionCheck;

  if (!cached) return null;

  // Invalidate cache if extension version changed (e.g. after update)
  const currentVersion = chrome.runtime.getManifest().version;
  if (cached.currentVersion !== currentVersion) {
    logCache("VERSION_CACHE", "invalidated (extension updated)");
    return null;
  }

  const age = Date.now() - cached.lastCheckTime;
  if (age > VERSION_CHECK_TTL) {
    logCache("VERSION_CACHE", "expired");
    return null;
  }

  logCache("VERSION_CACHE", "hit");
  return cached;
}

async function setUpdateBadge(show) {
  if (show) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function registerContentScript(confluenceUrl) {
  if (!confluenceUrl) return;

  let matchPattern;
  try {
    const url = new URL(confluenceUrl);
    matchPattern = url.origin + "/*";
  } catch (e) {
    logCache("REGISTER_ERR", "bad confluenceUrl: " + e.message);
    return;
  }

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (e) {
    // not registered yet — that's fine
  }

  try {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: [matchPattern],
      js: ["content-shared.js", "content.js"],
      css: ["content.css"],
      allFrames: false,
      persistAcrossSessions: true,
      runAt: "document_idle",
    }]);
    logCache("REGISTER", "content script for " + matchPattern);
  } catch (e) {
    logCache("REGISTER_ERR", e.message);
  }
}

async function registerJiraContentScript(jiraUrl) {
  if (!jiraUrl) return;

  let matchPattern;
  try {
    const url = new URL(jiraUrl);
    matchPattern = url.origin + "/secure/Tests.jspa*";
  } catch (e) {
    logCache("REGISTER_ERR", "bad jiraUrl: " + e.message);
    return;
  }

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [JIRA_CONTENT_SCRIPT_ID] });
  } catch (e) {
    // not registered yet — that's fine
  }

  try {
    await chrome.scripting.registerContentScripts([{
      id: JIRA_CONTENT_SCRIPT_ID,
      matches: [matchPattern],
      js: ["content-shared.js", "content-jira.js"],
      css: ["content.css"],
      allFrames: false,
      persistAcrossSessions: true,
      runAt: "document_idle",
    }]);
    logCache("REGISTER", "jira content script for " + matchPattern);
  } catch (e) {
    logCache("REGISTER_ERR", "jira: " + e.message);
  }
}

const initReady = Promise.all([restoreCaches(), loadSettings()]);

// Создание alarm для периодической проверки версий (каждые 24 часа)
chrome.alarms.get(VERSION_CHECK_ALARM, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(VERSION_CHECK_ALARM, { periodInMinutes: 1440 });
    logCache("ALARM", "Version check alarm created");
  }
});

// Проверка версии при старте (если кэш пустой или устарел) + восстановление badge
initReady.then(async () => {
  const cached = await getCachedVersionCheck();
  if (cached) {
    await setUpdateBadge(cached.updateAvailable);
  } else {
    await checkForUpdates();
  }
});

// Обработчик alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VERSION_CHECK_ALARM) {
    logCache("ALARM", "Version check alarm fired");
    initReady.then(() => checkForUpdates());
  }
});

function ensureConfigured() {
  if (!JIRA_BASE) {
    throw new Error("Расширение не настроено. Откройте настройки и укажите URL.");
  }
}

function checkAuthResponse(resp, context) {
  if (resp.ok) return;
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Сессия истекла. Войдите в Jira и обновите страницу.");
  }
  throw new Error(`${context}: ${resp.status} ${resp.statusText}`);
}

async function fetchTestRunResults(testRunKey) {
  ensureConfigured();

  const cached = getCached(testRunCache, testRunKey);
  if (cached) {
    logCache("HIT", testRunKey);
    return cached;
  }

  if (inFlightResults.has(testRunKey)) {
    logCache("IN_FLIGHT", testRunKey);
    return inFlightResults.get(testRunKey);
  }

  logCache("FETCH", testRunKey);
  const promise = (async () => {
    const url = `${JIRA_BASE}/rest/atm/1.0/testrun/${testRunKey}/testresults`;
    const resp = await fetch(url, { credentials: "include" });
    checkAuthResponse(resp, "Ошибка загрузки результатов");
    const data = await resp.json();
    const map = new Map(Array.isArray(data) ? data.map((r) => [r.testCaseKey, r]) : []);
    logCache("FETCHED", testRunKey + " → " + map.size + " results");
    setCache(testRunCache, testRunKey, map);
    return map;
  })();

  inFlightResults.set(testRunKey, promise);
  try {
    return await promise;
  } catch (err) {
    logCache("FETCH_ERR", testRunKey + ": " + err.message);
    throw err;
  } finally {
    inFlightResults.delete(testRunKey);
  }
}

async function fetchAttachments(testResultId) {
  ensureConfigured();

  const cached = getCached(attachmentsCache, testResultId);
  if (cached) {
    logCache("ATT_HIT", String(testResultId));
    return cached;
  }

  const url = `${JIRA_BASE}/rest/atm/1.0/testresult/${testResultId}/attachments`;
  try {
    const resp = await fetch(url, { credentials: "include" });

    checkAuthResponse(resp, "Ошибка загрузки вложений");

    const data = await resp.json();
    logCache("ATT_FETCHED", testResultId + " → " + (Array.isArray(data) ? data.length : 0) + " items");
    setCache(attachmentsCache, testResultId, data);
    return data;
  } catch (err) {
    logCache("ATT_FETCH_ERR", testResultId + ": " + err.message);
    throw err;
  }
}

async function fetchExecutionResult(executionKey) {
  ensureConfigured();

  const cached = getCached(testCaseCache, executionKey);
  if (cached) {
    logCache("TC_HIT", executionKey);
    return cached;
  }

  if (inFlightTestCases.has(executionKey)) {
    logCache("TC_IN_FLIGHT", executionKey);
    return inFlightTestCases.get(executionKey);
  }

  logCache("TC_FETCH", executionKey);
  const promise = (async () => {
    const url = `${JIRA_BASE}/rest/tests/1.0/testresult/${executionKey}?fields=id,comment,status,traceLinks,testScriptResults(traceLinks),testRun(name)`;
    const resp = await fetch(url, { credentials: "include" });
    checkAuthResponse(resp, "Ошибка загрузки результата выполнения");
    const data = await resp.json();
    logCache("TC_FETCHED", executionKey);
    setCache(testCaseCache, executionKey, data);
    return data;
  })();

  inFlightTestCases.set(executionKey, promise);
  try {
    return await promise;
  } catch (err) {
    logCache("TC_FETCH_ERR", executionKey + ": " + err.message);
    throw err;
  } finally {
    inFlightTestCases.delete(executionKey);
  }
}

function collectTraceLinks(data) {
  const seen = new Set();
  const all = [];
  const collect = (links) => {
    if (!links) return;
    for (const link of links) {
      if (!seen.has(link.issueId)) {
        seen.add(link.issueId);
        all.push(link);
      }
    }
  };
  collect(data.traceLinks);
  if (data.testScriptResults) {
    for (const step of data.testScriptResults) {
      collect(step.traceLinks);
    }
  }
  return all;
}

async function fetchIssueInfo(issueId) {
  ensureConfigured();
  const url = `${JIRA_BASE}/rest/api/2/issue/${issueId}?fields=summary`;
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) return null;
  const data = await resp.json();
  return { key: data.key, summary: data.fields.summary };
}

async function handleGetTestCaseResults(testCaseKey, executionKey, includeAttachments) {
  let result;
  try {
    result = await fetchExecutionResult(executionKey);
  } catch (e) {
    return { found: false, comment: null, attachments: [], status: null, issueLinks: [] };
  }

  let attachments = [];
  if (includeAttachments && result.id) {
    try {
      attachments = await fetchAttachments(result.id);
    } catch (e) {
      // Attachments fetch failed, return result without them
    }
  }

  let issueLinks = [];
  try {
    const traceLinks = collectTraceLinks(result);
    if (traceLinks.length > 0) {
      const resolved = await Promise.all(
        traceLinks.map((link) => fetchIssueInfo(link.issueId).catch(() => null))
      );
      issueLinks = resolved.filter(Boolean);
    }
  } catch (e) {
    // Trace links fetch failed, return result without them
  }

  return {
    found: true,
    comment: result.comment || null,
    status: result.status || null,
    attachments: attachments || [],
    issueLinks,
    testRunName: result.testRun?.name || null,
  };
}

async function fetchTestCaseInfo(testCaseKey) {
  ensureConfigured();

  const cached = getCached(testCaseInfoCache, testCaseKey);
  if (cached) {
    logCache("TCI_HIT", testCaseKey);
    return cached;
  }

  if (inFlightTestCaseInfo.has(testCaseKey)) {
    logCache("TCI_IN_FLIGHT", testCaseKey);
    return inFlightTestCaseInfo.get(testCaseKey);
  }

  logCache("TCI_FETCH", testCaseKey);
  const promise = (async () => {
    const url = `${JIRA_BASE}/rest/atm/1.0/testcase/${testCaseKey}`;
    const resp = await fetch(url, { credentials: "include" });
    checkAuthResponse(resp, "Ошибка загрузки информации о тест-кейсе");
    const data = await resp.json();
    logCache("TCI_FETCHED", testCaseKey);
    setCache(testCaseInfoCache, testCaseKey, data);
    return data;
  })();

  inFlightTestCaseInfo.set(testCaseKey, promise);
  try {
    return await promise;
  } catch (err) {
    logCache("TCI_FETCH_ERR", testCaseKey + ": " + err.message);
    throw err;
  } finally {
    inFlightTestCaseInfo.delete(testCaseKey);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getTestCaseInfo") {
    initReady
      .then(() => fetchTestCaseInfo(message.testCaseKey))
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "getTestCaseResults") {
    initReady
      .then(() => handleGetTestCaseResults(message.testCaseKey, message.executionKey, message.includeAttachments !== false))
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "getTestResult") {
    initReady
      .then(() => handleGetTestResult(message.testRunKey, message.testCaseKey, message.includeAttachments !== false))
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "downloadAttachment") {
    initReady
      .then(() => handleDownloadAttachment(message.attachmentId, message.fileName))
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "getCurrentUser") {
    initReady
      .then(() => handleGetCurrentUser())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "getCacheStatus") {
    initReady.then(async () => {
      const manifest = chrome.runtime.getManifest();
      const testRuns = [];
      for (const [key, entry] of testRunCache) {
        const results = entry && entry.data;
        testRuns.push({ key, resultsCount: results instanceof Map ? results.size : 0 });
      }
      let storageBytesUsed = 0;
      if (typeof chrome.storage.local.getBytesInUse === 'function') {
        storageBytesUsed = await chrome.storage.local.getBytesInUse(["testRunCache", "attachmentsCache", "testCaseCache", "testCaseInfoCache"]);
      }
      sendResponse({
        testRuns,
        testRunCacheSize: testRunCache.size,
        attachmentsCacheSize: attachmentsCache.size,
        testCaseCacheSize: testCaseCache.size,
        testCaseInfoCacheSize: testCaseInfoCache.size,
        inFlightCount: inFlightResults.size,
        storageBytesUsed,
        name: manifest.name,
        version: manifest.version,
        configured: !!JIRA_BASE,
      });
    });
    return true;
  }

  if (message.action === "getCacheLog") {
    sendResponse({ log: cacheLog });
    return false;
  }

  if (message.action === "prefetchTestRun") {
    initReady.then(async () => {
      try {
        const results = await fetchTestRunResults(message.testRunKey);
        sendResponse({ success: true, resultsCount: results.size });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (message.action === "deleteCacheEntry") {
    initReady.then(() => {
      const key = message.testRunKey;
      const deleted = testRunCache.delete(key);
      logCache("DELETE", key + (deleted ? " removed" : " not found"));
      persistCache("testRunCache", testRunCache);
      sendResponse({ success: deleted });
    });
    return true;
  }

  if (message.action === "clearCache") {
    initReady.then(() => {
      logCache("CLEAR", "testRuns: " + testRunCache.size + ", attachments: " + attachmentsCache.size + ", testCases: " + testCaseCache.size + ", testCaseInfo: " + testCaseInfoCache.size);
      testRunCache.clear();
      attachmentsCache.clear();
      testCaseCache.clear();
      testCaseInfoCache.clear();
      cachedCurrentUser = null;
      chrome.storage.local.remove(["testRunCache", "attachmentsCache", "testCaseCache", "testCaseInfoCache", "currentUser"]);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === "settingsUpdated") {
    loadSettings().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === "getVersionCheck") {
    initReady.then(async () => {
      let cached = await getCachedVersionCheck();
      if (!cached) cached = await checkForUpdates();
      sendResponse(cached || { updateAvailable: false });
    });
    return true;
  }

  if (message.action === "forceVersionCheck") {
    initReady.then(async () => {
      let result = await checkForUpdates();
      if (!result) result = await getCachedVersionCheck();
      sendResponse(result || { updateAvailable: false });
    });
    return true;
  }

  if (message.action === "setUpdateBadge") {
    setUpdateBadge(message.show).then(() => sendResponse({ success: true }));
    return true;
  }
});

async function handleGetCurrentUser() {
  ensureConfigured();
  if (cachedCurrentUser) return cachedCurrentUser;
  const resp = await fetch(JIRA_BASE + "/rest/api/2/myself", { credentials: "include" });
  checkAuthResponse(resp, "Ошибка загрузки пользователя");
  const data = await resp.json();
  cachedCurrentUser = { name: data.name };
  await chrome.storage.local.set({ currentUser: { data: cachedCurrentUser, ts: Date.now() } });
  return cachedCurrentUser;
}

async function handleGetTestResult(testRunKey, testCaseKey, includeAttachments) {
  const results = await fetchTestRunResults(testRunKey);

  const result = results.get(testCaseKey);
  if (!result) {
    return { found: false, comment: null, attachments: [], status: null };
  }

  let attachments = [];
  if (includeAttachments && result.id) {
    try {
      attachments = await fetchAttachments(result.id);
    } catch (e) {
      // Attachments fetch failed, return result without them
    }
  }

  return {
    found: true,
    comment: result.comment || null,
    status: result.status || null,
    attachments: attachments || [],
  };
}

async function handleDownloadAttachment(attachmentId, fileName) {
  ensureConfigured();
  const url = `${JIRA_BASE}/rest/tests/1.0/attachment/${attachmentId}`;
  await chrome.downloads.download({ url, filename: fileName, saveAs: false });
  return { success: true };
}
