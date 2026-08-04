// perf.js — панель производительности, открывается из debug-панели popup'а.
// Отдельным окном, а не внутри popup'а: popup закрывается при потере фокуса,
// а за цифрами нужно наблюдать, продолжая работать со страницей.
"use strict";

(function () {
  const AUTO_REFRESH_MS = 2000;

  // Человеческие названия для op из logPerf()
  const OP_LABELS = {
    startup: "Старт service worker'а",
    persist: "Запись прогонов на диск",
    load: "Чтение прогона с диска",
    fetch: "Запрос прогона к Jira",
  };

  // Ориентиры: выше — операция считается медленной и подсвечивается
  const OP_SLOW_MS = {
    startup: 100,
    persist: 200,
    load: 100,
    fetch: 3000,
  };

  let autoTimer = null;
  // Последний ответ фона — чтобы «Скопировать» отдавало ровно то, что на экране
  let lastData = null;
  const REPORT_LOG_LIMIT = 100;

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        resolve({ error: e.message });
      }
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "—";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " МБ";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " КБ";
    return bytes + " Б";
  }

  function formatMs(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + " с";
    return ms + " мс";
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
  }

  function formatAge(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + " с";
    const min = Math.floor(sec / 60);
    if (min < 60) return min + " мин";
    return Math.floor(min / 60) + " ч " + (min % 60) + " мин";
  }

  function card(label, value, hint) {
    const el = document.createElement("div");
    el.className = "perf-card";

    const v = document.createElement("div");
    v.className = "perf-card-value";
    v.textContent = value;
    el.appendChild(v);

    const l = document.createElement("div");
    l.className = "perf-card-label";
    l.textContent = label;
    el.appendChild(l);

    if (hint) {
      const h = document.createElement("div");
      h.className = "perf-card-hint";
      h.textContent = hint;
      el.appendChild(h);
    }
    return el;
  }

  function renderStorage(data) {
    const cards = document.getElementById("storageCards");
    cards.textContent = "";
    cards.appendChild(card("Прогонов в кэше", String(data.runs), data.runsInMemory + " подняты в память"));
    cards.appendChild(card("Объём прогонов", formatBytes(data.runsBytes)));
    cards.appendChild(card("Всё хранилище", formatBytes(data.storageBytes)));

    // Стартов бывает много: воркер выгружается после ~30 с простоя и поднимается заново
    const startup = data.summary.find((s) => s.op === "startup");
    cards.appendChild(card(
      "Старт service worker'а",
      startup ? formatMs(startup.avg) : "—",
      startup ? "в среднем, " + data.wakeups + " запусков" : "не замерен"
    ));
  }

  function renderSummary(summary) {
    const body = document.getElementById("summaryBody");
    const table = document.getElementById("summaryTable");
    const empty = document.getElementById("summaryEmpty");
    body.textContent = "";

    if (!summary.length) {
      table.hidden = true;
      empty.hidden = false;
      return;
    }
    table.hidden = false;
    empty.hidden = true;

    for (const s of summary) {
      const tr = document.createElement("tr");

      const name = document.createElement("td");
      name.textContent = OP_LABELS[s.op] || s.op;
      tr.appendChild(name);

      const count = document.createElement("td");
      count.className = "perf-num";
      count.textContent = s.count;
      tr.appendChild(count);

      const avg = document.createElement("td");
      avg.className = "perf-num";
      avg.textContent = formatMs(s.avg);
      tr.appendChild(avg);

      const max = document.createElement("td");
      max.className = "perf-num";
      max.textContent = formatMs(s.max);
      if (OP_SLOW_MS[s.op] && s.max > OP_SLOW_MS[s.op]) max.classList.add("perf-slow");
      tr.appendChild(max);

      const total = document.createElement("td");
      total.className = "perf-num";
      total.textContent = formatMs(Math.round(s.total));
      tr.appendChild(total);

      body.appendChild(tr);
    }
  }

  function renderEntries(entries) {
    const list = document.getElementById("entriesList");
    const count = document.getElementById("entriesCount");
    list.textContent = "";
    count.textContent = entries.length ? entries.length + " записей" : "";

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "perf-empty";
      empty.textContent = "Здесь появятся операции по мере работы с таблицей.";
      list.appendChild(empty);
      return;
    }

    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "perf-row";

      const time = document.createElement("span");
      time.className = "perf-row-time";
      time.textContent = formatTime(e.ts);
      row.appendChild(time);

      const op = document.createElement("span");
      op.className = "perf-row-op perf-op-" + e.op;
      op.textContent = OP_LABELS[e.op] || e.op;
      row.appendChild(op);

      const ms = document.createElement("span");
      ms.className = "perf-row-ms";
      ms.textContent = formatMs(e.ms);
      if (OP_SLOW_MS[e.op] && e.ms > OP_SLOW_MS[e.op]) ms.classList.add("perf-slow");
      row.appendChild(ms);

      if (e.bytes) {
        const bytes = document.createElement("span");
        bytes.className = "perf-row-bytes";
        bytes.textContent = formatBytes(e.bytes);
        row.appendChild(bytes);
      }

      const details = document.createElement("span");
      details.className = "perf-row-details";
      details.textContent = e.details || "";
      details.title = e.details || "";
      row.appendChild(details);

      list.appendChild(row);
    }
  }

  // Текстовый отчёт: то же, что на экране, но пригодное для вставки в тикет или переписку
  function buildReport(data) {
    const manifest = chrome.runtime.getManifest();
    const lines = [];

    lines.push(manifest.name + " " + manifest.version + " — производительность");
    lines.push("Снято: " + new Date().toLocaleString("ru-RU"));
    lines.push("Браузер: " + navigator.userAgent);
    lines.push("Статистика за: " + formatAge(Date.now() - data.since) +
      " (запусков service worker'а: " + data.wakeups + ")");
    lines.push("Текущая сессия воркера: " + formatAge(Date.now() - data.startedAt));
    lines.push("");

    lines.push("ХРАНИЛИЩЕ");
    lines.push("  Прогонов в кэше:   " + data.runs + " (в памяти: " + data.runsInMemory + ")");
    lines.push("  Объём прогонов:    " + formatBytes(data.runsBytes));
    lines.push("  Всё хранилище:     " + formatBytes(data.storageBytes));
    lines.push("");

    lines.push("ОПЕРАЦИИ");
    if (!data.summary.length) {
      lines.push("  (ничего не измерено)");
    } else {
      lines.push("  | Операция | Раз | Среднее | Худшее | Всего |");
      lines.push("  |---|---:|---:|---:|---:|");
      for (const s of data.summary) {
        lines.push("  | " + (OP_LABELS[s.op] || s.op) +
          " | " + s.count +
          " | " + formatMs(s.avg) +
          " | " + formatMs(s.max) +
          " | " + formatMs(Math.round(s.total)) + " |");
      }
    }
    lines.push("");

    const entries = data.entries.slice(0, REPORT_LOG_LIMIT);
    lines.push("ПОСЛЕДНИЕ ОПЕРАЦИИ" +
      (data.entries.length > entries.length ? " (первые " + REPORT_LOG_LIMIT + " из " + data.entries.length + ")" : ""));
    if (!entries.length) {
      lines.push("  (пусто)");
    } else {
      for (const e of entries) {
        lines.push("  " + formatTime(e.ts) +
          "  " + (OP_LABELS[e.op] || e.op).padEnd(24) +
          "  " + formatMs(e.ms).padStart(8) +
          "  " + (e.bytes ? formatBytes(e.bytes).padStart(8) : "        ") +
          "  " + (e.details || ""));
      }
    }

    return lines.join("\n");
  }

  async function copyReport() {
    const btn = document.getElementById("copyBtn");
    if (!lastData) {
      btn.textContent = "Нечего копировать";
      setTimeout(() => { btn.textContent = "Скопировать"; }, 1500);
      return;
    }
    const text = buildReport(lastData);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Скопировано ✓";
    } catch (e) {
      // clipboard может быть недоступен без фокуса — запасной путь через скрытое поле
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      btn.textContent = ok ? "Скопировано ✓" : "Не удалось";
    }
    setTimeout(() => { btn.textContent = "Скопировать"; }, 1500);
  }

  async function refresh() {
    const data = await sendMessage({ action: "getPerfStats" });
    const info = document.getElementById("sessionInfo");

    if (!data || data.error) {
      info.textContent = "нет связи с service worker'ом: " + ((data && data.error) || "неизвестно");
      return;
    }
    lastData = data;

    // Статистика переживает выгрузку воркера, поэтому показываем период её накопления,
    // а рядом — возраст текущей сессии, чтобы было видно, давно ли он поднялся
    info.textContent = "статистика за " + formatAge(Date.now() - data.since) +
      " · текущая сессия воркера: " + formatAge(Date.now() - data.startedAt);

    renderStorage(data);
    renderSummary(data.summary);
    renderEntries(data.entries);
  }

  function setAuto(on, remember) {
    clearInterval(autoTimer);
    autoTimer = on ? setInterval(refresh, AUTO_REFRESH_MS) : null;
    document.getElementById("autoWarn").hidden = !on;
    if (remember) chrome.storage.local.set({ perfAutoRefresh: on });
  }

  document.getElementById("refreshBtn").addEventListener("click", refresh);
  document.getElementById("copyBtn").addEventListener("click", copyReport);

  document.getElementById("resetBtn").addEventListener("click", async () => {
    await sendMessage({ action: "resetPerfStats" });
    refresh();
  });

  document.getElementById("autoRefresh").addEventListener("change", (e) => {
    setAuto(e.target.checked, true);
  });

  // Автообновление выключено по умолчанию: опрос раз в 2 секунды не давал бы
  // service worker'у уснуть, а его засыпание — часть того, что мы наблюдаем
  chrome.storage.local.get("perfAutoRefresh", (data) => {
    const on = !!data.perfAutoRefresh;
    document.getElementById("autoRefresh").checked = on;
    setAuto(on, false); // восстановление состояния — не повод писать его обратно
  });

  refresh();
})();
