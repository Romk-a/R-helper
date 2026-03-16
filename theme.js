// theme.js — Theme switcher for popup and options pages
"use strict";

(function () {
  const THEMES = [
    {
      id: "auto",
      label: "Авто",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"/><path d="M12 2a10 10 0 0 0 0 20" fill="currentColor" opacity="0.15"/></svg>',
    },
    {
      id: "light",
      label: "Светлая",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42m12.72-12.72l1.42-1.42"/></svg>',
    },
    {
      id: "dark",
      label: "Тёмная",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor" opacity="0.15"/></svg>',
    },
  ];

  function applyTheme(theme) {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  const btn = document.getElementById("themeBtn");
  if (!btn) return;

  // Wrap button in a relative container for dropdown positioning
  const wrap = document.createElement("div");
  wrap.className = "rhelper-theme-wrap";
  btn.parentNode.insertBefore(wrap, btn);
  wrap.appendChild(btn);

  let dropdown = null;
  let currentTheme = "auto";

  function updateButton() {
    const t = THEMES.find((t) => t.id === currentTheme) || THEMES[0];
    btn.innerHTML = t.icon;
  }

  function closeDropdown() {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
  }

  function openDropdown() {
    if (dropdown) { closeDropdown(); return; }

    dropdown = document.createElement("div");
    dropdown.className = "rhelper-theme-dropdown";

    THEMES.forEach((t) => {
      const item = document.createElement("button");
      item.className = "rhelper-theme-dropdown-item";
      if (t.id === currentTheme) item.classList.add("rhelper-theme-dropdown-active");
      item.innerHTML = t.icon + "<span>" + t.label + "</span>";
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        currentTheme = t.id;
        applyTheme(currentTheme);
        updateButton();
        chrome.storage.local.set({ theme: currentTheme });
        closeDropdown();
      });
      dropdown.appendChild(item);
    });

    wrap.appendChild(dropdown);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDropdown();
  });

  document.addEventListener("click", () => closeDropdown());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDropdown();
  });

  chrome.storage.local.get("theme", (data) => {
    currentTheme = data.theme || "auto";
    if (!THEMES.some((t) => t.id === currentTheme)) currentTheme = "auto";
    applyTheme(currentTheme);
    updateButton();
  });
})();
