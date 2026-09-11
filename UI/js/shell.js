// ==========================================================================
// Shell chrome: the ONE titlebar shared by every tab (home page and every
// project workspace alike). Every tab's actual content lives in the SAME
// document as this file (see UI/js/tabs.js -- no iframes), so this file
// only needs to wire up things that are genuinely shell-level: the
// hamburger menu, profile menu, theme toggle, and window controls.
// ==========================================================================

// ================= Menubar dropdowns (hamburger + profile) =================
document.querySelectorAll(".menubar-menu").forEach((menu) => {
    const trigger = menu.querySelector(".menubar-item, #profile-btn");
    if (!trigger) return;
    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = menu.classList.contains("open");
        document.querySelectorAll(".menubar-menu.open").forEach((m) => m.classList.remove("open"));
        if (!isOpen) menu.classList.add("open");
    });
});
document.addEventListener("click", () => {
    document.querySelectorAll(".menubar-menu.open").forEach((m) => m.classList.remove("open"));
});

// ================= Hamburger menu accordion (File / Edit / View / Help / Developer) =================
const hamburgerMenu = document.getElementById("hamburger-menu");
if (hamburgerMenu) {
    const hamburgerBtn = document.getElementById("hamburger-btn");
    const hamburgerObserver = new MutationObserver(() => {
        hamburgerBtn.setAttribute("aria-expanded", hamburgerMenu.classList.contains("open") ? "true" : "false");
        if (!hamburgerMenu.classList.contains("open")) {
            hamburgerMenu.querySelectorAll(".menubar-group.open").forEach((g) => g.classList.remove("open"));
        }
    });
    hamburgerObserver.observe(hamburgerMenu, { attributes: true, attributeFilter: ["class"] });

    hamburgerMenu.querySelectorAll(".menubar-group-header").forEach((header) => {
        header.addEventListener("click", (e) => {
            e.stopPropagation();
            const group = header.closest(".menubar-group");
            const isOpen = group.classList.contains("open");
            hamburgerMenu.querySelectorAll(".menubar-group.open").forEach((g) => g.classList.remove("open"));
            if (!isOpen) group.classList.add("open");
        });
    });

    hamburgerMenu.querySelectorAll(".menubar-dropdown-item").forEach((item) => {
        item.addEventListener("click", () => {
            hamburgerMenu.classList.remove("open");
        });
    });
}

// "New Project" / "Open Project…" both just open a fresh Home tab, same
// as the "+" tab button -- Home IS the project picker/creator, so there's
// no separate flow needed here. Wired once tabs.js has defined
// window.arcAddTab (see the end of that file).
document.getElementById("file-new-project-btn")?.addEventListener("click", () => window.arcAddTab && window.arcAddTab());
document.getElementById("file-open-project-btn")?.addEventListener("click", () => window.arcAddTab && window.arcAddTab());

// Developer > Custom Script also just opens a new Home tab for now.
document.getElementById("custom-script-btn")?.addEventListener("click", () => window.arcAddTab && window.arcAddTab("Custom Script"));

// ================= Export (stub) =================
document.getElementById("export-btn")?.addEventListener("click", () => {
    alert("Export flow goes here (CSV / study bundle export).");
});

// ================= Theme toggle =================
// Every tab's content now lives in this same document (see UI/js/tabs.js),
// so toggling a class on document.body is all that's needed -- normal CSS
// cascade takes care of applying it to every tab's markup, visible or not.
// No per-tab syncing required (unlike the earlier iframe-based version of
// this file).
function isLightTheme() {
    return document.body.classList.contains("theme-light");
}

const themeToggleBtn = document.getElementById("theme-toggle-btn");
if (themeToggleBtn) {
    const themeToggleLabel = themeToggleBtn.querySelector(".theme-toggle-label");
    themeToggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("theme-light");
        if (themeToggleLabel) {
            themeToggleLabel.textContent = isLightTheme() ? "Light Mode" : "Dark Mode";
        }
    });
}

// ================= Window controls =================
document.getElementById("minimize-btn")?.addEventListener("click", () => {
    window.pywebview?.api?.minimize();
});
document.getElementById("maximize-btn")?.addEventListener("click", () => {
    window.pywebview?.api?.maximize();
});
document.getElementById("window-close-btn")?.addEventListener("click", () => {
    window.pywebview?.api?.close();
});
