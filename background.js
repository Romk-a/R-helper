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

// ===== Замеры производительности =====
//
// MV3 выгружает service worker через ~30 с простоя, поэтому держать замеры только
// в памяти нельзя: панель, открытая после любой паузы, показывала бы пустоту.
// Статистика сохраняется в storage, но так, чтобы почти ничего не стоить: запись
// откладывается на PERF_PERSIST_DELAY и по возможности уезжает «прицепом» к записи
// прогонов (см. persistDirtyRuns), а сама persistPerf() ничего не замеряет.

const perfLog = [];
// Одно число и для памяти, и для диска: при разных значениях лог схлопывался бы
// на каждом засыпании воркера до меньшего из них, а большее почти не достигалось
const PERF_LOG_MAX = 200;
const perfStartedAt = Date.now();
const PERF_KEY = "perfStats";
const PERF_PERSIST_DELAY = 5000;

// Накопительные итоги по op: { count, total, max, bytes }. Переживают выгрузку
// service worker'а, поэтому показывают картину за дни, а не за текущую сессию.
let perfTotals = {};
let perfSince = Date.now(); // с какого момента копятся итоги (сбрасывается кнопкой)
let perfDirty = false;
let perfPersistTimer = null;

// op — что мерили ("persist", "fetch", …), bytes необязателен
function logPerf(op, ms, details, bytes) {
  const value = Math.round(ms * 10) / 10;
  perfLog.push({ ts: Date.now(), op, ms: value, details, bytes: bytes || 0 });
  if (perfLog.length > PERF_LOG_MAX) perfLog.splice(0, perfLog.length - PERF_LOG_MAX);

  const t = perfTotals[op] || (perfTotals[op] = { count: 0, total: 0, max: 0, bytes: 0 });
  t.count++;
  t.total = Math.round((t.total + value) * 10) / 10;
  t.bytes += bytes || 0;
  if (value > t.max) t.max = value;

  schedulePerfPersist();
}

// Статистику сохраняем редко и по возможности «прицепом» к записи прогонов
// (см. persistDirtyRuns) — иначе замеры сами добавляли бы работу тому, что замеряют.
function schedulePerfPersist() {
  perfDirty = true;
  if (perfPersistTimer) return;
  perfPersistTimer = setTimeout(() => {
    perfPersistTimer = null;
    persistPerf();
  }, PERF_PERSIST_DELAY);
}

function perfPayload() {
  return { totals: perfTotals, log: perfLog, since: perfSince, savedAt: Date.now() };
}

// Намеренно без logPerf(): замерять запись собственной статистики — рекурсия без пользы
async function persistPerf() {
  if (!perfDirty) return;
  perfDirty = false;
  try {
    await chrome.storage.local.set({ [PERF_KEY]: perfPayload() });
  } catch (e) {
    logCache("PERF_ERR", e.message);
  }
}

function formatKb(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " МБ";
  return Math.round(bytes / 1024) + " КБ";
}

// Строится из накопительных итогов, а не из perfLog: лог хранит только последние
// PERF_LOG_MAX записей, а итоги считают всё, что было с момента perfSince
function summarizePerf() {
  return Object.entries(perfTotals)
    .map(([op, t]) => ({
      op,
      count: t.count,
      total: t.total,
      max: t.max,
      bytes: t.bytes || 0,
      avg: Math.round((t.total / t.count) * 10) / 10,
    }))
    .sort((a, b) => b.total - a.total);
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
  // Прогоны лежат в storage по одному ключу на прогон — пишем только изменившийся
  if (cache === testRunCache) {
    scheduleRunPersist(key);
    return;
  }
  const name = cacheName(cache);
  if (name) schedulePersist(name, cache);
}

function cacheName(cache) {
  if (cache === attachmentsCache) return "attachmentsCache";
  if (cache === testCaseCache) return "testCaseCache";
  if (cache === testCaseInfoCache) return "testCaseInfoCache";
  return null;
}

// Запись всего кэша целиком стоит дорого (сериализация + запись в LevelDB), а при
// префетче setCache() дёргается на каждый прогон подряд. Поэтому запись откладывается
// и слипается: N подряд идущих обновлений одного кэша дают одну запись на диск.
const PERSIST_DELAY = 1000;
const persistTimers = new Map();

