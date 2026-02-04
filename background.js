let JIRA_BASE = "";
const CACHE_TTL = 15 * 24 * 60 * 60 * 1000; // 15 дней
const VERSION_CHECK_TTL = 24 * 60 * 60 * 1000; // 24 часа
const VERSION_CHECK_ALARM = "version-check-alarm";
const AMO_API_URL = "https://addons.mozilla.org/api/v5/addons/addon/r-helper/";

const testRunCache = new Map();
const attachmentsCache = new Map();
const inFlightResults = new Map();
let cachedCurrentUser = null;

const cacheLog = [];
const CACHE_LOG_MAX = 500;

const CONTENT_SCRIPT_ID = "rhelper-content-script";

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
  }
}

async function persistCache(name, map) {
  try {
    await chrome.storage.local.set({ [name]: Object.fromEntries(map) });
    logCache("PERSIST", name + ": " + map.size + " entries");
  } catch (e) {
    logCache("PERSIST_ERR", name + ": " + e.message);
  }
}

async function restoreCaches() {
  try {
    const data = await chrome.storage.local.get(["testRunCache", "attachmentsCache", "currentUser"]);
    if (data.testRunCache || data.attachmentsCache) {
      const now = Date.now();
      let expired = 0;
      if (data.testRunCache) {
        for (const [key, value] of Object.entries(data.testRunCache)) {
          if (value && value.ts && now - value.ts <= CACHE_TTL) {
            testRunCache.set(key, value);
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
      if (data.currentUser && data.currentUser.ts && now - data.currentUser.ts <= CACHE_TTL) {
        cachedCurrentUser = data.currentUser.data;
      }
      logCache("RESTORE", "testRuns: " + testRunCache.size + ", attachments: " + attachmentsCache.size + ", expired: " + expired);
      if (expired > 0) {
        persistCache("testRunCache", testRunCache);
        persistCache("attachmentsCache", attachmentsCache);
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
    logCache("VERSION_CHECK", "Chrome: skipped (no public API)");
    return null;
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
      js: ["content.js"],
      css: ["content.css"],
      allFrames: true,
      persistAcrossSessions: true,
      runAt: "document_idle",
    }]);
    logCache("REGISTER", "content script for " + matchPattern);
  } catch (e) {
    logCache("REGISTER_ERR", e.message);
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
    if (!resp.ok) {
      throw new Error(`Failed to fetch test run results: ${resp.status} ${resp.statusText}`);
    }
    const data = await resp.json();
    logCache("FETCHED", testRunKey + " → " + (Array.isArray(data) ? data.length : 0) + " results");
    setCache(testRunCache, testRunKey, data);
    return data;
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

    if (!resp.ok) {
      throw new Error(`Failed to fetch attachments: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    logCache("ATT_FETCHED", testResultId + " → " + (Array.isArray(data) ? data.length : 0) + " items");
    setCache(attachmentsCache, testResultId, data);
    return data;
  } catch (err) {
    logCache("ATT_FETCH_ERR", testResultId + ": " + err.message);
    throw err;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        testRuns.push({ key, resultsCount: Array.isArray(results) ? results.length : 0 });
      }
      let storageBytesUsed = 0;
      if (typeof chrome.storage.local.getBytesInUse === 'function') {
        storageBytesUsed = await chrome.storage.local.getBytesInUse(["testRunCache", "attachmentsCache"]);
      }
      sendResponse({
        testRuns,
        testRunCacheSize: testRunCache.size,
        attachmentsCacheSize: attachmentsCache.size,
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
        sendResponse({ success: true, resultsCount: Array.isArray(results) ? results.length : 0 });
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
      logCache("CLEAR", "testRuns: " + testRunCache.size + ", attachments: " + attachmentsCache.size);
      testRunCache.clear();
      attachmentsCache.clear();
      cachedCurrentUser = null;
      chrome.storage.local.remove(["testRunCache", "attachmentsCache", "currentUser"]);
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
      const result = await checkForUpdates();
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
  if (!resp.ok) throw new Error("Failed to fetch current user: " + resp.status);
  const data = await resp.json();
  cachedCurrentUser = { name: data.name };
  await chrome.storage.local.set({ currentUser: { data: cachedCurrentUser, ts: Date.now() } });
  return cachedCurrentUser;
}

async function handleGetTestResult(testRunKey, testCaseKey, includeAttachments) {
  const results = await fetchTestRunResults(testRunKey);

  const result = results.find((r) => r.testCaseKey === testCaseKey);
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
