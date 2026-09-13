// ==========================================================================
// Home view factory -- the project picker/creator, same factory pattern as
// createProjectView in project.js. Multiple instances can exist at once
// (e.g. two "Home" tabs open simultaneously), each fully independent.
//
// One document-level listener per instance (arc-projects-changed, see
// below) keeps every open Home tab's project list in sync with the
// others -- e.g. creating a project in one Home tab updates the grid in
// every other open Home tab too, not just the one it was created in.
// destroy() removes it, same reason project.js's destroy() removes its
// own document-level listeners. No timers, observers, or pinboard-style
// IIFEs here otherwise.
// ==========================================================================

function createHomeView(container, options) {
    const opts = options || {};

    // Populated by loadProjects() below; read by the new-project submit
    // handler for an instant client-side duplicate-name check (the
    // authoritative check still happens server-side in project_store.py,
    // this just avoids a round trip for the common case).
    let currentProjects = [];

    // ================= Backend wiring =================
    // Same pattern as project.js's apiFetch -- same-origin relative paths,
    // no base URL/CORS setup needed.
    async function apiFetch(url, fetchOptions = {}) {
        const reqOpts = { ...fetchOptions };
        if (reqOpts.body && typeof reqOpts.body === "string") {
            reqOpts.headers = { "Content-Type": "application/json", ...(reqOpts.headers || {}) };
        }
        const res = await fetch(url, reqOpts);
        if (!res.ok) {
            let detail = res.statusText;
            try {
                const data = await res.json();
                const d = data && data.detail;
                detail = (d && typeof d === "object" ? d.detail : d) || detail;
            } catch (_) { /* response body wasn't JSON */ }
            const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
            err.status = res.status;
            throw err;
        }
        if (res.status === 204) return null;
        return res.json();
    }

    const projectsApi = {
        list: () => apiFetch("/api/projects"),
        create: (payload) => apiFetch("/api/projects", { method: "POST", body: JSON.stringify(payload) }),
        del: (projectId) => apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
    };

    // Same "only act if this instance's tab is the one currently on
    // screen" guard project.js's isTabActive() uses -- tabs.js toggles
    // this class on `container` (its `page` element) when switching
    // tabs, so with two Home tabs open, Escape/outside-click handling
    // below only affects whichever one the user is actually looking at.
    function isTabActive() {
        return container.classList.contains("active");
    }

    // Shared #toast element -- intentionally document-level rather than
    // container-scoped, same reasoning as project.js's own toastEl (see
    // its comment): it's one app-wide surface, not a per-tab one.
    const toastEl = document.getElementById("toast");
    let toastTimer = null;
    function showToast(message) {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.classList.remove("visible");
        }, 2200);
    }

    // Tracks every document-level listener this instance adds, so
    // destroy() can remove exactly them (same addDocListener pattern as
    // project.js).
    const docListeners = [];
    function addDocListener(type, handler, options) {
        document.addEventListener(type, handler, options);
        docListeners.push({ type, handler, options });
    }

    function timeAgo(isoString) {
        if (!isoString) return "";
        const then = new Date(isoString).getTime();
        const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
        if (diffSeconds < 60) return "just now";
        const diffMinutes = Math.floor(diffSeconds / 60);
        if (diffMinutes < 60) return `edited ${diffMinutes}m ago`;
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return `edited ${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays === 1) return "edited yesterday";
        if (diffDays < 7) return `edited ${diffDays} days ago`;
        const diffWeeks = Math.floor(diffDays / 7);
        if (diffWeeks < 5) return `edited ${diffWeeks} week${diffWeeks > 1 ? "s" : ""} ago`;
        return `edited on ${new Date(isoString).toLocaleDateString()}`;
    }

    // Opening a project used to navigate this whole page
    // (window.location.href = "index.html?project=..."), back when this
    // view ran in its own document/iframe. Now that it's one of several
    // views sharing a single page, "opening" a project means swapping
    // THIS tab's content for the project view -- which only the tab
    // manager (tabs.js) can do, since it owns the tab strip and the other
    // template. So this just calls back into whatever tabs.js supplied.
    function openProject(projectId) {
        if (typeof opts.onOpenProject === "function") {
            opts.onOpenProject(projectId);
        }
    }

    function renderProjectCard(project) {
        // A plain div (not a <button>) because it now needs to contain
        // its own ellipsis button -- nested <button>s are invalid HTML
        // (the parser closes the outer one when it hits the inner one),
        // so role="button" + tabindex + a keydown handler stand in for
        // the native button semantics the card relied on before.
        const card = document.createElement("div");
        card.className = "project-card";
        card.dataset.project = project.id;
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");

        const subjectCount = typeof project.subject_count === "number" ? project.subject_count : null;
        const metaParts = [];
        if (subjectCount !== null) metaParts.push(`${subjectCount} subject${subjectCount === 1 ? "" : "s"}`);
        metaParts.push(timeAgo(project.lastEditedAt));

        card.innerHTML = `
            <div class="project-card-top">
                <div class="project-card-top-right">
                    <button type="button" class="row-ellipsis-btn" title="Delete Project" aria-label="Delete Project">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10zM10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                </div>
            </div>
            <div>
                <div class="project-name"></div>
                <div class="project-meta"></div>
            </div>
        `;
        card.querySelector(".project-name").textContent = project.name;
        card.querySelector(".project-meta").textContent = metaParts.filter(Boolean).join(" \u00b7 ");

        card.addEventListener("click", () => openProject(project.id));
        card.addEventListener("keydown", (e) => {
            // Space/Enter activate it the way a real <button> would.
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                e.preventDefault();
                openProject(project.id);
            }
        });

        card.querySelector(".row-ellipsis-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            openConfirmDelete(
                "Delete Project",
                `This will permanently delete "${project.name}" and all of its data - every subject and recording inside it. This can't be undone.`,
                () => deleteProject(project)
            );
        });

        return card;
    }

    // ================= Delete-confirmation modal =================
    const confirmDeleteOverlay = container.querySelector("#confirmDeleteOverlay");
    const confirmDeleteTitleEl = container.querySelector("#confirmDeleteTitle");
    const confirmDeleteMessageEl = container.querySelector("#confirmDeleteMessage");
    const confirmDeleteCancelBtn = container.querySelector("#confirmDeleteCancel");
    const confirmDeleteConfirmBtn = container.querySelector("#confirmDeleteConfirm");
    let pendingDeleteAction = null;

    function openConfirmDelete(title, message, onConfirm) {
        if (!confirmDeleteOverlay) return;
        confirmDeleteTitleEl.textContent = title;
        confirmDeleteMessageEl.textContent = message;
        pendingDeleteAction = onConfirm;
        confirmDeleteOverlay.classList.add("visible");
    }

    function closeConfirmDelete() {
        if (!confirmDeleteOverlay) return;
        confirmDeleteOverlay.classList.remove("visible");
        pendingDeleteAction = null;
    }

    confirmDeleteCancelBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeConfirmDelete();
    });
    confirmDeleteConfirmBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = pendingDeleteAction;
        closeConfirmDelete();
        if (action) action();
    });

    addDocListener("keydown", (e) => {
        if (!isTabActive()) return;
        if (e.key === "Escape" && confirmDeleteOverlay && confirmDeleteOverlay.classList.contains("visible")) {
            closeConfirmDelete();
        }
    });

    async function deleteProject(project) {
        try {
            await projectsApi.del(project.id);
        } catch (e) {
            console.error("Failed to delete project:", e);
            showToast(e.message || "Couldn't delete the project.");
            return;
        }
        showToast(`Deleted "${project.name}".`);
        // Other open Home tabs need to drop this project too, same
        // broadcast create() already uses -- loadProjects() below
        // handles it for this instance.
        document.dispatchEvent(new CustomEvent("arc-projects-changed"));
        // Separate, more specific signal for any open Project tab showing
        // THIS project (possibly opened from a different Home tab) --
        // arc-projects-changed alone doesn't say which project changed,
        // and project.js only cares when it's the one it's displaying.
        // See its arc-project-deleted listener next to the Back-to-Home
        // button.
        document.dispatchEvent(new CustomEvent("arc-project-deleted", {
            detail: { projectId: project.id },
        }));
    }

    async function loadProjects() {
        const grid = container.querySelector("#projects-grid");
        const newProjectCard = container.querySelector("#new-project-card");
        const countBadge = container.querySelector("#project-count");

        let projects = [];
        try {
            projects = await projectsApi.list();
        } catch (e) {
            console.error("Failed to load projects:", e);
            return;
        }

        // Subject counts aren't included on the project list itself (they're
        // computed from each project's own subjects.json), so fetch each
        // project's count alongside the list. Best effort -- a project
        // whose count fails to load just shows no subject count rather
        // than blocking the whole grid.
        await Promise.all(projects.map(async (project) => {
            try {
                const subjects = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/subjects`);
                project.subject_count = Array.isArray(subjects) ? subjects.length : 0;
            } catch (_) {
                project.subject_count = null;
            }
        }));

        // Most recently edited first, same ordering the mockup implied.
        projects.sort((a, b) => new Date(b.lastEditedAt || 0) - new Date(a.lastEditedAt || 0));

        grid.querySelectorAll(".project-card:not(.project-card--new)").forEach((el) => el.remove());
        // Insert after the "+ New Project" tile (not before) so that tile
        // stays pinned at the top-left of the grid regardless of how many
        // projects get added -- previously each card was inserted before
        // it, pushing it further down/right as the list grew.
        let insertAfter = newProjectCard;
        projects.forEach((project) => {
            const card = renderProjectCard(project);
            insertAfter.after(card);
            insertAfter = card;
        });

        currentProjects = projects;
        countBadge.textContent = projects.length;
    }

    // ================= New-project prompt =================
    // In-app replacement for the old window.prompt()/window.alert() pair.
    // Deliberately lighter than the subject-modal-overlay pattern used
    // elsewhere -- no dimmed/blurred backdrop, no click-trap -- so it
    // keeps the quick, drop-down-from-the-top-and-get-out-of-the-way feel
    // window.prompt() had, just styled to match the app (see .top-prompt
    // in theme.css, next to .toast).
    const newProjectPrompt = container.querySelector("#newProjectPrompt");
    const newProjectForm = container.querySelector("#newProjectForm");
    const newProjectNameInput = container.querySelector("#newProjectNameInput");
    const newProjectCancelBtn = container.querySelector("#newProjectCancel");

    function openNewProjectModal() {
        if (!newProjectPrompt) return;
        newProjectNameInput.value = "";
        newProjectNameInput.classList.remove("input-error");
        newProjectPrompt.classList.add("visible");
        setTimeout(() => newProjectNameInput.focus(), 0);
    }

    function closeNewProjectModal() {
        if (!newProjectPrompt) return;
        newProjectPrompt.classList.remove("visible");
    }

    // No backdrop to catch the dismissing click, so the prompt closes
    // itself on any click outside its own panel -- capture phase, and
    // checking containment directly (same as project.js's row-flyout),
    // since capture fires before the target's own handlers regardless of
    // any stopPropagation() they call.
    addDocListener("click", (e) => {
        if (!isTabActive()) return;
        if (!newProjectPrompt || !newProjectPrompt.classList.contains("visible")) return;
        if (newProjectPrompt.contains(e.target)) return;
        closeNewProjectModal();
    }, true);

    newProjectNameInput?.addEventListener("input", () => {
        newProjectNameInput.classList.remove("input-error");
    });

    newProjectCancelBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeNewProjectModal();
    });

    addDocListener("keydown", (e) => {
        if (!isTabActive()) return;
        if (e.key === "Escape" && newProjectPrompt && newProjectPrompt.classList.contains("visible")) {
            closeNewProjectModal();
        }
    });

    newProjectForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = newProjectNameInput.value.trim();
        if (!name) return;

        const isDuplicate = currentProjects.some(
            (p) => p.name.trim().toLowerCase() === name.toLowerCase()
        );
        if (isDuplicate) {
            newProjectNameInput.classList.add("input-error");
            showToast(`A project named "${name}" already exists.`);
            newProjectNameInput.focus();
            return;
        }

        // The modal stays open (rather than closing immediately) until
        // the server call actually succeeds. That's what lets the catch
        // below give a name-collision failure the same red-input
        // treatment as the instant client-side check above -- this
        // covers cases the client can't cheaply check for itself, e.g.
        // two different names ("Test/A" vs "Test:A") that sanitize to
        // the same folder on disk (see project_store.py) and so still
        // get rejected server-side even though they're not literal
        // duplicates.
        try {
            await projectsApi.create({ name });
            closeNewProjectModal();
            // Every Home tab's own instance has its own `projects` state
            // (loaded independently, no shared store between them), so
            // creating a project here doesn't touch what any other open
            // Home tab is showing on its own. Broadcasting this document-
            // level event, listened for by every instance below (this
            // one included), is what makes all of them re-fetch and stay
            // in sync -- same bubble-to-document pattern project.js uses
            // for its own cross-instance signal (arc-tab-title).
            document.dispatchEvent(new CustomEvent("arc-projects-changed"));
        } catch (err) {
            console.error("Failed to create project:", err);
            if (err.status === 409) {
                newProjectNameInput.classList.add("input-error");
                newProjectNameInput.focus();
            } else {
                closeNewProjectModal();
            }
            showToast(err.message || "Couldn't create the project. Please try again.");
        }
    });

    function createProject() {
        openNewProjectModal();
    }

    // Refreshes this instance's own list whenever ANY Home tab (including
    // this one) creates a project. Registered once per instance and
    // removed in destroy() below -- see the comment on
    // arc-projects-changed above for why this needs to be document-level
    // rather than scoped to `container`.
    function handleProjectsChanged() {
        loadProjects();
    }
    document.addEventListener("arc-projects-changed", handleProjectsChanged);

    // Exposed so shell.js's hamburger "New Project"/"Open Project…" items
    // can trigger the same flow as clicking the card, when this happens to
    // be the active tab (see arcAddTab/arcRunActiveTabAction in tabs.js).
    container._createProject = createProject;

    const newProjectCardEl = container.querySelector("#new-project-card");
    if (newProjectCardEl) {
        newProjectCardEl.addEventListener("click", createProject);
    }
    const newProjectBtn = container.querySelector("#new-project-btn");
    if (newProjectBtn) {
        newProjectBtn.addEventListener("click", createProject);
    }

    loadProjects();

    return {
        destroy() {
            // The document-level arc-projects-changed listener above,
            // which otherwise stays attached to `document` forever, even
            // after this tab and its container are gone -- same leak
            // project.js's destroy() guards against for its own
            // document-level listeners.
            document.removeEventListener("arc-projects-changed", handleProjectsChanged);
            // The confirm-delete modal's own Escape-key listener added
            // via addDocListener above, same reason.
            docListeners.forEach(({ type, handler, options }) => {
                document.removeEventListener(type, handler, options);
            });
        },
    };
}