function schedulePersist(name, map) {
  if (persistTimers.has(name)) return; // запись уже назначена — она подхватит и это обновление
  persistTimers.set(name, setTimeout(() => {
    persistTimers.delete(name);
    persistCache(name, map);
  }, PERSIST_DELAY));
}

// Отложенная запись пережила бы очистку кэша и вернула бы в storage пустой объект
function cancelPendingPersists() {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  clearTimeout(runPersistTimer);
  runPersistTimer = null;
  dirtyRuns.clear();
}

async function persistCache(name, map) {
  // Назначенная запись больше не нужна: этот вызов пишет тот же кэш целиком
  const pending = persistTimers.get(name);
  if (pending) {
    clearTimeout(pending);
    persistTimers.delete(name);
  }
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

// ===== Кэш прогонов: по одному ключу storage на прогон =====
//
// Раньше весь кэш прогонов лежал под единственным ключом "testRunCache", поэтому
// добавление одного прогона (~1 МБ) переписывало на диск всё разом (десятки МБ),
// а старт service worker'а читал и парсил их целиком, задерживая первый ответ.
// Теперь каждый прогон — свой ключ, а при старте читается только индекс; сами
// прогоны подтягиваются по обращению (см. getCachedRun).

const RUN_KEY_PREFIX = "testRun:";
const RUN_INDEX_KEY = "testRunIndex";
const LEGACY_RUN_CACHE_KEY = "testRunCache";

// runKey -> { ts, count }: что лежит на диске. count нужен панели расширения,
// которая показывает число результатов, не загружая сами прогоны.
let testRunIndex = {};
const dirtyRuns = new Set();
let runPersistTimer = null;

function runStorageKey(runKey) {
  return RUN_KEY_PREFIX + runKey;
}

function scheduleRunPersist(runKey) {
  dirtyRuns.add(runKey);
  if (runPersistTimer) return; // запись уже назначена — она подхватит и этот прогон
  runPersistTimer = setTimeout(persistDirtyRuns, PERSIST_DELAY);
}

// Все накопившиеся прогоны уходят одним storage.set вместе с индексом:
// при префетче это одна запись на пачку вместо записи на каждый прогон.
async function persistDirtyRuns() {
  runPersistTimer = null;
  if (dirtyRuns.size === 0) return;

  const keys = [...dirtyRuns];
  dirtyRuns.clear();

  const t0 = performance.now();
  try {
    const writes = {};
    let results = 0;
    for (const runKey of keys) {
      const entry = testRunCache.get(runKey);
      if (!entry) continue; // прогон успели удалить, пока ждали записи
      const data = entry.data instanceof Map ? [...entry.data] : entry.data;
      writes[runStorageKey(runKey)] = { data, ts: entry.ts };
      testRunIndex[runKey] = { ts: entry.ts, count: entry.data instanceof Map ? entry.data.size : 0 };
      results += data.length;
    }
    writes[RUN_INDEX_KEY] = testRunIndex;
    // Раз уж пишем — заодно сохраняем накопленную статистику, чтобы не делать
    // ради неё отдельный поход в storage. Замер ниже включает и её объём.
    if (perfDirty) {
      writes[PERF_KEY] = perfPayload();
      perfDirty = false;
      clearTimeout(perfPersistTimer);
      perfPersistTimer = null;
    }
    await chrome.storage.local.set(writes);
    const ms = performance.now() - t0;
    // Размер намеренно не считаем: JSON.stringify ради статистики удвоил бы стоимость записи.
    // Объём на диске панель берёт из getBytesInUse(), когда её открывают.
    logPerf("persist", ms, keys.length + " прогонов, " + results + " результатов: " + keys.join(", "));
    logCache("PERSIST_RUNS", keys.length + " прогонов за " + Math.round(ms) + " мс: " + keys.join(", "));
  } catch (e) {
    // Ключи уже вынуты из dirtyRuns — возвращаем, иначе прогоны остались бы только
    // в памяти и пропали бы вместе с воркером. Таймер не взводим: повтор случится
    // при следующей записи, а немедленная повторная попытка при полном диске зациклилась бы.
    for (const runKey of keys) dirtyRuns.add(runKey);
    perfDirty = true;
    logPerf("persist", performance.now() - t0, "ошибка: " + e.message);
    logCache("PERSIST_ERR", "runs: " + e.message);
  }
}

// Прогон из памяти, а если его там нет — с диска. Единственное место, где прогон
// поднимается в память, поэтому TTL проверяется здесь же — и для памяти, и для диска.
async function getCachedRun(runKey) {
  const entry = testRunCache.get(runKey);
  if (entry) {
    if (Date.now() - entry.ts > CACHE_TTL) {
      await dropRun(runKey); // чистит и память, и диск, и индекс
      logCache("EXPIRED", runKey);
      return null;
    }
    return entry.data;
  }

  const meta = testRunIndex[runKey];
  if (!meta) return null;
  if (Date.now() - meta.ts > CACHE_TTL) {
    await dropRun(runKey);
    logCache("EXPIRED", runKey);
    return null;
  }

  try {
    const t0 = performance.now();
    const stored = await chrome.storage.local.get(runStorageKey(runKey));
    const value = stored[runStorageKey(runKey)];
    if (!value) {
      await dropRun(runKey); // индекс разошёлся с реальностью
      return null;
    }
    const map = new Map(value.data);
    testRunCache.set(runKey, { data: map, ts: value.ts });
    const ms = performance.now() - t0;
    logPerf("load", ms, runKey + " → " + map.size + " результатов");
    logCache("LOAD", runKey + " → " + map.size + " results за " + Math.round(ms) + " мс");
    return map;
  } catch (e) {
    logCache("LOAD_ERR", runKey + ": " + e.message);
    return null;
  }
}

async function dropRun(runKey) {
  testRunCache.delete(runKey);
  dirtyRuns.delete(runKey);
  delete testRunIndex[runKey];
  try {
    await chrome.storage.local.remove(runStorageKey(runKey));
    await chrome.storage.local.set({ [RUN_INDEX_KEY]: testRunIndex });
  } catch (e) {
    logCache("DROP_ERR", runKey + ": " + e.message);
  }
}

// Старый формат: всё в одном ключе. Раскладываем по ключам и удаляем исходный.
async function migrateLegacyRunCache(legacy) {
  const now = Date.now();
  const writes = {};
  let migrated = 0;
  for (const [runKey, value] of Object.entries(legacy)) {
    if (!value || !value.ts || now - value.ts > CACHE_TTL) continue;
    const data = Array.isArray(value.data) ? value.data.map(([k, r]) => [k, slimResult(r)]) : [];
    writes[runStorageKey(runKey)] = { data, ts: value.ts };
    testRunIndex[runKey] = { ts: value.ts, count: data.length };
    migrated++;
  }
  writes[RUN_INDEX_KEY] = testRunIndex;
  await chrome.storage.local.set(writes);
  await chrome.storage.local.remove(LEGACY_RUN_CACHE_KEY);
  logCache("MIGRATE", "прогонов разложено по ключам: " + migrated);
}

async function restoreCaches() {
  const tStart = performance.now();
  try {
    const data = await chrome.storage.local.get([LEGACY_RUN_CACHE_KEY, RUN_INDEX_KEY, PERF_KEY, "attachmentsCache", "testCaseCache", "testCaseInfoCache", "currentUser"]);
    // Статистика переживает выгрузку воркера — иначе панель показывала бы пустоту
    // всякий раз, когда её открывают после паузы в работе
    if (data[PERF_KEY]) {
      perfTotals = data[PERF_KEY].totals || {};
      perfSince = data[PERF_KEY].since || Date.now();
      if (Array.isArray(data[PERF_KEY].log)) perfLog.push(...data[PERF_KEY].log.slice(-PERF_LOG_MAX));
    }
    if (data[LEGACY_RUN_CACHE_KEY] || data[RUN_INDEX_KEY] || data.attachmentsCache || data.testCaseCache || data.testCaseInfoCache) {
      const now = Date.now();
      let expired = 0;
      // Индекс прогонов читается всегда, сами прогоны — только по обращению (getCachedRun)
      testRunIndex = data[RUN_INDEX_KEY] || {};
      const expiredRuns = [];
      for (const [runKey, meta] of Object.entries(testRunIndex)) {
        if (!meta || !meta.ts || now - meta.ts > CACHE_TTL) {
          delete testRunIndex[runKey];
          expiredRuns.push(runStorageKey(runKey));
          expired++;
        }
      }
      if (expiredRuns.length) await chrome.storage.local.remove(expiredRuns);
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
      logCache("RESTORE", "testRuns в индексе: " + Object.keys(testRunIndex).length + ", attachments: " + attachmentsCache.size + ", testCases: " + testCaseCache.size + ", testCaseInfo: " + testCaseInfoCache.size + ", expired: " + expired);
      // Разложить старый единый ключ по отдельным — единожды, после обновления расширения
      if (data[LEGACY_RUN_CACHE_KEY]) {
        await migrateLegacyRunCache(data[LEGACY_RUN_CACHE_KEY]);
      } else if (expired > 0) {
        await chrome.storage.local.set({ [RUN_INDEX_KEY]: testRunIndex });
      }
      if (expired > 0) {
        persistCache("attachmentsCache", attachmentsCache);
        persistCache("testCaseCache", testCaseCache);
        persistCache("testCaseInfoCache", testCaseInfoCache);
      }
    } else {
      logCache("RESTORE", "storage empty");
    }
    // Ради этого замера всё и затевалось: раньше здесь читались и парсились все прогоны
    logPerf("startup", performance.now() - tStart, "индекс: " + Object.keys(testRunIndex).length + " прогонов");
  } catch (e) {
    logPerf("startup", performance.now() - tStart, "ошибка: " + e.message);
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
      await refreshBadge();
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
    await refreshBadge();
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

// Единый пересчёт бейджа на иконке по состоянию из storage.
// Приоритет: доступное обновление (красный "!") > непрочитанный «Что нового» (фиолетовая точка).
async function refreshBadge() {
  const data = await chrome.storage.local.get(["versionCheck", "lastSeenVersion"]);
  const updateAvailable = !!(data.versionCheck && data.versionCheck.updateAvailable);
  const manifestVersion = chrome.runtime.getManifest().version;
  // «Непрочитано», если последняя просмотренная версия не совпадает с текущей.
  // Чистая установка не помечается: onInstalled (reason "install") сразу выставляет
  // lastSeenVersion = текущая. Пустой lastSeenVersion здесь = старый пользователь,
  // впервые получивший фичу, — ему точку показываем.
  const whatsNewUnread = data.lastSeenVersion !== manifestVersion;

  if (updateAvailable) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
  } else if (whatsNewUnread) {
    await chrome.action.setBadgeText({ text: "•" });
    await chrome.action.setBadgeBackgroundColor({ color: "#7e57c2" });
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

// При чистой установке помечаем текущую версию как просмотренную, чтобы баннер
// «Что нового» не показывался новым пользователям. При обновлении ничего не трогаем —
// баннер покажет заметки новых версий.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ lastSeenVersion: chrome.runtime.getManifest().version });
    await refreshBadge();
  }
});

// Проверка версии при старте (если кэш пустой или устарел) + восстановление badge
initReady.then(async () => {
  // Сразу пересчитываем бейдж (покажет «Что нового», даже если проверка обновлений недоступна)
  await refreshBadge();
  const cached = await getCachedVersionCheck();
  if (!cached) {
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

// Из результата прогона наружу уходят только три поля (см. handleGetTestResult), а API
// отдаёт вместе с ними все шаги теста с описаниями — это полтора мегабайта на прогон,
// которые потом заново сериализуются при каждой записи кэша. Храним только нужное.
function slimResult(r) {
  if (!r || typeof r !== "object") return { id: null, comment: null, status: null };
  return { id: r.id, comment: r.comment, status: r.status };
}

async function fetchTestRunResults(testRunKey) {
  ensureConfigured();

  const cached = await getCachedRun(testRunKey);
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
    const t0 = performance.now();
    const resp = await fetch(url, { credentials: "include" });
    checkAuthResponse(resp, "Ошибка загрузки результатов");
    // Читаем текстом, чтобы знать реальный объём: сузить ответ через ?fields= сервер не даёт
    const text = await resp.text();
    const ms = performance.now() - t0;
    const data = JSON.parse(text);
    const map = new Map(Array.isArray(data) ? data.map((r) => [r.testCaseKey, slimResult(r)]) : []);
    logPerf("fetch", ms, testRunKey + " → " + map.size + " результатов", text.length);
    logCache("FETCHED", testRunKey + " → " + map.size + " results, " + formatKb(text.length) + " за " + Math.round(ms) + " мс");
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
      // Список берётся из индекса, а не из памяти: прогоны загружаются лениво,
      // и в памяти лежат только те, к которым уже обращались в этой сессии
      const testRuns = Object.entries(testRunIndex).map(([key, meta]) => ({
        key,
        resultsCount: (meta && meta.count) || 0,
      }));
      let storageBytesUsed = 0;
      if (typeof chrome.storage.local.getBytesInUse === 'function') {
        const runKeys = Object.keys(testRunIndex).map(runStorageKey);
        storageBytesUsed = await chrome.storage.local.getBytesInUse(
          [...runKeys, RUN_INDEX_KEY, "attachmentsCache", "testCaseCache", "testCaseInfoCache"]
        );
      }
      sendResponse({
        testRuns,
        testRunCacheSize: testRuns.length,
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

  if (message.action === "getPerfStats") {
    initReady.then(async () => {
      const runKeys = Object.keys(testRunIndex);
      let storageBytes = 0;
      let runsBytes = 0;
      if (typeof chrome.storage.local.getBytesInUse === "function") {
        try {
          runsBytes = await chrome.storage.local.getBytesInUse(runKeys.map(runStorageKey));
          storageBytes = await chrome.storage.local.getBytesInUse(null);
        } catch (e) { /* Firefox не реализует getBytesInUse */ }
      }
      sendResponse({
        entries: perfLog.slice().reverse(), // свежие сверху
        summary: summarizePerf(),
        startedAt: perfStartedAt,
        // Число стартов service worker'а — сколько раз он выгружался и поднимался
        wakeups: (perfTotals.startup && perfTotals.startup.count) || 0,
        since: perfSince,
        runs: runKeys.length,
        runsInMemory: testRunCache.size,
        runsBytes,
        storageBytes,
      });
    });
    return true;
  }

  if (message.action === "resetPerfStats") {
    perfLog.length = 0;
    perfTotals = {};
    perfSince = Date.now();
    perfDirty = false;
    clearTimeout(perfPersistTimer);
    perfPersistTimer = null;
    chrome.storage.local.remove(PERF_KEY);
    sendResponse({ success: true });
    return false;
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
    initReady.then(async () => {
      const key = message.testRunKey;
      const existed = testRunCache.has(key) || !!testRunIndex[key];
      await dropRun(key);
      logCache("DELETE", key + (existed ? " removed" : " not found"));
      sendResponse({ success: existed });
    });
    return true;
  }

  if (message.action === "clearCache") {
    initReady.then(async () => {
      logCache("CLEAR", "testRuns: " + Object.keys(testRunIndex).length + ", attachments: " + attachmentsCache.size + ", testCases: " + testCaseCache.size + ", testCaseInfo: " + testCaseInfoCache.size);
      cancelPendingPersists();
      // Каждый прогон — свой ключ storage, поэтому список удаляемых строится по индексу
      const runKeys = Object.keys(testRunIndex).map(runStorageKey);
      testRunIndex = {};
      testRunCache.clear();
      attachmentsCache.clear();
      testCaseCache.clear();
      testCaseInfoCache.clear();
      cachedCurrentUser = null;
      await chrome.storage.local.remove([
        ...runKeys, RUN_INDEX_KEY, LEGACY_RUN_CACHE_KEY,
        "attachmentsCache", "testCaseCache", "testCaseInfoCache", "currentUser",
      ]);
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

  if (message.action === "setUpdateBadge" || message.action === "refreshBadge") {
    refreshBadge().then(() => sendResponse({ success: true }));
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
