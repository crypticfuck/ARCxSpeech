// ==========================================================================
// Tab strip (shell-level)
//
// Every tab is a plain <div class="tab-page"> living inside #tab-pages,
// populated by cloning either #home-view-template or
// #project-view-template and then mounting the matching factory function
// (createHomeView / createProjectView, both plain global functions loaded
// from home.js / project.js) onto it. There are no iframes and no
// separate documents -- one page, one shared titlebar (owned by
// shell.html/shell.js), and each tab is just its own independent
// container + factory instance, switched between with a CSS
// display:none/flex toggle (see .tab-page.active in theme.css).
//
// Because every tab's content lives in the SAME document, switching tabs
// is instant (no reload, no re-fetch) and two different projects can be
// open and fully alive at once -- exactly what createProjectView's
// multi-instance refactor was built to support.
// ==========================================================================

(function () {
    const tabStrip = document.getElementById('tab-strip');
    const newTabBtn = document.getElementById('new-tab-btn');
    const tabPages = document.getElementById('tab-pages');
    const homeTemplate = document.getElementById('home-view-template');
    const projectTemplate = document.getElementById('project-view-template');

    if (!tabStrip || !newTabBtn || !tabPages || !homeTemplate || !projectTemplate) return;

    // { id, title, kind: 'home'|'project', projectId, page, instance }
    const tabs = [];
    let nextTabId = 1;
    let activeTabId = null;

    function closeIconSvg() {
        return '<svg width="9" height="9" viewBox="0 0 10 10" fill="none">'
            + '<path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />'
            + '</svg>';
    }

    const exportBtn = document.getElementById('export-btn');

    function render() {
        tabStrip.innerHTML = '';

        tabs.forEach(function (tab) {
            const isActive = tab.id === activeTabId;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tab-item' + (isActive ? ' active' : '');
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.dataset.tabId = String(tab.id);
            btn.title = tab.title;

            const label = document.createElement('span');
            label.className = 'tab-item-label';
            label.textContent = tab.title;
            btn.appendChild(label);

            // Keep at least one tab open at all times.
            if (tabs.length > 1) {
                const close = document.createElement('span');
                close.className = 'tab-item-close';
                close.title = 'Close tab';
                close.innerHTML = closeIconSvg();
                close.addEventListener('click', function (e) {
                    e.stopPropagation();
                    closeTab(tab.id);
                });
                btn.appendChild(close);
            }

            btn.addEventListener('click', function () {
                setActiveTab(tab.id);
            });

            tabStrip.appendChild(btn);
        });

        // .tab-page.active is what both the CSS (display:flex vs none)
        // and each view's own isTabActive()-style checks (see project.js)
        // key off of -- this one class toggle is the entire mechanism
        // that makes "only the visible tab responds to Escape/click
        // outside" and "only the visible tab is painted" both work.
        tabs.forEach(function (tab) {
            tab.page.classList.toggle('active', tab.id === activeTabId);
        });

        // Export only makes sense inside a project (exporting that
        // project's data) -- hide it on the Home tab.
        if (exportBtn) {
            const activeTab = tabs.find(function (t) { return t.id === activeTabId; });
            exportBtn.style.display = (activeTab && activeTab.kind === 'home') ? 'none' : '';
        }
    }

    function setActiveTab(id) {
        activeTabId = id;
        render();
    }

    function updateTabTitle(id, title) {
        const tab = tabs.find(function (t) { return t.id === id; });
        if (!tab || !title) return;
        tab.title = title;
        render();
    }

    function findTabByPage(page) {
        return tabs.find(function (t) { return t.page === page; });
    }

    function mountHome(page) {
        page.innerHTML = '';
        page.appendChild(homeTemplate.content.cloneNode(true));
        return window.createHomeView(page, {
            onOpenProject: function (projectId) {
                const tab = findTabByPage(page);
                if (tab) switchTabToProject(tab.id, projectId);
            },
        });
    }

    function mountProject(page, projectId) {
        page.innerHTML = '';
        page.appendChild(projectTemplate.content.cloneNode(true));
        return window.createProjectView(page, projectId);
    }

    // Replaces a tab's content in place (Home -> a chosen project), rather
    // than opening a new tab -- this is what clicking a project card in a
    // Home tab does. Cleanly tears down the old view first so it doesn't
    // leak listeners/timers/observers into the tab it's about to vacate.
    function switchTabToProject(tabId, projectId) {
        const tab = tabs.find(function (t) { return t.id === tabId; });
        if (!tab) return;

        if (tab.instance && typeof tab.instance.destroy === 'function') {
            tab.instance.destroy();
        }

        tab.kind = 'project';
        tab.projectId = projectId;
        tab.title = 'Project';
        tab.instance = mountProject(tab.page, projectId);
        // The real name arrives shortly via the "arc-tab-title" event
        // dispatched from inside createProjectView once it has fetched
        // the project (see the listener registered below).
        render();
    }

    // Replaces a tab's content in place (a project -> Home), the reverse
    // of switchTabToProject above -- triggered by the "arc-go-home" event
    // a project tab's own instance dispatches when its Back-to-Home button
    // is clicked (see project.js). Same cleanup-then-remount shape as
    // switchTabToProject so the outgoing project instance's listeners/
    // timers/observers don't leak into the tab it's vacating.
    function switchTabToHome(tabId) {
        const tab = tabs.find(function (t) { return t.id === tabId; });
        if (!tab) return;

        if (tab.instance && typeof tab.instance.destroy === 'function') {
            tab.instance.destroy();
        }

        tab.kind = 'home';
        tab.projectId = null;
        tab.title = 'Home';
        tab.instance = mountHome(tab.page);
        render();
    }

    function addTab(kind, projectId) {
        const id = nextTabId;
        nextTabId += 1;

        const page = document.createElement('div');
        page.className = 'tab-page';
        page.dataset.tabId = String(id);
        tabPages.appendChild(page);

        const tab = {
            id: id,
            title: kind === 'home' ? 'Home' : 'Project',
            kind: kind,
            projectId: projectId || null,
            page: page,
            instance: null,
        };
        tabs.push(tab);

        tab.instance = kind === 'home' ? mountHome(page) : mountProject(page, projectId);

        setActiveTab(id);
        return id;
    }

    // Exposed so shell.js's hamburger items ("New Project", "Open
    // Project…", Developer > "Custom Script") can open a new Home tab
    // the same way the "+" button does.
    window.arcAddTab = function () {
        return addTab('home');
    };

    function closeTab(id) {
        const idx = tabs.findIndex(function (t) { return t.id === id; });
        if (idx === -1 || tabs.length === 1) return;

        const tab = tabs[idx];
        if (tab.instance && typeof tab.instance.destroy === 'function') {
            tab.instance.destroy();
        }
        tabs.splice(idx, 1);
        tab.page.remove();

        if (activeTabId === id) {
            const fallback = tabs[idx] || tabs[idx - 1];
            activeTabId = fallback.id;
        }

        render();
    }

    newTabBtn.addEventListener('click', function () {
        addTab('home');
    });

    // A project tab's own instance dispatches this bubbling event (see the
    // title-setting code near the bottom of createProjectView in
    // project.js) once it knows the project's name -- update just that
    // tab's label, found via which .tab-page the event bubbled through.
    tabPages.addEventListener('arc-tab-title', function (e) {
        const page = e.target.closest ? e.target.closest('.tab-page') : null;
        if (!page) return;
        const tab = findTabByPage(page);
        if (!tab) return;
        updateTabTitle(tab.id, e.detail && e.detail.title);
    });

    // A project tab's own instance dispatches this bubbling event when its
    // Back-to-Home button is clicked (see project.js) -- same event-
    // delegation pattern as "arc-tab-title" above, just triggering a full
    // Home -> project style swap instead of a title update.
    tabPages.addEventListener('arc-go-home', function (e) {
        const page = e.target.closest ? e.target.closest('.tab-page') : null;
        if (!page) return;
        const tab = findTabByPage(page);
        if (!tab) return;
        switchTabToHome(tab.id);
    });

    // The very first tab: Home, same starting point as launching the app
    // fresh.
    addTab('home');
})();
