const JIRA_BASE = "https://jira.example.ru";
const CACHE_TTL = 15 * 24 * 60 * 60 * 1000; // 15 дней

const testRunCache = new Map();
const attachmentsCache = new Map();
const inFlightResults = new Map();

const cacheLog = [];
const CACHE_LOG_MAX = 500;

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
    const data = await chrome.storage.local.get(["testRunCache", "attachmentsCache"]);
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

const cacheReady = restoreCaches();

async function fetchTestRunResults(testRunKey) {
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
    cacheReady
      .then(() => handleGetTestResult(message.testRunKey, message.testCaseKey, message.includeAttachments !== false))
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "downloadAttachment") {
    handleDownloadAttachment(message.attachmentId, message.fileName)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "getCacheStatus") {
    cacheReady.then(async () => {
      const manifest = chrome.runtime.getManifest();
      const testRuns = [];
      for (const [key, entry] of testRunCache) {
        const results = entry && entry.data;
        testRuns.push({ key, resultsCount: Array.isArray(results) ? results.length : 0 });
      }
      let storageBytesUsed = 0;
      try {
        storageBytesUsed = await chrome.storage.local.getBytesInUse(["testRunCache", "attachmentsCache"]);
      } catch (e) { /* ignore */ }
      sendResponse({
        testRuns,
        testRunCacheSize: testRunCache.size,
        attachmentsCacheSize: attachmentsCache.size,
        inFlightCount: inFlightResults.size,
        storageBytesUsed,
        name: manifest.name,
        version: manifest.version,
      });
    });
    return true;
  }

  if (message.action === "getCacheLog") {
    sendResponse({ log: cacheLog });
    return false;
  }

  if (message.action === "prefetchTestRun") {
    cacheReady.then(async () => {
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
    cacheReady.then(() => {
      const key = message.testRunKey;
      const deleted = testRunCache.delete(key);
      logCache("DELETE", key + (deleted ? " removed" : " not found"));
      persistCache("testRunCache", testRunCache);
      sendResponse({ success: deleted });
    });
    return true;
  }

  if (message.action === "clearCache") {
    cacheReady.then(() => {
      logCache("CLEAR", "testRuns: " + testRunCache.size + ", attachments: " + attachmentsCache.size);
      testRunCache.clear();
      attachmentsCache.clear();
      chrome.storage.local.remove(["testRunCache", "attachmentsCache"]);
      sendResponse({ success: true });
    });
    return true;
  }
});

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
  const url = `${JIRA_BASE}/rest/tests/1.0/attachment/${attachmentId}`;
  await chrome.downloads.download({ url, filename: fileName, saveAs: false });
  return { success: true };
}
