// ==========================================================================
// createProjectView(container, projectId)
//
// Multi-instance refactor (see project-js-refactor-prompt.md). Progress:
//
// Stage 1 (done): mechanical wrap. The whole previous top-level file body
//   became the body of this factory function, unchanged line-for-line.
// Stage 2 (done): confirmed via static scope analysis that no top-level
//   state variable was an implicit global (undeclared bare assignment) or
//   accidentally attached to `window` -- everything just became properly
//   closure-scoped by virtue of moving inside this function in Stage 1.
// Stage 3 (done): every document.getElementById/querySelector/
//   querySelectorAll call in the whole file -- including inside both
//   pinboard IIFEs -- is now container.querySelector(...)-scoped, EXCEPT
//   `#toast`, which is intentionally left as document.getElementById --
//   see the comment at its declaration for why (shared app-wide, not
//   per-tab). `#app-sidebar` and everything inside it IS container-scoped
//   (per-tab), per the reviewed decision to override the original
//   shared-by-default proposal.
// Stage 4 (done, all 14): all 14 document-level Escape/click-outside
//   listeners -- the 12 top-level ones and the 2 inside the pinboard
//   widgets IIFE alike -- now bail out via a shared isTabActive() check
//   before doing anything else (see that helper below).
// Stage 5 (done): the two pinboard IIFEs are kept as two nested closures
//   (not merged) rather than top-level IIFEs. The three former
//   window.closeAllTypeDropdowns / window.getPinboardAccessibleBounds /
//   window.getPinboardScale bridge globals between them (and, for the
//   first one, the pre-IIFE recording-select dropdown code) are now
//   plain shared closure variables (see "Pinboard cross-closure bridges"
//   below). Both IIFEs' own internal DOM lookups are container-scoped
//   (see Stage 3 above, which now covers them).
// Stage 6 (done): `projectId` (the factory's own parameter) now drives
//   `API_BASE` and everything built from it, instead of a page-global
//   PROJECT_ID constant read once from window.location.search -- see
//   the API layer just below. The `!projectId` redirect-home guard moved
//   with it, and the title/postMessage code near the bottom of the file
//   now reads `projectId` too.
// destroy() (done, see it near the end of the file): removes all 14
//   document-level listeners (tracked via the addDocListener helper
//   below, instead of calling document.addEventListener directly),
//   clears the toast/done-overlay/countdown timeouts and the recording
//   rAF loop, and calls each pinboard IIFE's own cleanup bridge
//   (pinboardWidgetsCleanupFn / pinboardCameraCleanupFn) to disconnect
//   ResizeObservers and cancel the camera-reset animation.
//   createProjectView now returns { destroy } so a future tab manager
//   can call it when a tab closes. One known, documented gap: the
//   per-widget audio-waveform playback rAF loops aren't tracked (see
//   destroy()'s own comment for why and how big a gap it actually is).
//
// Also fixed: the other 7 window.* globals from the Step 0 inventory
// (closeAppSidebar, renderSidebarContent, clearPinboardWidgets,
// refreshAllWidgetValues, addGraphWidget, closeRecordingSelectDropdown,
// GRAPH_TASK_TYPES). These were never meant to leave this file's own
// scope -- each was a per-tab pinboard/sidebar internal bridged via
// `window.foo` between two sibling closures within ONE tab's instance.
// But `window` is shared by every tab, so with two project tabs open at
// once, whichever tab mounted last simply overwrote the others'
// versions -- e.g. clicking "add graph" in one tab's sidebar could add
// the widget to a completely different tab's pinboard. closeAppSidebar
// and renderSidebarContent didn't need a bridge at all (their call
// sites were already in the same top-level closure and could call them
// directly); the rest now go through the same kind of per-instance
// closure variable as closeAllTypeDropdownsFn/getPinboardAccessibleBoundsFn/
// getPinboardScaleFn above (see addGraphWidgetFn, clearPinboardWidgetsFn,
// refreshAllWidgetValuesFn, closeRecordingSelectDropdownFn, graphTaskTypes
// near the top of this factory).
//
// Shell wiring (done): the bootstrap self-test call that used to sit at
// the bottom of this file is gone -- UI/js/tabs.js now calls
// createProjectView(container, projectId) once per project tab, with a
// container cloned from shell.html's <template id="project-view-template">.
// The title-setting code near the bottom no longer touches
// `document.title`/`window.parent.postMessage` (there's no separate
// document/iframe per tab anymore) -- it dispatches a bubbling
// "arc-tab-title" CustomEvent on `container` instead, which tabs.js
// listens for to update just this tab's own label.
// ==========================================================================
function createProjectView(container, projectId) {
// ================= Tab-active check (Stage 4) =================
// The 14 document-level Escape/click-outside listeners below fire for
// every instance regardless of which tab is focused, since `document` is
// shared across all of them. Checking only "is my own overlay visible"
// isn't enough once two tabs can each have an overlay in that state --
// each handler also needs to bail out immediately if its own tab isn't
// the currently active one. `container` is expected to get an "active"
// class toggled onto it by the tab switcher (see tabs.js's
// `.tab-page.active` toggle) once this factory is wired into the real
// multi-tab shell; until then, see the bootstrap call at the bottom of
// this file for how single-instance testing keeps this true.
function isTabActive() {
    return container.classList.contains("active");
}

// ---- Pinboard cross-closure bridges ----
// The two pinboard IIFEs further down (widgets, and pan/zoom camera) are
// sibling closures, not nested inside each other, so they can't call each
// other's functions directly by name. These three shared closure
// variables replace the window.closeAllTypeDropdowns /
// window.getPinboardAccessibleBounds / window.getPinboardScale globals
// that used to be the bridge between them (and, for
// closeAllTypeDropdownsFn, between the widgets IIFE and the
// recording-select dropdown code above it). Each is assigned once by the
// IIFE that owns the real implementation, and called from wherever the
// old window.* read used to be.
let closeAllTypeDropdownsFn = null;
let getPinboardAccessibleBoundsFn = null;
let getPinboardScaleFn = null;
// Same bridge pattern, for the same reason -- these six were missed when
// the three above were fixed, and each is a `window.foo` global that
// every open project tab overwrites on mount. With two project tabs
// open at once, whichever tab mounted LAST wins the global, so e.g.
// clicking "add graph" in tab A's sidebar could call tab B's
// addGraphWidget and add the widget to tab B's pinboard instead --
// tabs sharing one `window` made them not actually independent for
// anything wired this way. Routing them through per-instance closure
// variables instead (like the three above) keeps each tab's bridges
// scoped to that tab.
let addGraphWidgetFn = null;
let clearPinboardWidgetsFn = null;
let refreshAllWidgetValuesFn = null;
let closeRecordingSelectDropdownFn = null;
// Set by the subject-picker search IIFE further down; lets
// renderSubjectPicker() re-apply the current search query after a
// rebuild instead of silently dropping the active filter.
let refreshSubjectPickerFilterFn = null;
let graphTaskTypes = {};
// Cleanup hooks for destroy() -- each pinboard IIFE assigns its own
// cleanup function here (disconnecting ResizeObservers, cancelling its
// own rAF loops) since destroy() lives outside both IIFEs and can't
// reach their internals any other way, same reason the three bridges
// above exist.
let pinboardWidgetsCleanupFn = null;
let pinboardCameraCleanupFn = null;

// ---- destroy() bookkeeping: document-level listeners ----
// Every document.addEventListener call in this file (the 14 Escape/
// click-outside handlers, top-level and inside the widgets IIFE alike)
// goes through this helper instead of calling document.addEventListener
// directly, so destroy() can remove every one of them by iterating this
// list -- otherwise each tab ever opened leaves its listeners attached
// to `document` forever, even after the tab closes (this is exactly the
// leak the task doc's "#2 subtlety" warned about).
const docListeners = [];
function addDocListener(type, handler, options) {
    document.addEventListener(type, handler, options);
    docListeners.push({ type, handler, options });
}

// ================= Backend API layer =================
// Same-origin relative paths -- the FastAPI backend (api/routes.py)
// serves this UI itself via StaticFiles, so no base URL/CORS setup is
// needed here.

// Every subject/recording endpoint now lives under one project's
// namespace (/api/projects/{project_id}/...) -- built from the
// `projectId` argument passed into this factory (see
// createProjectView(container, projectId) above), not a page-global
// constant read from the URL, so each instance talks to its own project
// regardless of what's in the URL or what other instances exist on the
// page. In the real shell, tabs.js only ever calls this with a real
// project id (see switchTabToProject in tabs.js), so this should be
// unreachable in practice. If it's ever missing anyway, there's no
// "home.html" to redirect to anymore -- this whole page can host many
// tabs at once, so navigating the entire window would destroy all of
// them, not just this one broken instance. Log it and let the (harmless)
// resulting 404s on API calls surface the problem instead.
if (!projectId) {
    console.error("createProjectView called without a projectId -- this tab's API calls will fail.");
}
const API_BASE = `/api/projects/${encodeURIComponent(projectId)}`;

async function apiFetch(url, options = {}) {
    const opts = { ...options };
    // A JSON string body needs the content-type header; FormData (file
    // uploads) sets its own multipart boundary header automatically, so
    // leave that case alone.
    if (opts.body && typeof opts.body === "string") {
        opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    }

    const res = await fetch(url, opts);

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

const api = {
    getSubjects: () => apiFetch(`${API_BASE}/subjects`),
    createSubject: (payload) => apiFetch(`${API_BASE}/subjects`, { method: "POST", body: JSON.stringify(payload) }),
    deleteSubject: (subjectId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}`, { method: "DELETE" }),
    getSubjectSummary: (subjectId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/summary`),

    getRecordings: (subjectId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings`),
    getRecordingsSummary: (recordingIds) => apiFetch(`${API_BASE}/recordings/summary`, { method: "POST", body: JSON.stringify({ recording_ids: recordingIds }) }),
    getRecordingSpectrogram: (subjectId, recordingId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings/${encodeURIComponent(recordingId)}/spectrogram`),
    getRecordingDdkContour: (subjectId, recordingId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings/${encodeURIComponent(recordingId)}/ddk-contour`),
    // Warms up the serial connection (the ~2s device settle time) ahead
    // of the timed capture, so that settling happens during the visible
    // pre-record countdown instead of after the recording request lands
    // -- see runPreRecordCountdown/startTaskRecording below. NOT
    // project-scoped: there's exactly one serial device on the machine
    // regardless of which project's recording ends up owning the trial.
    prepareRecording: () => apiFetch("/api/recording/prepare", { method: "POST" }),
    releaseRecordingPrepare: (token) => apiFetch(`/api/recording/prepare/${encodeURIComponent(token)}`, { method: "DELETE" }),
    addLiveRecording: (subjectId, task, duration, prepareToken) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings`, {
        method: "POST",
        body: JSON.stringify({ task, duration, prepare_token: prepareToken || null }),
    }),
    uploadRecordings: (subjectId, task, files, date) => {
        const formData = new FormData();
        formData.append("task", task);
        if (date) formData.append("date", date); // "YYYY-MM-DD"; server defaults to today
        Array.from(files).forEach(file => formData.append("files", file));
        return apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings/upload`, {
            method: "POST",
            body: formData,
        });
    },
    deleteRecording: (subjectId, recordingId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings/${encodeURIComponent(recordingId)}`, { method: "DELETE" }),
    extractSubjectFeatures: (subjectId) => apiFetch(`${API_BASE}/subjects/${encodeURIComponent(subjectId)}/recordings/extract`, { method: "POST" }),
    // Builds the playback URL for an <audio>/fetch src -- pulled into a
    // shared helper since the same "/api/projects/{id}/recordings/audio
    // ?path=..." shape gets built inline in a couple of places below.
    recordingAudioUrl: (filepath) => `${API_BASE}/recordings/audio?path=${encodeURIComponent(filepath)}`,
};

// ================= Data (populated from the backend) =================

let SUBJECTS = [];
const RECORDINGS = {}; // subjectId -> array of mapped recording rows

// ---- Row mapping: backend JSON -> the shape the UI already renders ----

function formatMeanSd(mean, sd) {
    if (typeof mean !== "number") return "\u2014";
    const meanStr = mean.toFixed(3);
    return typeof sd === "number" ? `${meanStr} \u00B1 ${sd.toFixed(3)}` : meanStr;
}

function formatRawValue(v) {
    if (v === null || v === undefined) return "\u2014";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return String(v);
}

function mapSubject(s) {
    return {
        id: s.id,
        name: s.name,
        age: s.age === "" || s.age === undefined || s.age === null ? "" : (Number(s.age) || s.age),
        sex: s.sex || "",
        group: s.group || "Unassigned",
        added: (s.createdAt || "").slice(0, 10),
        _raw: s,
        _summary: null,
        _summaryLoading: false,
    };
}

const RECORDING_TASK_DISPLAY_NAME = {
    "Sustained Vowel": "Sustained Vowel /a/",
    "DDK": "DDK /pa-ta-ka/",
};

function mapRecording(row) {
    const created = row.created_at ? new Date(row.created_at) : null;
    return {
        id: row.recording_id,
        subjectId: row.subject_id,
        name: RECORDING_TASK_DISPLAY_NAME[row.task] || row.task,
        date: created && !Number.isNaN(created.getTime()) ? formatRecordingDate(created) : "",
        time: created && !Number.isNaN(created.getTime()) ? formatRecordingTime(created) : "",
        type: row.source === "uploaded" ? "uploaded" : "built-in",
        task: row.task,
        _raw: row,
    };
}

// ---- Loaders (fetch + cache) ----

async function loadSubjects() {
    try {
        const rows = await api.getSubjects();
        SUBJECTS = rows.map(mapSubject);
    } catch (err) {
        console.error(err);
        showToast("Couldn't load subjects.");
        SUBJECTS = [];
    }
    renderSubjects();
}

async function loadRecordingsForSubject(subject, { force = false } = {}) {
    if (!subject) return;
    if (!force && RECORDINGS[subject.id]) return;
    // Don't quietly pull in a fresh recordings list just because this
    // subject hasn't been opened in this tab before -- if another tab's
    // change is still pending (unrefreshed), that would let new data
    // appear without ever clicking Refresh, defeating the whole point of
    // the banner (see the cross-tab sync comment above). Leave it
    // unloaded; renderRecordings() shows a "refresh to load" placeholder
    // instead of the real list until the user actually refreshes.
    if (!force && pendingCrossTabChange) return;
    try {
        const rows = await api.getRecordings(subject.id);
        RECORDINGS[subject.id] = rows.map(mapRecording);
    } catch (err) {
        console.error(err);
        showToast("Couldn't load recordings.");
        RECORDINGS[subject.id] = RECORDINGS[subject.id] || [];
    }
}

// ================= Cross-tab sync (same project open in two tabs) =================
// Each project tab is its own createProjectView instance with its own
// SUBJECTS/RECORDINGS copy -- there was previously no signal at
// all when one tab's create/delete changed the backend data another
// open tab of the SAME project was showing, so the other tab just went
// stale until closed and reopened. broadcastProjectDataChanged() fires a
// bubbling event after every successful create/delete below; every
// project tab (including the one that made the change) has a listener
// for it, filtered to the same projectId, that re-fetches and merges.
//
// mergeListById re-fetches from the backend but keeps the SAME object
// reference for any row that already existed, only updating its fields
// in place (and preserving preserveKeys, e.g. the cached analysis
// _summary) -- rather than just replacing the array wholesale. That
// matters because selectedSubject/selectedRecording and
// analysisTargetRef are all compared by reference elsewhere in this file
// (see isAnalysisTarget's comment above), so a wholesale replace would
// silently un-highlight/un-target whatever the user had selected even
// though nothing about it actually changed.
function mergeListById(existingList, freshRows, mapFn, preserveKeys) {
    const existingById = new Map(existingList.map((item) => [item.id, item]));
    return freshRows.map((row) => {
        const mapped = mapFn(row);
        const existing = existingById.get(mapped.id);
        if (!existing) return mapped;
        const preserved = {};
        (preserveKeys || []).forEach((key) => { preserved[key] = existing[key]; });
        Object.assign(existing, mapped, preserved);
        return existing;
    });
}

async function refreshSubjectsList() {
    let rows;
    try {
        rows = await api.getSubjects();
    } catch (err) {
        console.error(err);
        return;
    }
    SUBJECTS = mergeListById(SUBJECTS, rows, mapSubject, ["_summary", "_summaryLoading"]);

    // The subject being browsed/analyzed here may have been deleted from
    // the other tab -- back out of it the same way deleteSubject already
    // does for a local delete.
    if (selectedSubject && !SUBJECTS.includes(selectedSubject)) {
        selectedSubject = null;
        selectedRecording = null;
        currentLevel = "subjects";
        renderLevelChrome();
    }
    if (analysisTargetType === "subject" && analysisTargetRef && !SUBJECTS.includes(analysisTargetRef)) {
        setAnalysisTarget(null, null);
    }
    renderSubjects();
}

async function refreshRecordingsList(subject) {
    if (!subject) return;
    let rows;
    try {
        rows = await api.getRecordings(subject.id);
    } catch (err) {
        console.error(err);
        return;
    }
    const existing = RECORDINGS[subject.id] || [];
    RECORDINGS[subject.id] = mergeListById(existing, rows, mapRecording, []);

    if (selectedSubject !== subject) return;
    if (selectedRecording && !RECORDINGS[subject.id].includes(selectedRecording)) {
        selectedRecording = null;
    }
    if (analysisTargetType === "recording" && analysisTargetRef && !RECORDINGS[subject.id].includes(analysisTargetRef)) {
        setAnalysisTarget(null, null);
    }
    renderRecordings();
}

// Re-syncs whatever this tab currently has loaded: always the subjects
// list, plus the recordings list for whatever subject is currently
// selected (drilling further down is what would otherwise show stale
// data after another tab's change), plus the cached mean/SD analysis
// summary behind the active subject analysis target, if any. That
// summary (ref._summary, see ensureAnalysisSummary) is what the
// graphs/Values widgets for a subject target actually read --
// refreshing the raw lists above doesn't touch it, so without this the
// lists would update but the open graphs would keep showing numbers
// from before another tab's change. Same-tab changes already invalidate
// it via invalidateSubjectAnalysisCache(); this is that same
// invalidation for the cross-tab case.
async function refreshProjectData() {
    await refreshSubjectsList();
    if (selectedSubject) await refreshRecordingsList(selectedSubject);
    if (analysisTargetRef && analysisTargetType === "subject") {
        analysisTargetRef._summary = null;
        await ensureAnalysisSummary(analysisTargetType, analysisTargetRef);
    }
}

function broadcastProjectDataChanged() {
    if (!projectId) return;
    container.dispatchEvent(new CustomEvent("arc-project-data-changed", {
        detail: { projectId },
        bubbles: true,
    }));
}

// Sticky notice + manual refresh (rather than auto-refresh) for changes
// made to this project from another open tab -- see the comment above
// #project-data-changed-banner in shell.html for why. Queried here so
// both the listener below and the click handler can reach them.
const projectDataChangedBanner = container.querySelector("#project-data-changed-banner");
const projectDataChangedRefreshBtn = container.querySelector("#project-data-changed-refresh-btn");
const projectDataChangedDismissBtn = container.querySelector("#project-data-changed-dismiss-btn");

// True from the moment another tab's change is seen until this tab
// actually refreshes -- independent of whether the banner is currently
// showing, so it still remembers a change the user dismissed or just
// never acted on. Read by manualRefreshBtn below to decide whether
// clicking the toolbar refresh button needs a warning first (the
// banner's OWN Refresh button is already a direct response to the
// notice, so it never needs to double-confirm).
let pendingCrossTabChange = false;

// Listens document-wide (any other open tab's container bubbles up
// through it) rather than just on `container`, since the tab that
// changed the data is a sibling instance, not a descendant of this one.
// Registered via addDocListener so destroy() removes it along with this
// factory's other document-level listeners when the tab closes.
addDocListener("arc-project-data-changed", (e) => {
    if (!e.detail || e.detail.projectId !== projectId) return;
    if (e.target === container) return; // our own broadcast -- already applied locally
    pendingCrossTabChange = true;
    if (projectDataChangedBanner) projectDataChangedBanner.style.display = "flex";
});

// Shared by the banner's Refresh button and the always-available toolbar
// refresh button (#manual-refresh-btn, next to Back to Home) -- both just
// want the same "re-sync everything this tab has loaded" behavior.
async function runManualRefresh() {
    if (projectDataChangedBanner) projectDataChangedBanner.style.display = "none";
    pendingCrossTabChange = false;
    await refreshProjectData();
    // Lists (subjects/recordings) are covered by
    // refreshProjectData() above; the pinboard's own graph/Values/
    // Quality widgets read from RECORDINGS at render time
    // but only redraw when told to -- this is the same call the
    // same-tab "recording just added" path already uses for that.
    if (typeof refreshAllWidgetValuesFn === "function") refreshAllWidgetValuesFn();
}

const manualRefreshBtn = container.querySelector("#manual-refresh-btn");
if (manualRefreshBtn) {
    manualRefreshBtn.addEventListener("click", () => {
        // A change from another tab is still pending (whether the banner
        // was dismissed or just never noticed) -- warn before pulling it
        // in, since refreshing can change what's on screen (subject/
        // recording lists, open graphs) out from under the user. Reuses
        // the delete-confirm modal with a non-destructive label/style
        // (see openConfirmDelete's options param).
        if (pendingCrossTabChange) {
            openConfirmDelete(
                "Refresh project data?",
                "Changes were made to this project in another tab. Refreshing will pull those changes in here.",
                () => { runManualRefresh(); },
                { confirmLabel: "Refresh", danger: false }
            );
            return;
        }
        runManualRefresh();
    });
}

if (projectDataChangedRefreshBtn) {
    projectDataChangedRefreshBtn.addEventListener("click", async () => {
        await runManualRefresh();
    });
}

// Dismiss just hides the banner without refreshing -- for someone mid-
// analysis who wants to acknowledge and keep working on the current
// (stale) data rather than refresh right now. Data stays stale (and
// pendingCrossTabChange stays true, so the toolbar refresh button still
// warns) until they actually refresh via one of the two Refresh buttons.
if (projectDataChangedDismissBtn) {
    projectDataChangedDismissBtn.addEventListener("click", () => {
        if (projectDataChangedBanner) projectDataChangedBanner.style.display = "none";
    });
}

// Lazily fetches the mean/SD summary behind a subject analysis target
// (see setAnalysisTarget below), caching it on the ref itself so
// re-picking the same target doesn't refetch. Values widgets read
// straight from ref._summary once it lands -- see getWidgetValuesSync
// inside the pinboard IIFE further down.
async function ensureAnalysisSummary(type, ref) {
    if (!ref || ref._summary || ref._summaryLoading || type !== "subject") return;
    ref._summaryLoading = true;
    try {
        ref._summary = await api.getSubjectSummary(ref.id);
    } catch (err) {
        console.error(err);
        showToast("Couldn't load analysis summary.");
    } finally {
        ref._summaryLoading = false;
        if (typeof refreshAllWidgetValuesFn === "function") refreshAllWidgetValuesFn();
    }
}

// Clears the cached mean/SD summary (see ensureAnalysisSummary above) for
// a subject whose recordings just changed (added, uploaded, or deleted)
// -- a subject's summary is aggregated across every recording it has, so
// it's stale whenever any of them changes. If that subject is the
// currently active analysis target, immediately re-fetches so open
// Values widgets pick up the new numbers without the user having to
// reselect anything.
function invalidateSubjectAnalysisCache(subjectId) {
    const subjectRef = SUBJECTS.find((s) => s.id === subjectId);
    if (subjectRef) subjectRef._summary = null;
    if (analysisTargetRef && !analysisTargetRef._summary && analysisTargetType === "subject") {
        ensureAnalysisSummary(analysisTargetType, analysisTargetRef);
    }
}

// ================= Toast (small inline message, replaces window.alert
// for validation-style errors) =================

// #toast is intentionally SHARED app-wide (not per-tab) -- see decision in
// the Step 0 inventory review: a background tab's async work (e.g. feature
// extraction finishing) should surface a toast regardless of which tab is
// focused, same as VS Code notifications aren't tied to the active editor.
const toastEl = document.getElementById("toast");
let toastTimer = null;

// `opts.loading` shows a small spinner in the toast (for work that's
// still in flight); `opts.persistent` keeps it on screen until the next
// showToast call instead of auto-dismissing after 2.2s. Together these
// let a caller show "Uploading…" the whole time a request is pending,
// then swap in the real result once it resolves.
function showToast(message, opts = {}) {
    if (!toastEl) return;
    const { loading = false, persistent = false } = opts;

    toastEl.textContent = "";
    if (loading) {
        const spinner = document.createElement("span");
        spinner.className = "toast-spinner";
        toastEl.appendChild(spinner);
    }
    const textEl = document.createElement("span");
    textEl.textContent = message;
    toastEl.appendChild(textEl);

    toastEl.classList.toggle("toast-loading", loading);
    toastEl.classList.add("visible");
    clearTimeout(toastTimer);
    if (!persistent) {
        toastTimer = setTimeout(() => {
            toastEl.classList.remove("visible");
        }, 2200);
    }
}

// ================= State =================

let currentSort = "date";
let currentLevel = "subjects"; // "subjects" | "recordings"
let selectedSubject = null;
let selectedRecording = null;

// Multi-select state for the recording-select dropdown's left-hand dots
// (see renderRecordings() below) -- separate from selectedRecording/
// analysisTargetRef above, since picking recordings this way doesn't
// set the single "active" target until "Continue" (below) is pressed.
// Keyed by recording id (mapRecording()'s .id, i.e. recording_id).
let multiSelectedRecordingIds = new Set();

const recordingMultiselectBar = container.querySelector("#recording-multiselect-bar");
const recordingMultiselectCount = container.querySelector("#recording-multiselect-count");
const recordingMultiselectContinueBtn = container.querySelector("#recording-multiselect-continue-btn");

function updateRecordingMultiselectBar() {
    if (!recordingMultiselectBar) return;
    const n = multiSelectedRecordingIds.size;
    // The bar only makes sense while the dropdown itself is open -- it's
    // the "commit these dot picks" affordance for that dropdown, not a
    // standalone indicator of the active target. Without this check it
    // pops back up after the dropdown closes any time the committed
    // target still has recordings selected (e.g. right after Continue),
    // since closing re-renders the list and recomputes this.
    const dropdownOpen = recordingSelectDropdown && recordingSelectDropdown.classList.contains("open");
    const show = n > 0 && currentLevel === "recordings" && dropdownOpen;
    recordingMultiselectBar.classList.toggle("open", show);
    if (show && recordingMultiselectCount) {
        recordingMultiselectCount.textContent = `Analyze ${n} selected recording${n === 1 ? "" : "s"}`;
    }
}

// Resets the dropdown's left-hand multi-select dots to match whatever is
// actually the committed "recordings" analysis target (or nothing, if the
// active target isn't a multi-recording one). Dot clicks made in the
// dropdown are only tentative until "Continue" is pressed -- this is what
// throws away un-committed tentative changes: called whenever the
// dropdown is closed without hitting Continue (see
// closeRecordingSelectDropdown), and whenever the active analysis target
// changes for any other reason (see setAnalysisTarget), so a single-
// recording or subject pick clears dots left over from a previous
// multi-select, instead of leaving them checked for something that's no
// longer being analyzed.
function syncMultiSelectFromTarget() {
    const committedIds = (analysisTargetType === "recordings" && analysisTargetRef && analysisTargetRef.recordingIds)
        ? analysisTargetRef.recordingIds
        : [];
    multiSelectedRecordingIds = new Set(committedIds);
}

if (recordingMultiselectContinueBtn) {
    recordingMultiselectContinueBtn.addEventListener("click", async () => {
        const ids = Array.from(multiSelectedRecordingIds);
        if (!ids.length) return;
        recordingMultiselectContinueBtn.disabled = true;
        recordingMultiselectContinueBtn.textContent = "Loading…";
        try {
            const summary = await api.getRecordingsSummary(ids);
            const ref = { id: null, _summary: summary, recordingIds: ids };
            // Not cleared here -- leaving the same recordings checked means
            // reopening the dropdown after analyzing shows exactly what's
            // currently the active target, instead of an empty picker the
            // user has to reselect from scratch. (setAnalysisTarget below
            // re-syncs the dots from analysisTargetRef.recordingIds anyway,
            // which for this ref is just `ids`, so this is a no-op stay.)
            renderRecordings();
            selectRecordingLabel.textContent = `${ids.length} Recording${ids.length === 1 ? "" : "s"}`;
            setAnalysisTarget("recordings", ref);
            closeRecordingSelectDropdown();
        } catch (err) {
            console.error(err);
            showToast(err.message || "Couldn't load the selected recordings.");
        } finally {
            recordingMultiselectContinueBtn.disabled = false;
            recordingMultiselectContinueBtn.textContent = "Continue";
        }
    });
}

// What the pinboard is currently analyzing — set whenever the user picks
// "Analyze Subject" from a row flyout, or clicks a
// recording in the recordings list. Quality widgets only make sense for a
// single recording (they surface per-take signal-quality metrics), so the
// Quality button is hidden unless a recording is the active analysis target.
// ================= App sidebar (toggled from the menu bar) =================
// Declared early (before updateWidgetButtonsAvailability, which closes the
// sidebar via closeAppSidebar) so that function's TDZ is already clear
// the first time it's called during initial page setup below.

const sidebarToggleBtn = container.querySelector("#sidebar-toggle-btn");
const appSidebar = container.querySelector("#app-sidebar");
const appSidebarBackdrop = container.querySelector("#app-sidebar-backdrop");
const appSidebarCloseBtn = container.querySelector("#app-sidebar-close-btn");

function openAppSidebar() {
    appSidebar.classList.add("open");
    appSidebarBackdrop.classList.add("open");
    appSidebar.setAttribute("aria-hidden", "false");
    sidebarToggleBtn.setAttribute("aria-expanded", "true");
    if (typeof renderSidebarContent === "function") renderSidebarContent();
}

function closeAppSidebar() {
    appSidebar.classList.remove("open");
    appSidebarBackdrop.classList.remove("open");
    appSidebar.setAttribute("aria-hidden", "true");
    sidebarToggleBtn.setAttribute("aria-expanded", "false");
}


sidebarToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (appSidebar.classList.contains("open")) {
        closeAppSidebar();
    } else {
        openAppSidebar();
    }
});

appSidebarCloseBtn.addEventListener("click", () => closeAppSidebar());
appSidebarBackdrop.addEventListener("click", () => closeAppSidebar());

addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape") closeAppSidebar();
});

// ---- Sidebar graph layout config ----
// Maps a context key (derived from the active analysis target's task
// type(s) and whether it's a single recording or several) to the
// sections shown in the sidebar, and optionally the sidebar's width for
// that context. Rendering is fully data-driven off this table -- to
// add/rename/reorder a heading, add a graph button, or change the panel
// width for a case, edit this object only. Headings are already set up
// per case (Main/Others/Trends, or Overview/Sustained/DDK for mixed) --
// add real graph button labels into the relevant `buttons` array as
// they're built.
// Button labels must match a key in GRAPH_RENDERERS (project.js pinboard
// IIFE) exactly -- that's what addGraphWidget()/createWidget() key off of.
// Spectrogram, Pitch Waveform, and DDK Waveform only render a real single
// recording's waveform/STFT, so they're left out of every *_multi/mixed
// context (subject targets) -- see the note by
// updateWidgetButtonsAvailability() for the same rule applied elsewhere.
// MDVP Profile and Vowel Space are the same story: each is a single
// sustained-vowel trial's own voice print/tongue position, not
// something that's coherent averaged across a subject's
// several recordings, so they're also left out of every *_multi/mixed
// context and only offered in sustained_single. The across-recordings
// view of vowel-space data is a genuinely different graph (Vowel Space
// Trajectory, in sustained_multi/mixed below) rather than a variant of
// this one.
const SIDEBAR_LAYOUTS = {
    sustained_single: [
        { heading: "Main", buttons: ["Formants", "Voice Quality", "MDVP Profile", "Vowel Space"] },
        { heading: "Others", buttons: ["Spectrogram", "Pitch Waveform"] },
    ],
    sustained_multi: [
        { heading: "Main", buttons: ["Formants", "Voice Quality"] },
        { heading: "Trends", buttons: ["Vowel Space Trajectory", "Vowel Drift Trend"] },
        { heading: "Others", buttons: [] },
    ],
    ddk_single: [
        { heading: "Main", buttons: ["Spectrogram", "DDK Waveform"] },
        { heading: "Others", buttons: ["DDK Peak Tracker", "Interval Bar Chart", "Regularity Trend", "Pause Ratio", "DDK Summary"] },
    ],
    ddk_multi: [
        { heading: "Main", buttons: [] },
        { heading: "Trends", buttons: ["DDK Repetition Count Trend", "DDK Regularity Trend", "Interval Stability Trend", "Pause Ratio Trend", "Rate Trend"] },
        { heading: "Others", buttons: [] },
    ],
    mixed: {
        width: 420,
        sections: [
            { heading: "Overview", buttons: [] },
            { heading: "Sustained", buttons: ["Formants", "Voice Quality", "Vowel Space Trajectory", "Vowel Drift Trend"] },
            { heading: "DDK", buttons: ["DDK Repetition Count Trend", "DDK Regularity Trend", "Interval Stability Trend", "Pause Ratio Trend", "Rate Trend"] },
        ],
    },
};

const SIDEBAR_DEFAULT_WIDTH = 300;



// Derives which SIDEBAR_LAYOUTS key applies to the current analysis
// target. Reads analysisTargetType/analysisTargetRef and
// getAvailableTaskTypesForTarget(), all declared further down in this
// file -- safe to reference here due to function/let hoisting, since
// this is only ever invoked (not run at parse time) after a target has
// actually been set.
function getSidebarContextKey() {
    if (!analysisTargetType) return null;

    const types = getAvailableTaskTypesForTarget();
    const hasSustained = types.has("Sustained");
    const hasDDK = types.has("DDK");

    if (hasSustained && hasDDK) return "mixed";

    // A single recording is always "single", regardless of task type.
    if (analysisTargetType === "recording") {
        if (hasSustained) return "sustained_single";
        if (hasDDK) return "ddk_single";
        return null;
    }

    // Subject target -- "multi" once there's more than one
    // trial of that task type to show trends across.
    const summary = analysisTargetRef && analysisTargetRef._summary;
    if (hasSustained) {
        const count = summary && summary.vowel_trials ? summary.vowel_trials.length : 0;
        return count > 1 ? "sustained_multi" : "sustained_single";
    }
    if (hasDDK) {
        const count = summary && summary.ddk_trials ? summary.ddk_trials.length : 0;
        return count > 1 ? "ddk_multi" : "ddk_single";
    }
    return null;
}

// Rebuilds the sidebar's heading + button-row sections from
// SIDEBAR_LAYOUTS for whatever context key currently applies. Called
// whenever the analysis target changes (see updateWidgetButtonsAvailability)
// and when the sidebar is opened, so it's never stale.
function renderSidebarContent() {
    const content = container.querySelector("#app-sidebar-content");
    if (!content) return;
    content.innerHTML = "";

    const contextKey = getSidebarContextKey();
    const raw = (contextKey && SIDEBAR_LAYOUTS[contextKey]) || [];
    // A layout entry is either a plain array of sections, or
    // { width, sections } when that context also needs a non-default
    // panel width (see `mixed` above).
    const layout = Array.isArray(raw) ? raw : (raw.sections || []);
    const width = Array.isArray(raw) ? SIDEBAR_DEFAULT_WIDTH : (raw.width || SIDEBAR_DEFAULT_WIDTH);
    if (appSidebar) appSidebar.style.width = width + "px";

    let renderedSections = 0;
    layout.forEach((section) => {
        // Skip sections with nothing in them (e.g. "Trends"/"Others" in
        // contexts that don't have any graph for that slot yet) instead
        // of showing an empty heading with nothing underneath it.
        if (!section.buttons || section.buttons.length === 0) return;

        const heading = document.createElement("div");
        heading.className = "sidebar-section-label" +
            (renderedSections > 0 ? " sidebar-section-label--spaced" : "");
        heading.textContent = section.heading;
        content.appendChild(heading);
        renderedSections++;

        const row = document.createElement("div");
        row.className = "sidebar-graph-btn-row";
        section.buttons.forEach((label) => {
            const btn = document.createElement("button");
            btn.className = "graph-toolbar-btn sidebar-graph-btn";
            btn.textContent = label;
            btn.dataset.graph = label;
            // Reflect whether this graph's widget is already on the
            // pinboard (e.g. sidebar was closed and reopened, or the
            // target changed but this graph type is valid for both).
            const isOpen = !!container.querySelector(`.pinboard-widget[data-graph-title="${label}"]`);
            btn.classList.toggle("is-open", isOpen);
            // Real add/focus-existing behavior -- same as the graph
            // buttons used to do from the toolbar. addGraphWidget itself
            // calls syncGraphToolbarButtonOpenState(), which keeps this
            // button (and any other with the same data-graph) in sync
            // even though the sidebar re-renders from scratch each time.
            btn.addEventListener("click", () => {
                if (typeof addGraphWidgetFn === "function") addGraphWidgetFn(label);
            });
            row.appendChild(btn);
        });
        content.appendChild(row);
    });
}

const viewToggleSidebarBtn = container.querySelector("#view-toggle-sidebar-btn");
if (viewToggleSidebarBtn) {
    viewToggleSidebarBtn.addEventListener("click", () => {
        if (appSidebar.classList.contains("open")) {
            closeAppSidebar();
        } else {
            openAppSidebar();
        }
    });
}

let analysisTargetType = null; // "subject" | "recording" | "recordings" | null

// The actual subject/recording object (or multi-recording ref) behind
// analysisTargetType —
// tracked separately so re-picking the exact same target (e.g. reopening
// the select-recording dropdown and clicking the same recording again)
// can be detected and treated as a no-op instead of re-clearing the board.
let analysisTargetRef = null;

// Four panels take turns occupying the empty pinboard area, based on how
// far the user's gotten toward an actual analysis target:
//   - nobody browsing yet (no subject, no target) -> the search-first
//     picker modal (#subjectPickerModalLayer)
//   - a subject is being browsed (dropdown open on their recordings) but
//     no recording(s) picked yet -> the mid-pinboard nudge message
//     (#pinboard-no-target-msg)
//   - a target's been set but no widgets have been dropped onto the
//     board yet -> a second nudge message (#pinboard-no-widgets-msg),
//     pointing the user at the widget buttons instead of a blank board
//   - a target is set AND at least one widget is on the board -> none of
//     the above; the "Select Recording" pill/dropdown itself is visible
//     throughout every state but the first.
// Called from setAnalysisTarget() and wherever selectedSubject changes
// (renderSubjects/renderRecordings, called after every such change), and
// also from every widget add/remove/clear call site (createWidget, its
// close-button handler, clearPinboardWidgetsFn) so the no-widgets nudge
// tracks the live widget count rather than just the target-selection
// moment. Suppressed while suppressPinboardEmptyStateToggle is true --
// see pickSubjectFromPicker()/morphSearchBarToDropdownButton() below,
// which choreograph these same panels by hand during the search-bar ->
// dropdown-button morph animation, and would otherwise get overridden
// mid-animation by an unrelated renderSubjects()/renderRecordings() call.
let suppressPinboardEmptyStateToggle = false;

function updatePinboardEmptyState() {
    if (suppressPinboardEmptyStateToggle) return;
    const hasSubject = !!selectedSubject;
    const hasTarget = !!analysisTargetType;

    const pickerLayer = container.querySelector("#subjectPickerModalLayer");
    if (pickerLayer) pickerLayer.classList.toggle("is-hidden", hasSubject || hasTarget);

    const recordingSelectWrap = container.querySelector("#recording-select-wrap");
    if (recordingSelectWrap) recordingSelectWrap.classList.toggle("is-hidden", !hasSubject && !hasTarget);

    const noTargetMsg = container.querySelector("#pinboard-no-target-msg");
    if (noTargetMsg) noTargetMsg.classList.toggle("is-hidden", !(hasSubject && !hasTarget));

    const noWidgetsMsg = container.querySelector("#pinboard-no-widgets-msg");
    if (noWidgetsMsg) {
        const hasWidgets = container.querySelectorAll(".pinboard-widget").length > 0;
        noWidgetsMsg.classList.toggle("is-hidden", !(hasTarget && !hasWidgets));
    }
}

function setAnalysisTarget(type, ref) {
    // Re-selecting the same subject/recording that's already the
    // active analysis target shouldn't do anything — in particular it
    // shouldn't blow away widgets the user has open.
    if (type === analysisTargetType && ref === analysisTargetRef) return;

    analysisTargetType = type;
    analysisTargetRef = ref;
    // Whatever's checked in the recording-select dropdown's multi-select
    // dots should always reflect this new target, not whatever was
    // tentatively clicked before it changed (see syncMultiSelectFromTarget).
    syncMultiSelectFromTarget();
    updateWidgetButtonsAvailability();
    // Refresh the highlight in both lists — whichever one is on
    // screen (or gets navigated back to later) should show the new
    // target, not wherever the user last clicked to browse.
    renderSubjects();
    renderRecordings();
    if (typeof clearPinboardWidgetsFn === "function") {
        clearPinboardWidgetsFn();
    }
    updatePinboardEmptyState();
    if (!type) {
        selectRecordingLabel.textContent = "Select Recording";
    }
    // Subject targets show a live-computed mean±SD summary pulled from
    // the backend on demand -- kick that fetch off now so it's usually
    // already cached by the time the user clicks "Values".
    if (type === "subject") {
        ensureAnalysisSummary(type, ref);
    }
}

// When a single recording is the analysis target, its task type (sustained
// vowel vs. DDK) is already known, so the Values dropdown is unnecessary —
// clicking "Values" just drops that one widget straight onto the board. For
// a subject target (or a custom/uploaded recording whose task
// type isn't one of the two built-ins), the dropdown is still needed so the
// user can pick.
function getDirectRecordingValueType() {
    if (analysisTargetType !== "recording" || !selectedRecording) return null;
    const name = selectedRecording.name || "";
    if (/sustained/i.test(name)) return "Sustained";
    if (/ddk/i.test(name)) return "DDK";
    return null;
}

// ---- Task-type filtering for graphs/widgets ----
//
// IMPORTANT FOR FUTURE AI: every graph widget (see GRAPH_RENDERERS
// further down, in the pinboard IIFE) and every metric widget type
// (see WIDGET_METRICS) belongs to a task type — "Sustained", "DDK",
// or "Both" (task-agnostic, e.g. a widget that compares the two, or
// one like recording Quality/SNR that isn't specific to either task).
// Any NEW graph or widget added later MUST be tagged with its
// taskType and included in this filtering (here, in
// updateWidgetButtonsAvailability() below, and in the Values dropdown
// filtering there too) — otherwise it will keep showing up (or stay
// hidden) no matter which task type is actually being analyzed, which
// defeats the point of this filtering. Rule of thumb: if a widget
// only reads Sustained-vowel features (F0/F1/F2/HNR/Jitter) or only
// DDK features, tag it with that task type; if it reads both, or
// reads task-agnostic data (recording-level quality/SNR, raw
// waveform/spectrogram), tag it "Both".
//
// Determines which task type(s) are actually available for the
// current analysis target, so task-specific graphs/widgets can be
// hidden instead of showing empty or misleading data:
//   - a single recording only ever has one task type
//   - a subject may have Sustained recordings, DDK recordings, or
//     both — in which case everything shows
function getAvailableTaskTypesForTarget() {
    if (analysisTargetType === "recording") {
        if (!selectedRecording) return new Set();
        const direct = getDirectRecordingValueType();
        return direct ? new Set([direct]) : new Set(["Sustained", "DDK"]);
    }

    if (analysisTargetType === "subject" || analysisTargetType === "recordings") {
        const summary = analysisTargetRef && analysisTargetRef._summary;
        // Summary not loaded yet -- don't hide anything while we wait,
        // to avoid a flash of missing buttons; ensureAnalysisSummary()
        // re-runs updateWidgetButtonsAvailability (via
        // refreshAllWidgetValues) once it resolves.
        if (!summary) return new Set(["Sustained", "DDK"]);
        const types = new Set();
        if (summary.vowel_trials && summary.vowel_trials.length) types.add("Sustained");
        if (summary.ddk_trials && summary.ddk_trials.length) types.add("DDK");
        return types;
    }

    return new Set();
}

// A graph/widget with taskType "Both" is always shown once there's any
// target at all; otherwise it's shown only if its task type is among
// the ones actually available for the current target (see above).
function isTaskTypeVisible(taskType) {
    if (taskType === "Both") return analysisTargetType !== null;
    return getAvailableTaskTypesForTarget().has(taskType);
}

function updateWidgetButtonsAvailability() {
    const valuesWrap = container.querySelector("#values-type-wrap");
    const qualityWrap = container.querySelector("#quality-type-wrap");
    const valuesChevron = container.querySelector("#add-values-chevron");

    // Nothing to add widgets for until a subject or recording
    // has actually been chosen as the analysis target.
    const hasTarget = analysisTargetType !== null;

    // Graph buttons are additionally filtered by task type (see
    // getAvailableTaskTypesForTarget()/isTaskTypeVisible() above) --
    // e.g. Formants only makes sense for Sustained Vowel data, so it
    // stays hidden while a DDK-only recording/subject is being
    // analyzed. graphTaskTypes (declared near the top of this factory) is
    // populated by the pinboard IIFE from GRAPH_RENDERERS, the single
    // source of truth for each graph's taskType -- see the note there
    // before adding a new graph.
    const GRAPH_BUTTON_TITLES = {
        "add-formants-btn": "Formants",
        "add-voice-quality-btn": "Voice Quality",
        "add-spectrogram-btn": "Spectrogram",
        "add-pitch-waveform-btn": "Pitch Waveform",
        "add-ddk-waveform-btn": "DDK Waveform",
    };
    Object.entries(GRAPH_BUTTON_TITLES).forEach(([id, title]) => {
        const btn = container.querySelector("#" + id);
        if (!btn) return;
        const taskType = graphTaskTypes[title] || "Both";
        btn.style.display = hasTarget && isTaskTypeVisible(taskType) ? "" : "none";
    });

    // DDK Waveform, Pitch Waveform, and Spectrogram additionally only
    // make sense against a single recording -- each renders one real
    // audio clip's waveform/STFT, which has no coherent meaning
    // aggregated across a subject's several trials (unlike e.g.
    // Values/Quality, which are fine averaging scalar stats). Restrict
    // them the same way Quality/the playback bar are restricted above.
    ["add-ddk-waveform-btn", "add-pitch-waveform-btn", "add-spectrogram-btn"].forEach((id) => {
        const btn = container.querySelector("#" + id);
        if (btn && analysisTargetType !== "recording") btn.style.display = "none";
    });

    if (valuesWrap) valuesWrap.style.display = hasTarget ? "" : "none";

    // Filter the Values dropdown's Sustained/DDK options the same way --
    // only offer picking a task type that's actually present for a
    // subject target (a single recording never shows this
    // dropdown at all, see getDirectRecordingValueType()/valuesChevron
    // below).
    if (hasTarget) {
        const availableTypes = getAvailableTaskTypesForTarget();
        container.querySelectorAll('#values-type-dropdown [data-value-type]').forEach(btn => {
            const vt = btn.dataset.valueType;
            btn.style.display = availableTypes.has(vt) ? "" : "none";
        });
    }

    // Quality and the playback bar additionally only make sense for a
    // single recording -- and only one actually captured through the app
    // (an ambient channel alongside the patient channel is what the
    // quality analysis is computed from). Uploaded recordings don't have
    // that second channel, so there's no quality rating to show for them.
    const qualityAllowed = analysisTargetType === "recording" &&
        selectedRecording && selectedRecording.type !== "uploaded";
    if (qualityWrap) qualityWrap.style.display = qualityAllowed ? "" : "none";

    // Hide the Values chevron when clicking it won't open a dropdown.
    if (valuesChevron) valuesChevron.style.display = getDirectRecordingValueType() ? "none" : "";

    // The sidebar only makes sense once there's something selected to
    // analyze -- hide its toggle (and close it if already open) the
    // same way the graph/widget buttons above are hidden.
    const sidebarToggleBtn = container.querySelector("#sidebar-toggle-btn");
    if (sidebarToggleBtn) {
        sidebarToggleBtn.style.display = hasTarget ? "" : "none";
        if (!hasTarget && typeof closeAppSidebar === "function") {
            closeAppSidebar();
        }
    }

    // Keep the sidebar's own contents (headings + graph buttons) in sync
    // with the target too, in case it's open while the target changes.
    if (typeof renderSidebarContent === "function") renderSidebarContent();
}

// The subjects/recordings lists double as a drill-down browser
// (selectedSubject/selectedRecording just track where the
// user has navigated to) and as the picker for the active analysis
// target. The "selected" highlight must reflect the latter, not
// wherever browsing left off — otherwise clicking into a recording to
// look around and then going back leaves the wrong row highlighted.
// Compare by reference (not id) since recording ids are unique but
// subjects could otherwise coincidentally match.
function isAnalysisTarget(type, obj) {
    return analysisTargetType === type && analysisTargetRef === obj;
}

const subjectsListEl = container.querySelector("#subjects-list");
const recordingsListEl = container.querySelector("#recordings-list");

const listTitleEl = container.querySelector("#list-title");
const listBackBtn = container.querySelector("#list-back-btn");
const sortTriggerWrap = container.querySelector("#sort-trigger-wrap");
const addSubjectBtn = container.querySelector("#add-subject-btn");
const addRecordingWrap = container.querySelector("#add-recording-wrap");
const addRecordingBtn = container.querySelector("#add-recording-btn");

function initials(name) {
    const parts = name.split(" ").filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return parts.map(p => p[0]).join("").slice(0, 2).toUpperCase();
}

function sortedSubjects() {
    let list = SUBJECTS.slice();
    if (currentSort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    if (currentSort === "date") list.sort((a, b) => new Date((b._raw && b._raw.createdAt) || b.added) - new Date((a._raw && a._raw.createdAt) || a.added));
    if (currentSort === "age") list.sort((a, b) => a.age - b.age);
    return list;
}

function renderLevelChrome() {
    const atSubjects = currentLevel === "subjects";
    const atRecordings = currentLevel === "recordings";

    subjectsListEl.style.display = atSubjects ? "" : "none";
    recordingsListEl.style.display = atRecordings ? "" : "none";

    listBackBtn.style.display = atSubjects ? "none" : "flex";
    sortTriggerWrap.style.display = atSubjects ? "flex" : "none";
    addSubjectBtn.style.display = atSubjects ? "flex" : "none";
    addRecordingWrap.style.display = atRecordings ? "flex" : "none";
    if (!atRecordings) closeAddRecordingFlyout();

    if (atSubjects) {
        listTitleEl.textContent = "Subjects";
    } else {
        listTitleEl.textContent = "Recordings" + (selectedSubject ? " \u2014 " + selectedSubject.name : "");
    }
}

listBackBtn.addEventListener("click", () => {
    if (currentLevel === "recordings") {
        currentLevel = "subjects";
        selectedRecording = null;
    }
    renderLevelChrome();
    renderRecordings();
});

// ================= Row options flyout (ellipsis button on subject
// rows) -- opens a small menu to the side of the button, mirroring the
// add-recording flyout's sideways-panel style but built dynamically since
// there's one row per subject rather than a single static trigger. =================

let rowFlyoutEl = null;

function closeRowFlyout() {
    if (rowFlyoutEl) {
        rowFlyoutEl.remove();
        rowFlyoutEl = null;
    }
}

function openRowFlyout(anchorBtn, items) {
    closeRowFlyout();

    const menu = document.createElement("div");
    menu.className = "row-flyout";
    menu.innerHTML = items.map((item, i) =>
        `<button type="button" class="flyout-item${item.danger ? " flyout-item--danger" : ""}" data-idx="${i}">${item.label}</button>`
    ).join("");
    // The menu is appended to <body> rather than nested inside the
    // recording-select dropdown it was opened from, so a click on its own
    // padding (i.e. anywhere that isn't one of the flyout-item buttons
    // below, which already stopPropagation()) would otherwise bubble up
    // to the document click listener and close that parent dropdown.
    menu.addEventListener("click", (e) => e.stopPropagation());

    document.body.appendChild(menu);

    const anchorRect = anchorBtn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = anchorRect.right + 8;
    if (left + menuRect.width > window.innerWidth - 8) {
        left = anchorRect.left - menuRect.width - 8;
    }
    let top = anchorRect.top + anchorRect.height / 2 - menuRect.height / 2;
    top = Math.min(Math.max(top, 8), window.innerHeight - menuRect.height - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    menu.querySelectorAll(".flyout-item").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeRowFlyout();
            items[Number(btn.dataset.idx)].onClick();
        });
    });

    rowFlyoutEl = menu;
}

// Capture phase so this still fires even though the recording-select
// dropdown (and other panels) call stopPropagation() on bubbling clicks.
addDocListener("click", (e) => {
    if (!isTabActive()) return;
    if (rowFlyoutEl && rowFlyoutEl.contains(e.target)) return;
    closeRowFlyout();
}, true);
addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape") closeRowFlyout();
});

// ================= Delete-confirmation modal (used by subject row
// deletion) =================

const confirmDeleteOverlay = container.querySelector("#confirmDeleteOverlay");
const confirmDeleteTitleEl = container.querySelector("#confirmDeleteTitle");
const confirmDeleteMessageEl = container.querySelector("#confirmDeleteMessage");
const confirmDeleteCancelBtn = container.querySelector("#confirmDeleteCancel");
const confirmDeleteConfirmBtn = container.querySelector("#confirmDeleteConfirm");
let pendingDeleteAction = null;

function openConfirmDelete(title, message, onConfirm, options) {
    if (!confirmDeleteOverlay) return;
    const opts = options || {};
    confirmDeleteTitleEl.textContent = title;
    confirmDeleteMessageEl.textContent = message;
    // Reused for the non-destructive "cross-tab changes pending" refresh
    // warning too (see manualRefreshBtn below) -- confirmLabel/danger let
    // that call site swap "Delete"/red-danger-styling for "Refresh"/
    // plain styling instead of adding a whole second modal for one button.
    confirmDeleteConfirmBtn.textContent = opts.confirmLabel || "Delete";
    confirmDeleteConfirmBtn.classList.toggle("subject-modal-submit--danger", opts.danger !== false);
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

function renderSubjects() {
    const list = sortedSubjects();
    subjectsListEl.innerHTML = "";
    list.forEach(s => {
        const el = document.createElement("div");
        el.className = "subject-item" + (isAnalysisTarget("subject", s) ? " selected" : "");
        el.innerHTML = `
            <div class="subject-avatar">${initials(s.name)}</div>
            <div class="subject-info">
                <div class="subject-name">${s.name}</div>
                <div class="subject-sub">${s.id} &middot; ${s.group}</div>
            </div>
            <button type="button" class="row-ellipsis-btn" title="More options" aria-label="More options">
                <svg width="3" height="15" viewBox="0 0 3 15" fill="currentColor">
                    <circle cx="1.5" cy="1.5" r="1.5"/>
                    <circle cx="1.5" cy="7.5" r="1.5"/>
                    <circle cx="1.5" cy="13.5" r="1.5"/>
                </svg>
            </button>
        `;
        el.addEventListener("click", () => selectSubject(s));
        el.querySelector(".row-ellipsis-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            openRowFlyout(e.currentTarget, [
                { label: "Analyze Subject", onClick: () => {
                    closeRecordingSelectDropdown();
                    selectRecordingLabel.textContent = s.name;
                    setAnalysisTarget("subject", s);
                } },
                { label: "Delete Subject", danger: true, onClick: () => {
                    openConfirmDelete(
                        "Delete Subject",
                        `This will permanently delete "${s.name}" and all of their recordings. This can't be undone.`,
                        () => deleteSubject(s)
                    );
                } },
            ]);
        });
        subjectsListEl.appendChild(el);
    });
    renderSubjectPicker();
    updatePinboardEmptyState();
}

// ================= Subject picker (search-first landing panel) =================
// Renders the same SUBJECTS list into #subjectPickerList (see
// #subjectPickerModalLayer in shell.html) -- kept in sync by calling this
// at the end of renderSubjects() above, so it never drifts out of sync
// with the real subjects/#subjects-list. Picking a row here both sets
// that subject as the analysis target AND drills the "Select Recording"
// dropdown into their recordings, i.e. the combined effect of
// selectSubject() + the "Analyze Subject" flyout action above -- so the
// dropdown is left in a useful state the moment it appears.
function renderSubjectPicker() {
    const list = container.querySelector("#subjectPickerList");
    if (!list) return;
    list.innerHTML = "";
    SUBJECTS.forEach((s) => {
        const group = document.createElement("div");
        group.className = "subject-picker-group";
        group.innerHTML = `
            <button type="button" class="subject-picker-row">
                <div class="subject-picker-avatar">${initials(s.name)}</div>
                <div class="subject-picker-info">
                    <div class="subject-picker-name">${s.name}</div>
                    <div class="subject-picker-sub">${s.id} &middot; ${s.group}</div>
                </div>
            </button>
        `;
        group.querySelector(".subject-picker-row").addEventListener("click", (e) => {
            e.stopPropagation();
            pickSubjectFromPicker(s);
        });
        list.appendChild(group);
    });
    // Re-apply whatever search query is currently typed (if any) to the
    // freshly rendered rows -- a rebuild otherwise wipes the filtering.
    if (typeof refreshSubjectPickerFilterFn === "function") refreshSubjectPickerFilterFn();
}

async function pickSubjectFromPicker(s) {
    // Captured before anything else changes -- once the picker layer
    // gets hidden (a couple of steps down), the real search bar can't be
    // measured any more, but the morph animation below needs its exact
    // on-screen rect as the starting point.
    const searchBar = container.querySelector(".subject-picker-search");
    const startRect = searchBar ? searchBar.getBoundingClientRect() : null;
    const targetWrap = container.querySelector("#recording-select-wrap");
    const targetBtn = container.querySelector("#select-recording-btn");

    selectedSubject = s;
    selectedRecording = null;
    currentLevel = "recordings";

    // The usual renderSubjects()/renderRecordings() -> updatePinboardEmptyState()
    // chain would swap the picker panel/dropdown-button visibility
    // instantly, right underneath the animation about to run -- suppress
    // it here and settle the real end-state by hand once the morph
    // finishes (see the callback below and its fallback).
    suppressPinboardEmptyStateToggle = true;
    renderSubjects();
    renderLevelChrome();
    if (!RECORDINGS[s.id]) {
        recordingsListEl.innerHTML = `<div class="box-empty"><div class="empty-title">Loading&hellip;</div></div>`;
    }
    renderRecordings();

    function settleAfterMorph() {
        if (targetWrap) targetWrap.style.visibility = "";
        suppressPinboardEmptyStateToggle = false;
        updatePinboardEmptyState();
        // Doesn't set an analysis target itself -- just drops the user
        // into this subject's recordings, dropdown open, ready to pick
        // one (or several, via the multi-select dots + Continue) to
        // actually start analysis. Picking the whole subject as the
        // target is still done via the "Analyze Subject" row-flyout
        // action, same as before.
        openRecordingSelectDropdown();
    }

    if (startRect && targetWrap && targetBtn) {
        // Reveal the dropdown-button wrap invisibly (visibility, not
        // display) so its real position/size is measurable for the
        // morph's later stages, without it flashing into view before
        // the animated dot actually arrives there.
        targetWrap.classList.remove("is-hidden");
        targetWrap.style.visibility = "hidden";
        morphSearchBarToDropdownButton(startRect, targetBtn, settleAfterMorph);
    } else {
        // Fallback: something needed for the animation isn't where
        // expected -- just settle instantly instead of leaving the UI
        // stuck mid-transition.
        settleAfterMorph();
    }

    await loadRecordingsForSubject(s);
    if (selectedSubject === s) renderRecordings();
}

// ================= Search-bar -> dropdown-button morph animation =================
// Runs the visual transition described above pickSubjectFromPicker():
// the search bar collapses in place into a small dot, the dot travels up
// to wherever the real "Select Recording" pill sits, then it expands
// back out to that pill's exact size/shape. All three stages animate a
// single floating ghost element (position:fixed, so it's unaffected by
// the picker panel disappearing partway through) -- the real search bar
// is hidden the instant the ghost appears, and the real pill only
// becomes visible once the ghost reaches its final size, so at no point
// are there two visible copies of either.
let activeSubjectPickerMorphGhost = null;

function morphSearchBarToDropdownButton(startRect, targetBtn, onDone) {
    if (activeSubjectPickerMorphGhost) {
        activeSubjectPickerMorphGhost.remove();
        activeSubjectPickerMorphGhost = null;
    }

    const pickerLayer = container.querySelector("#subjectPickerModalLayer");
    const searchBar = container.querySelector(".subject-picker-search");
    if (searchBar) searchBar.style.visibility = "hidden";

    const ghost = document.createElement("div");
    ghost.className = "subject-picker-morph";
    Object.assign(ghost.style, {
        left: startRect.left + "px",
        top: startRect.top + "px",
        width: startRect.width + "px",
        height: startRect.height + "px",
        borderRadius: "10px",
    });
    document.body.appendChild(ghost);
    activeSubjectPickerMorphGhost = ghost;

    const DOT = 36;
    const centerX = startRect.left + startRect.width / 2;
    const centerY = startRect.top + startRect.height / 2;

    // Runs one leg of the morph: sets how long the *next* style change
    // should take, then (a frame later, so the browser has something
    // painted to transition from) applies that change, resolving once
    // it's done.
    function animateTo(styles, durationMs) {
        return new Promise((resolve) => {
            ghost.style.transitionDuration = durationMs + "ms";
            requestAnimationFrame(() => requestAnimationFrame(() => {
                Object.assign(ghost.style, styles);
            }));
            setTimeout(resolve, durationMs);
        });
    }

    // Stage 1: collapse in place into a small dot, centered on the
    // search bar's own current center point.
    animateTo({
        left: (centerX - DOT / 2) + "px",
        top: (centerY - DOT / 2) + "px",
        width: DOT + "px",
        height: DOT + "px",
        borderRadius: "50%",
    }, 220)
        .then(() => {
            // The search panel's done its job -- hide it as the dot
            // detaches and heads for the button, rather than leaving it
            // sitting there behind the moving dot.
            if (pickerLayer) pickerLayer.classList.add("is-hidden");
            // Stage 2: travel up to the button's center. Measured fresh
            // (not reused from before) in case anything shifted the
            // menubar layout while stage 1 was running.
            const btnRect = targetBtn.getBoundingClientRect();
            return animateTo({
                left: (btnRect.left + btnRect.width / 2 - DOT / 2) + "px",
                top: (btnRect.top + btnRect.height / 2 - DOT / 2) + "px",
            }, 340);
        })
        .then(() => {
            // Stage 3: expand back out to the button's exact rect.
            const btnRect = targetBtn.getBoundingClientRect();
            return animateTo({
                left: btnRect.left + "px",
                top: btnRect.top + "px",
                width: btnRect.width + "px",
                height: btnRect.height + "px",
                borderRadius: "20px",
            }, 220);
        })
        .then(() => {
            ghost.remove();
            if (activeSubjectPickerMorphGhost === ghost) activeSubjectPickerMorphGhost = null;
            onDone();
        });
}

async function deleteSubject(s) {
    try {
        await api.deleteSubject(s.id);
    } catch (err) {
        console.error(err);
        showToast(err.message || "Couldn't delete subject.");
        return;
    }

    const idx = SUBJECTS.findIndex(x => x.id === s.id);
    if (idx !== -1) SUBJECTS.splice(idx, 1);
    delete RECORDINGS[s.id];

    if (selectedSubject && selectedSubject.id === s.id) {
        selectedSubject = null;
        selectedRecording = null;
        currentLevel = "subjects";
        renderLevelChrome();
    }
    if (analysisTargetType === "subject" && analysisTargetRef === s) {
        setAnalysisTarget(null, null);
    }

    renderSubjects();
    renderRecordings();
    showToast(`Deleted ${s.name}.`);
    broadcastProjectDataChanged();
}

async function selectSubject(s) {
    selectedSubject = s;
    selectedRecording = null;
    currentLevel = "recordings";
    renderSubjects();
    renderLevelChrome();
    if (!RECORDINGS[s.id]) {
        recordingsListEl.innerHTML = `<div class="box-empty"><div class="empty-title">Loading&hellip;</div></div>`;
    }
    renderRecordings();
    await loadRecordingsForSubject(s);
    // The user may have navigated elsewhere while this was in flight.
    if (selectedSubject === s) renderRecordings();
}

function renderRecordings() {
    updateRecordingMultiselectBar();
    updatePinboardEmptyState();
    recordingsListEl.innerHTML = "";

    if (!selectedSubject) {
        recordingsListEl.innerHTML = `<div class="box-empty">
            <div class="empty-title">No subject selected</div>
            <div class="empty-desc">Pick a subject to see their recordings.</div>
        </div>`;
        return;
    }

    const loadedRecordings = RECORDINGS[selectedSubject.id];
    // Not loaded because loadRecordingsForSubject deliberately skipped
    // fetching (pendingCrossTabChange -- see there) rather than because a
    // fetch is still in flight (selectSubject already resolves that case
    // by the time this runs -- see its own comment). Show a real message
    // instead of just going blank, so it's clear more data is available.
    if (!loadedRecordings && pendingCrossTabChange) {
        recordingsListEl.innerHTML = `<div class="box-empty">
            <div class="empty-title">Refresh to load</div>
            <div class="empty-desc">Another tab made changes to this project. Refresh to see them.</div>
        </div>`;
        return;
    }

    const recs = (loadedRecordings || []).slice().sort((a, b) => {
        return new Date(b._raw && b._raw.created_at) - new Date(a._raw && a._raw.created_at);
    });
    recs.forEach(rec => {
        const row = document.createElement("div");
        row.className = "recording-row";
        row.innerHTML = `
            <button type="button" class="recording-select-btn${multiSelectedRecordingIds.has(rec.id) ? " selected" : ""}" title="Select recording" aria-label="Select recording">
                <span class="recording-select-dot"></span>
            </button>
            <div class="recording-item${isAnalysisTarget("recording", rec) ? " selected" : ""}">
                <div class="recording-info">
                    <div class="recording-name">${rec.name}</div>
                    <div class="recording-time">${rec.date ? `${rec.date} &middot; ${rec.time}` : rec.time}</div>
                </div>
                <div class="recording-chip ${rec.type === 'custom' ? 'custom' : rec.type === 'uploaded' ? 'uploaded' : ''}">${rec.type === 'custom' ? 'User-defined' : rec.type === 'uploaded' ? 'Uploaded' : 'Live'}</div>
            </div>
        `;
        function pickThisRecording() {
            selectedRecording = rec;
            renderRecordings();
            selectRecordingLabel.textContent = rec.name;
            setAnalysisTarget("recording", rec);
            closeRecordingSelectDropdown();
        }
        row.querySelector(".recording-item").addEventListener("click", pickThisRecording);
        row.querySelector(".recording-select-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            if (multiSelectedRecordingIds.has(rec.id)) {
                multiSelectedRecordingIds.delete(rec.id);
                e.currentTarget.classList.remove("selected");
            } else {
                multiSelectedRecordingIds.add(rec.id);
                e.currentTarget.classList.add("selected");
            }
            updateRecordingMultiselectBar();
        });
        recordingsListEl.appendChild(row);
    });
}

// ================= Sort (cycles through orders on click, no dropdown) =================

const SORT_ORDER = ["name", "date", "age"];
const SORT_LABELS = { name: "Name", date: "Date Added", age: "Age" };

const sortTrigger = container.querySelector("#sort-trigger");
const sortCurrentLabel = container.querySelector("#sort-current-label");

function updateSortLabel() {
    const label = SORT_LABELS[currentSort];
    sortCurrentLabel.textContent = label;
    sortTrigger.title = "Sort: " + label + " (click to change)";
}

sortTrigger.addEventListener("click", () => {
    const idx = SORT_ORDER.indexOf(currentSort);
    currentSort = SORT_ORDER[(idx + 1) % SORT_ORDER.length];
    updateSortLabel();
    renderSubjects();
});

// ---------------------------------------------------------------------
// Add-subject modal (same pattern as the existing Add Patient modal)
// ---------------------------------------------------------------------

const subjectModalOverlay = container.querySelector("#addSubjectOverlay");
const subjectModalForm = container.querySelector("#addSubjectForm");
const subjectModalNameInput = container.querySelector("#subjectNameInput");
const subjectModalIdInput = container.querySelector("#subjectIdInput");
const subjectModalSexInput = container.querySelector("#subjectSexInput");
const subjectModalAgeInput = container.querySelector("#subjectAgeInput");
const subjectModalGroupInput = container.querySelector("#subjectGroupInput");

function openAddSubjectModal() {
    if (subjectModalForm) subjectModalForm.reset();
    if (subjectModalOverlay) subjectModalOverlay.classList.add("visible");
    if (subjectModalNameInput) subjectModalNameInput.focus();
}

function closeAddSubjectModal() {
    if (subjectModalOverlay) subjectModalOverlay.classList.remove("visible");
}

if (subjectModalForm) {
    subjectModalForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const name = subjectModalNameInput.value.trim();
        if (!name) {
            subjectModalNameInput.focus();
            return;
        }

        const payload = {
            id: subjectModalIdInput.value.trim() || null,
            name,
            age: subjectModalAgeInput.value || "",
            sex: subjectModalSexInput.value,
            group: subjectModalGroupInput.value.trim(),
        };

        let created;
        try {
            created = await api.createSubject(payload);
        } catch (err) {
            console.error(err);
            showToast(err.message || "Couldn't add subject.");
            return;
        }

        const newSubject = mapSubject(created);
        SUBJECTS.push(newSubject);

        closeAddSubjectModal();
        renderSubjects();
        broadcastProjectDataChanged();
    });
}

container.querySelector("#addSubjectCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAddSubjectModal();
});

addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape" && subjectModalOverlay && subjectModalOverlay.classList.contains("visible")) {
        closeAddSubjectModal();
    }
});

container.querySelector("#add-subject-btn").addEventListener("click", openAddSubjectModal);

// ---------------------------------------------------------------------
// Add-recording modal (same pattern; task picker with a custom-name
// field that appears when "Custom Task..." is selected)
// ---------------------------------------------------------------------

const recordingModalOverlay = container.querySelector("#addRecordingOverlay");
const recordingModalForm = container.querySelector("#addRecordingForm");
const recordingTaskSelect = container.querySelector("#recordingTaskInput");
const recordingCustomNameField = container.querySelector("#recordingCustomNameField");
const recordingCustomNameInput = container.querySelector("#recordingCustomNameInput");

function updateRecordingCustomFieldVisibility() {
    if (!recordingTaskSelect || !recordingCustomNameField) return;
    const isCustom = recordingTaskSelect.value === "__custom__";
    recordingCustomNameField.style.display = isCustom ? "flex" : "none";
}

recordingTaskSelect?.addEventListener("change", updateRecordingCustomFieldVisibility);

// ---- Task type toggle (Sustained vowel / DDK) in the new-recording modal ----

const taskTypeToggle = container.querySelector("#taskTypeToggle");
const taskPromptLabel = container.querySelector("#taskPromptLabel");
const taskPromptSound = container.querySelector("#taskPromptSound");
const taskDurationValue = container.querySelector("#taskDurationValue");
const taskDurationMinus = container.querySelector("#taskDurationMinus");
const taskDurationPlus = container.querySelector("#taskDurationPlus");
const taskDurationGroup = container.querySelector(".task-duration");

const TASK_TYPE_LABELS = {
    Sustained: "Sustained Vowel /a/",
    DDK: "DDK /pa-ta-ka/",
};

// Short task labels used on the post-recording quality review card
// (distinct from TASK_TYPE_LABELS, which include the phoneme prompt).
const QUALITY_REVIEW_TASK_LABELS = {
    Sustained: "Sustained Vowel",
    DDK: "DDK Task",
};

const TASK_PROMPTS = {
    Sustained: { label: "Hold", sound: "/a/" },
    DDK: { label: "Repeat", sound: "/pa-ta-ka/" },
};

const TASK_DEFAULT_DURATIONS = {
    Sustained: 5,
    DDK: 10,
};

const DURATION_MIN = 1;
const DURATION_MAX = 60;
const DURATION_STEP = 1;

let selectedRecordingTaskType = "Sustained";
let selectedRecordingDuration = TASK_DEFAULT_DURATIONS.Sustained;

function updateDurationDisplay() {
    if (taskDurationValue) taskDurationValue.textContent = selectedRecordingDuration + "s";
    if (taskDurationMinus) taskDurationMinus.disabled = selectedRecordingDuration <= DURATION_MIN;
    if (taskDurationPlus) taskDurationPlus.disabled = selectedRecordingDuration >= DURATION_MAX;
}

function setRecordingDuration(seconds) {
    selectedRecordingDuration = Math.min(DURATION_MAX, Math.max(DURATION_MIN, seconds));
    updateDurationDisplay();
}

function setRecordingTaskType(taskType) {
    if (!TASK_TYPE_LABELS[taskType]) return;
    selectedRecordingTaskType = taskType;

    taskTypeToggle?.querySelectorAll(".task-type-option").forEach((btn) => {
        const isActive = btn.dataset.taskType === taskType;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    const prompt = TASK_PROMPTS[taskType];
    if (taskPromptLabel) taskPromptLabel.textContent = prompt.label;
    if (taskPromptSound) taskPromptSound.textContent = prompt.sound;

    setRecordingDuration(TASK_DEFAULT_DURATIONS[taskType]);
}

taskTypeToggle?.addEventListener("click", (e) => {
    const btn = e.target.closest(".task-type-option");
    if (!btn) return;
    setRecordingTaskType(btn.dataset.taskType);
});

taskDurationMinus?.addEventListener("click", () => {
    setRecordingDuration(selectedRecordingDuration - DURATION_STEP);
});

taskDurationPlus?.addEventListener("click", () => {
    setRecordingDuration(selectedRecordingDuration + DURATION_STEP);
});

// ---- Record button: recording status line + dotted meter + progress bar ----
// No real audio/backend yet — this simulates what recording will look like
// once wired up: a "Recording · <Task> Task" status line with an elapsed
// timer, a row of level ticks that fill in over time, and a progress bar
// that fills up to the chosen duration.

const taskRecordBtn = container.querySelector("#taskRecordBtn");
const taskRecordSlot = container.querySelector("#taskRecordSlot");
const taskPrompt = container.querySelector("#taskPrompt");
const recordingStatusLine = container.querySelector("#recordingStatusLine");
const recordingStatusTaskLabel = container.querySelector("#recordingStatusTaskLabel");
const recordingStatusTimer = container.querySelector("#recordingStatusTimer");
const recordingMeter = container.querySelector("#recordingMeter");
const recordingDottedRow = container.querySelector("#recordingDottedRow");
const recordingProgressFill = container.querySelector("#recordingProgressFill");

const RECORDING_STATUS_LABELS = {
    Sustained: "Sustained",
    DDK: "DDK",
};

const DOT_COUNT = 48;

let isRecordingActive = false;
let recordingRafId = null;
let recordingStartTs = 0;
let dotTickEls = [];

// Placeholder waveform heights (0-1). Not derived from real audio yet —
// this just gives the meter a waveform-like silhouette until live level
// data is wired up. Swap buildDotTicks() for real amplitude data later.
function placeholderWaveformHeights(count) {
    return Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        const envelope = 0.25 + 0.55 * Math.sin(Math.PI * t) ** 0.6;
        const wobble =
            0.5 +
            0.5 * Math.sin(i * 1.7) * Math.sin(i * 0.35 + 1) +
            0.15 * Math.sin(i * 5.1);
        return Math.min(1, Math.max(0.08, envelope * wobble));
    });
}

function buildDotTicks() {
    if (!recordingDottedRow) return;
    recordingDottedRow.innerHTML = "";
    const heights = placeholderWaveformHeights(DOT_COUNT);
    dotTickEls = heights.map((h) => {
        const el = document.createElement("span");
        el.className = "recording-dot-tick";
        el.style.setProperty("--bar-h", h.toFixed(3));
        recordingDottedRow.appendChild(el);
        return el;
    });
}
buildDotTicks();

function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m + ":" + String(s).padStart(2, "0");
}

function setRecordingControlsDisabled(disabled) {
    taskTypeToggle?.querySelectorAll(".task-type-option").forEach((btn) => { btn.disabled = disabled; });
    if (taskDurationMinus) taskDurationMinus.disabled = disabled || selectedRecordingDuration <= DURATION_MIN;
    if (taskDurationPlus) taskDurationPlus.disabled = disabled || selectedRecordingDuration >= DURATION_MAX;
    taskDurationGroup?.classList.toggle("is-disabled", disabled);
}

// The live-recording backend call (POST /api/subjects/{id}/recordings)
// actually captures audio for `duration` seconds server-side, which lines
// up with the local countdown/progress-bar animation below running for
// the same duration -- so the request is fired the moment the visual
// recording starts, and its result is awaited once the animation finishes.
let pendingLiveRecording = null;

function startTaskRecording(prepareToken) {
    if (!taskRecordBtn || isRecordingActive) return;

    isRecordingActive = true;
    recordingStartTs = performance.now();

    const taskLabel = selectedRecordingTaskType === "DDK" ? "DDK" : "Sustained Vowel";
    pendingLiveRecording = selectedSubject
        ? api.addLiveRecording(selectedSubject.id, taskLabel, selectedRecordingDuration, prepareToken)
        : Promise.reject(new Error("Select a subject first."));
    // Swallowed here so an unhandled-rejection warning can't fire before
    // finishTaskRecording gets a chance to inspect the real result below.
    pendingLiveRecording.catch(() => {});

    if (recordingStatusTaskLabel) recordingStatusTaskLabel.textContent = RECORDING_STATUS_LABELS[selectedRecordingTaskType];
    if (recordingStatusTimer) recordingStatusTimer.textContent = formatElapsed(selectedRecordingDuration * 1000);
    if (recordingProgressFill) recordingProgressFill.style.width = "0%";
    dotTickEls.forEach((el) => el.classList.remove("is-filled"));

    taskRecordBtn.classList.add("is-recording");
    taskRecordBtn.title = "Tap to stop recording";
    recordingStatusLine?.classList.add("is-active");
    recordingMeter?.classList.add("is-active");
    setRecordingControlsDisabled(true);
    // Nothing is shown in the record slot while actively recording (the
    // button hides via .is-recording, no countdown/done circle is active),
    // so collapse the slot itself rather than leaving an empty gap.
    if (taskRecordSlot) taskRecordSlot.style.display = "none";

    const totalMs = selectedRecordingDuration * 1000;

    function tick(now) {
        const elapsed = now - recordingStartTs;
        const progress = Math.min(1, elapsed / totalMs);

        if (recordingStatusTimer) recordingStatusTimer.textContent = formatElapsed(totalMs - Math.min(elapsed, totalMs));
        if (recordingProgressFill) recordingProgressFill.style.width = (progress * 100) + "%";

        const filledCount = Math.round(progress * DOT_COUNT);
        dotTickEls.forEach((el, i) => el.classList.toggle("is-filled", i < filledCount));

        if (progress < 1) {
            recordingRafId = requestAnimationFrame(tick);
        } else {
            finishTaskRecording(false);
        }
    }
    recordingRafId = requestAnimationFrame(tick);
}

async function finishTaskRecording(cancelled) {
    if (!isRecordingActive) return;
    isRecordingActive = false;

    if (recordingRafId) cancelAnimationFrame(recordingRafId);
    recordingRafId = null;

    const requestPromise = pendingLiveRecording;
    const subjectAtStart = selectedSubject;
    pendingLiveRecording = null;

    if (taskRecordBtn) {
        taskRecordBtn.classList.remove("is-recording");
        taskRecordBtn.title = "Tap to start recording";
    }
    if (taskRecordSlot) taskRecordSlot.style.display = "";
    recordingStatusLine?.classList.remove("is-active");
    recordingMeter?.classList.remove("is-active");
    setRecordingControlsDisabled(false);
    updateDurationDisplay();

    if (cancelled) {
        showToast("Recording cancelled");
        // The hardware capture (if it actually started) can't be aborted
        // mid-flight -- it keeps recording server-side for the full
        // duration regardless of the button tap. Let that request land in
        // the background and just delete whatever it logged, so a
        // cancelled take never shows up in the recordings list.
        if (requestPromise && subjectAtStart) {
            requestPromise
                .then((row) => api.deleteRecording(subjectAtStart.id, row.recording_id))
                .catch(() => {});
        }
        return;
    }

    // Hide the record button/prompt while the take is under review
    // (either the quality-check flow below, or — if there's no subject
    // to log against — the plain "done" confirmation).
    if (taskRecordBtn) taskRecordBtn.style.display = "none";
    taskPrompt?.classList.add("is-hidden");

    if (!subjectAtStart) {
        showToast("Select a subject first.");
        showRecordingCompleteTick();
        return;
    }

    showQualityCheckLoading();

    let row;
    try {
        row = await requestPromise;
    } catch (err) {
        console.error(err);
        hideQualityCheck();
        if (taskRecordBtn) taskRecordBtn.style.display = "";
        taskPrompt?.classList.remove("is-hidden");
        showToast(err.message || "Recording failed.");
        return;
    }

    const newRecording = mapRecording(row);
    const subjectId = subjectAtStart.id;
    if (!RECORDINGS[subjectId]) RECORDINGS[subjectId] = [];
    RECORDINGS[subjectId].push(newRecording);
    if (selectedSubject && selectedSubject.id === subjectId) {
        selectedRecording = newRecording;
        renderRecordings();
    }
    invalidateSubjectAnalysisCache(subjectId);
    addRecordingLogEntry(newRecording);
    broadcastProjectDataChanged();

    showQualityCheckResult(newRecording);
}

// ---------- Post-recording quality check (chain-of-custody + signal
// quality) ----------
//
// Runs right after a take finishes and before the "Recording complete"
// confirmation: a loading stage while the backend's analysis result is
// awaited, then a review card (real per-recording rating + environment
// copy from quality_classification) where the user keeps (Complete) or
// discards (Re-record) the take.
const qualityCheckOverlay = container.querySelector("#qualityCheckOverlay");
const qualityReviewTaskLabel = container.querySelector("#qualityReviewTaskLabel");
const qualityReviewPercent = container.querySelector("#qualityReviewPercent");
const qualityReviewEnvTitle = container.querySelector("#qualityReviewEnvTitle");
const qualityReviewEnvDesc = container.querySelector("#qualityReviewEnvDesc");
const qualityReviewRerecordBtn = container.querySelector("#qualityReviewRerecordBtn");
const qualityReviewCompleteBtn = container.querySelector("#qualityReviewCompleteBtn");

// Recording Quality percentage tiers -- keep in sync with
// QUALITY_*_PCT in app/quality_thresholds.py.
const QUALITY_PCT_EXCELLENT = 95;
const QUALITY_PCT_GOOD = 90;
const QUALITY_PCT_MODERATE = 85;
const QUALITY_PCT_POOR = 80;

// Recording Quality Rating comes back from the backend as an integer
// percentage (0-100). Older recordings.json rows may still carry the
// legacy "★★★★☆" star string -- map those onto
// the tier percentages so the UI never has to show a star.
function qualityPercentFromRating(rating) {
    if (typeof rating === "number" && isFinite(rating)) return Math.round(Math.max(0, Math.min(100, rating)));
    if (typeof rating === "string") {
        const filled = (rating.match(/★/g) || []).length;
        if (filled) return [0, QUALITY_PCT_POOR - 10, QUALITY_PCT_POOR, QUALITY_PCT_MODERATE, QUALITY_PCT_GOOD, QUALITY_PCT_EXCELLENT][filled] ?? null;
        const n = parseFloat(rating);
        if (isFinite(n)) return Math.round(Math.max(0, Math.min(100, n)));
    }
    return null;
}

function qualityTierClass(pct) {
    if (pct === null) return "quality-pct--unknown";
    if (pct >= QUALITY_PCT_EXCELLENT) return "quality-pct--excellent";
    if (pct >= QUALITY_PCT_GOOD) return "quality-pct--good";
    if (pct >= QUALITY_PCT_MODERATE) return "quality-pct--moderate";
    if (pct >= QUALITY_PCT_POOR) return "quality-pct--poor";
    return "quality-pct--very-poor";
}

function renderQualityPercent(pct) {
    const label = pct === null ? "—" : `${pct}%`;
    return `<span class="quality-pct ${qualityTierClass(pct)}">${label}</span>`;
}

function showQualityCheckLoading() {
    if (!qualityCheckOverlay) return;
    if (qualityReviewTaskLabel) {
        qualityReviewTaskLabel.textContent = QUALITY_REVIEW_TASK_LABELS[selectedRecordingTaskType];
    }
    qualityCheckOverlay.classList.remove("stage-review");
    qualityCheckOverlay.classList.add("is-active", "stage-loading");
}

function showQualityCheckResult(recording) {
    if (!qualityCheckOverlay) {
        showRecordingCompleteTick();
        return;
    }

    const qc = recording._raw && recording._raw.quality_classification;
    if (!qc) {
        // No ambient channel / the quality analysis step failed silently
        // server-side for this take (see api/routes.py) -- skip the
        // review card and fall straight to the plain confirmation.
        hideQualityCheck();
        showRecordingCompleteTick();
        return;
    }

    const pct = qualityPercentFromRating(qc["Recording Quality Rating"]);
    if (qualityReviewPercent) qualityReviewPercent.innerHTML = renderQualityPercent(pct);
    if (qualityReviewEnvTitle) qualityReviewEnvTitle.textContent = qc["Environment"] || "";
    if (qualityReviewEnvDesc) qualityReviewEnvDesc.textContent = qc["Recommendation"] || "";

    qualityCheckOverlay.classList.remove("stage-loading");
    qualityCheckOverlay.classList.add("stage-review");
}

function hideQualityCheck() {
    qualityCheckOverlay?.classList.remove("is-active", "stage-loading", "stage-review");
}

// Shows the brief green-check "Recording complete" confirmation in the
// record button's spot, then reveals the button and prompt again.
function showRecordingCompleteTick() {
    if (taskRecordBtn) taskRecordBtn.style.display = "none";
    taskPrompt?.classList.add("is-hidden");
    taskDoneCircle?.classList.add("is-active");
    taskDoneLabel?.classList.add("is-active");
    showToast("Recording captured & logged");
    clearTimeout(doneOverlayTimeoutId);
    doneOverlayTimeoutId = setTimeout(() => {
        taskDoneCircle?.classList.remove("is-active");
        taskDoneLabel?.classList.remove("is-active");
        if (taskRecordBtn) taskRecordBtn.style.display = "";
        taskPrompt?.classList.remove("is-hidden");
    }, 1400);
}

// Discards the take just logged (user chose Re-record on the quality
// review card): deletes it from the backend too, so it doesn't linger in
// storage or count toward the subject's mean/SD, then returns the panel
// to its ready-to-record state.
async function discardLastRecordingAndReset() {
    if (selectedSubject) {
        const subjectId = selectedSubject.id;
        const list = RECORDINGS[subjectId];
        if (list && list.length) {
            const removed = list.pop();
            try {
                await api.deleteRecording(subjectId, removed.id);
            } catch (err) {
                console.error(err);
            }
            selectedRecording = list.length ? list[list.length - 1] : null;
            if (analysisTargetType === "recording" && analysisTargetRef === removed) {
                setAnalysisTarget(null, null);
            }
            if (selectedSubject && selectedSubject.id === subjectId) renderRecordings();
            invalidateSubjectAnalysisCache(subjectId);
            removeLastRecordingLogEntry();
            broadcastProjectDataChanged();
        }
    }
    if (taskRecordBtn) taskRecordBtn.style.display = "";
    taskPrompt?.classList.remove("is-hidden");
    showToast("Recording discarded — try again");
}

qualityReviewCompleteBtn?.addEventListener("click", () => {
    hideQualityCheck();
    showRecordingCompleteTick();
});

qualityReviewRerecordBtn?.addEventListener("click", () => {
    hideQualityCheck();
    discardLastRecordingAndReset();
});

const taskCountdownCircle = container.querySelector("#taskCountdownCircle");
const taskCountdownNumber = container.querySelector("#taskCountdownNumber");
const taskCountdownLabel = container.querySelector("#taskCountdownLabel");
const taskDoneCircle = container.querySelector("#taskDoneCircle");
const taskDoneLabel = container.querySelector("#taskDoneLabel");
let doneOverlayTimeoutId = null;

let countdownTimeoutId = null;
let isCountingDown = false;

// Holds the in-flight (or resolved) api.prepareRecording() promise for
// the countdown currently running, so cancelPreRecordCountdown can
// release it if the user backs out before it's consumed.
let pendingPrepareToken = null;
let pendingPreparePromise = null;

function runPreRecordCountdown(onDone) {
    // If the warm-up below fails (e.g. the serial port won't open
    // because the device isn't connected), we abort the countdown
    // and report it right away instead of letting the countdown +
    // recording animation play out for several more seconds only to
    // fail at the very end.
    let aborted = false;

    // Kick the serial warm-up off immediately, in parallel with the
    // visible countdown, instead of waiting until the countdown ends
    // to open+settle the connection. The device's ~2s settle time
    // then happens *during* the countdown the user is already looking
    // at, rather than as an invisible delay after it -- which is what
    // previously made real recording start (and, since a fixed
    // duration's worth of samples gets read, end) run late relative
    // to the on-screen countdown/progress bar. It also means a
    // hardware failure is caught right here, up front.
    pendingPrepareToken = null;
    pendingPreparePromise = api.prepareRecording()
        .then((res) => { pendingPrepareToken = res && res.token; return pendingPrepareToken; })
        .catch((err) => {
            aborted = true;
            pendingPreparePromise = null;
            pendingPrepareToken = null;
            cancelPreRecordCountdown();
            showToast(err.message || "Recording hardware not available.");
            return null;
        });

    if (!taskCountdownCircle || !taskCountdownNumber) {
        pendingPreparePromise.then((token) => { if (!aborted) onDone(token); });
        return;
    }

    isCountingDown = true;
    let count = 3;

    clearTimeout(doneOverlayTimeoutId);
    taskDoneCircle?.classList.remove("is-active");
    taskDoneLabel?.classList.remove("is-active");
    if (taskRecordBtn) taskRecordBtn.style.display = "none";
    setRecordingControlsDisabled(true);
    taskCountdownNumber.textContent = String(count);
    taskCountdownCircle.classList.add("is-active");
    taskCountdownLabel?.classList.add("is-active");

    function step() {
        if (aborted) return;
        count -= 1;
        if (count > 0) {
            taskCountdownNumber.textContent = String(count);
            // restart the pop animation on each tick
            taskCountdownNumber.style.animation = "none";
            void taskCountdownNumber.offsetWidth;
            taskCountdownNumber.style.animation = "";
            countdownTimeoutId = setTimeout(step, 1000);
        } else {
            taskCountdownCircle.classList.remove("is-active");
            taskCountdownLabel?.classList.remove("is-active");
            if (taskRecordBtn) taskRecordBtn.style.display = "";
            isCountingDown = false;
            countdownTimeoutId = null;
            // The countdown's own 3s normally comfortably outlasts the
            // ~2s warm-up, so this resolves immediately in practice --
            // it only actually waits if the warm-up is unusually slow,
            // which is the correct tradeoff: better to hold the
            // "recording" state a beat than to start it before the mic
            // is really ready.
            const preparePromise = pendingPreparePromise;
            pendingPreparePromise = null;
            if (!preparePromise) return; // already aborted above
            preparePromise.then((token) => {
                pendingPrepareToken = null;
                if (!aborted) onDone(token);
            });
        }
    }
    countdownTimeoutId = setTimeout(step, 1000);
}

function cancelPreRecordCountdown() {
    if (pendingPreparePromise) {
        pendingPreparePromise.then((token) => {
            if (token) api.releaseRecordingPrepare(token).catch(() => {});
        });
        pendingPreparePromise = null;
    } else if (pendingPrepareToken) {
        api.releaseRecordingPrepare(pendingPrepareToken).catch(() => {});
    }
    pendingPrepareToken = null;

    if (!isCountingDown) return;
    isCountingDown = false;
    if (countdownTimeoutId) clearTimeout(countdownTimeoutId);
    countdownTimeoutId = null;
    taskCountdownCircle?.classList.remove("is-active");
    taskCountdownLabel?.classList.remove("is-active");
    if (taskRecordBtn) taskRecordBtn.style.display = "";
    setRecordingControlsDisabled(false);
}

taskRecordBtn?.addEventListener("click", () => {
    if (isRecordingActive || isCountingDown) {
        finishTaskRecording(true);
        cancelPreRecordCountdown();
    } else {
        runPreRecordCountdown(startTaskRecording);
    }
});

// The record button is hidden while recording (see .task-record-btn.is-recording),
// so the status line itself becomes the tap target to stop.
recordingStatusLine?.addEventListener("click", () => {
    if (isRecordingActive) finishTaskRecording(true);
});

function openAddRecordingModal() {
    if (!selectedSubject) {
        showToast("Select a subject first.");
        return;
    }
    // A review card left over from a previous take must never survive
    // into a new modal: its Re-record button deletes the CURRENT
    // subject's last recording.
    hideQualityCheck();
    if (taskRecordBtn) taskRecordBtn.style.display = "";
    taskPrompt?.classList.remove("is-hidden");
    if (recordingModalForm) recordingModalForm.reset();
    updateRecordingCustomFieldVisibility();
    setRecordingTaskType("Sustained");
    clearRecordingLog();
    if (recordingModalOverlay) recordingModalOverlay.classList.add("visible");
    if (recordingTaskSelect) recordingTaskSelect.focus();
}

function closeAddRecordingModal() {
    finishTaskRecording(true);
    hideQualityCheck();
    if (recordingModalOverlay) recordingModalOverlay.classList.remove("visible");
}

function formatRecordingTime(date) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatRecordingDate(date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---- Live recording log (top-left box in the New Recording modal) ----
// Shows the takes captured during this modal visit, newest first.
// Populated as each recording lands (finishTaskRecording), trimmed if the
// user discards a take on the quality review card (discardLastRecordingAndReset).
const recordingLogBox = container.querySelector("#recordingLogBox");
const recordingLogList = container.querySelector("#recordingLogList");
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRASH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10zM10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function updateRecordingLogEmptyState() {
    if (!recordingLogBox || !recordingLogList) return;
    recordingLogBox.classList.toggle("is-empty", recordingLogList.children.length === 0);
}

function addRecordingLogEntry(recording) {
    if (!recordingLogList) return;
    const li = document.createElement("li");
    li.className = "recording-log-item";
    const label = recording.name || TASK_TYPE_LABELS[selectedRecordingTaskType] || "Recording";
    const time = recording.time || formatRecordingTime(new Date());
    li.innerHTML = `
        <div class="recording-log-item-main">
            <span class="recording-log-item-check">${CHECK_ICON_SVG}</span>
            <span class="recording-log-item-name">${label}</span>
        </div>
        <div class="recording-log-item-right">
            <span class="recording-log-item-time">${time}</span>
            <button type="button" class="recording-log-item-delete" title="Delete recording" aria-label="Delete recording">${TRASH_ICON_SVG}</button>
        </div>
    `;
    li.querySelector(".recording-log-item-delete")?.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteRecordingLogEntry(recording, li);
    });
    // column-reverse list, so prepending in DOM order puts the newest at
    // the bottom of the source but the top of the rendered list.
    recordingLogList.appendChild(li);
    updateRecordingLogEmptyState();
}

function removeLastRecordingLogEntry() {
    if (!recordingLogList || !recordingLogList.lastElementChild) return;
    recordingLogList.lastElementChild.remove();
    updateRecordingLogEmptyState();
}

// Deletes a single logged recording via its own trash button (as opposed
// to removeLastRecordingLogEntry, which only ever trims the most recent
// take from the Re-record flow). Mirrors discardLastRecordingAndReset's
// cleanup — backend delete, RECORDINGS/selection/analysis-cache upkeep —
// but works for any entry in the log, not just the last one.
async function deleteRecordingLogEntry(recording, li) {
    if (!recording || !recording.id) return;
    const subjectId = recording.subjectId;
    try {
        await api.deleteRecording(subjectId, recording.id);
    } catch (err) {
        console.error(err);
        showToast(err.message || "Couldn't delete recording.");
        return;
    }
    const list = RECORDINGS[subjectId];
    if (list) {
        const idx = list.indexOf(recording);
        if (idx !== -1) list.splice(idx, 1);
    }
    if (multiSelectedRecordingIds.delete(recording.id)) updateRecordingMultiselectBar();
    if (selectedRecording === recording) {
        selectedRecording = list && list.length ? list[list.length - 1] : null;
    }
    if (analysisTargetType === "recording" && analysisTargetRef === recording) {
        setAnalysisTarget(null, null);
    }
    if (selectedSubject && selectedSubject.id === subjectId) renderRecordings();
    invalidateSubjectAnalysisCache(subjectId);
    li.remove();
    updateRecordingLogEmptyState();
    showToast("Recording deleted");
    broadcastProjectDataChanged();
}

function clearRecordingLog() {
    if (!recordingLogList) return;
    recordingLogList.innerHTML = "";
    updateRecordingLogEmptyState();
}

if (recordingModalForm) {
    recordingModalForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!selectedSubject) return;

        const isCustom = recordingTaskSelect.value === "__custom__";
        const name = isCustom
            ? recordingCustomNameInput.value.trim()
            : (recordingTaskSelect.value || TASK_TYPE_LABELS[selectedRecordingTaskType]);

        if (!name) {
            recordingCustomNameInput.focus();
            return;
        }

        const newRecording = {
            name,
            time: formatRecordingTime(new Date()),
            type: isCustom ? "custom" : "built-in",
            duration: selectedRecordingDuration,
        };

        const subjectId = selectedSubject.id;
        if (!RECORDINGS[subjectId]) RECORDINGS[subjectId] = [];
        RECORDINGS[subjectId].push(newRecording);

        closeAddRecordingModal();
        selectedRecording = newRecording;
        renderRecordings();
    });
}

container.querySelector("#recordingModalBack")?.addEventListener("click", closeAddRecordingModal);

// "Extract Features" button (top-right of the recording modal, same row
// as Back) -- batch-runs preprocessing + feature extraction over every
// recording this subject has logged that's still pending it. Takes
// are logged with features={} the instant they're quality-confirmed
// (see add_live_recording in api/routes.py), so this is what actually
// gets them analyzed and reflected in the main Sustained/DDK views.
const recordingModalExtractBtn = container.querySelector("#recordingModalExtractBtn");
const recordingModalExtractBtnLabel = container.querySelector("#recordingModalExtractBtnLabel");

recordingModalExtractBtn?.addEventListener("click", async () => {
    if (!selectedSubject || recordingModalExtractBtn.disabled) return;
    const subjectId = selectedSubject.id;

    recordingModalExtractBtn.disabled = true;
    recordingModalExtractBtn.classList.add("is-extracting");
    if (recordingModalExtractBtnLabel) recordingModalExtractBtnLabel.textContent = "Extracting…";

    try {
        const result = await api.extractSubjectFeatures(subjectId);
        const updatedCount = result?.updated?.length || 0;
        const errorCount = result?.errors?.length || 0;

        if (updatedCount > 0) {
            await loadRecordingsForSubject(selectedSubject, { force: true });
            if (selectedSubject && selectedSubject.id === subjectId) renderRecordings();
            invalidateSubjectAnalysisCache(subjectId);
        }

        if (errorCount > 0) {
            showToast(updatedCount > 0
                ? `Extracted ${updatedCount} recording${updatedCount === 1 ? "" : "s"}, ${errorCount} failed`
                : "Feature extraction failed for all pending recordings");
        } else if (updatedCount > 0) {
            showToast(`Extracted ${updatedCount} recording${updatedCount === 1 ? "" : "s"}`);
        } else {
            showToast("No recordings pending extraction");
        }

        // Extraction ran to completion (whether or not every recording
        // succeeded) -- close the recording window now that the user's
        // been told the outcome. A thrown/network error skips this and
        // leaves the modal open so they can retry.
        closeAddRecordingModal();
    } catch (err) {
        console.error(err);
        showToast(err.message || "Couldn't extract features.");
    } finally {
        recordingModalExtractBtn.disabled = false;
        recordingModalExtractBtn.classList.remove("is-extracting");
        if (recordingModalExtractBtnLabel) recordingModalExtractBtnLabel.textContent = "Extract Features";
    }
});


addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape" && recordingModalOverlay && recordingModalOverlay.classList.contains("visible")) {
        closeAddRecordingModal();
    }
});

// ---- New-recording flyout: + button opens a sideways menu with
// "Live Recording" (existing modal flow) and "Upload" (UI only, not
// wired up yet). ----

const addRecordingFlyout = container.querySelector("#add-recording-flyout");

function openAddRecordingFlyout() {
    addRecordingFlyout.classList.add("open");
}

function closeAddRecordingFlyout() {
    addRecordingFlyout.classList.remove("open");
}

addRecordingBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!selectedSubject) {
        showToast("Select a subject first.");
        return;
    }
    if (addRecordingFlyout.classList.contains("open")) {
        closeAddRecordingFlyout();
    } else {
        openAddRecordingFlyout();
    }
});

container.querySelector("#add-recording-live-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    closeAddRecordingFlyout();
    openAddRecordingModal();
});

container.querySelector("#add-recording-upload-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    closeAddRecordingFlyout();
    openUploadTaskModal();
});

// ---------------------------------------------------------------------
// Upload flow: task-type picker modal -> native file picker -> POST to
// the upload endpoint. All files picked in one go share the same task
// type (the backend's upload endpoint takes one `task` per call).
// ---------------------------------------------------------------------

const uploadTaskOverlay = container.querySelector("#uploadTaskOverlay");
const uploadTaskTypeToggle = container.querySelector("#uploadTaskTypeToggle");
const uploadTaskCancelBtn = container.querySelector("#uploadTaskCancel");
const uploadTaskContinueBtn = container.querySelector("#uploadTaskContinue");
const uploadRecordingInput = container.querySelector("#uploadRecordingInput");

let uploadTaskType = "Sustained";

function setUploadTaskType(taskType) {
    uploadTaskType = taskType;
    uploadTaskTypeToggle?.querySelectorAll(".task-type-option").forEach((btn) => {
        const isActive = btn.dataset.taskType === taskType;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
}

uploadTaskTypeToggle?.addEventListener("click", (e) => {
    const btn = e.target.closest(".task-type-option");
    if (!btn) return;
    setUploadTaskType(btn.dataset.taskType);
});

function openUploadTaskModal() {
    if (!selectedSubject) {
        showToast("Select a subject first.");
        return;
    }
    setUploadTaskType("Sustained");
    uploadTaskOverlay?.classList.add("visible");
}

function closeUploadTaskModal() {
    uploadTaskOverlay?.classList.remove("visible");
}

uploadTaskCancelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeUploadTaskModal();
});

addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape" && uploadTaskOverlay && uploadTaskOverlay.classList.contains("visible")) {
        closeUploadTaskModal();
    }
});

uploadTaskOverlay?.addEventListener("click", (e) => e.stopPropagation());

uploadTaskContinueBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeUploadTaskModal();
    uploadRecordingInput.value = "";
    uploadRecordingInput.click();
});

uploadRecordingInput?.addEventListener("change", async () => {
    const files = uploadRecordingInput.files;
    if (!files || !files.length || !selectedSubject) return;

    const subjectId = selectedSubject.id;
    const taskLabel = uploadTaskType === "DDK" ? "DDK" : "Sustained Vowel";
    showToast(`Uploading ${files.length} recording${files.length > 1 ? "s" : ""}\u2026`, {
        loading: true,
        persistent: true,
    });

    let created;
    try {
        created = await api.uploadRecordings(subjectId, taskLabel, files);
    } catch (err) {
        console.error(err);
        showToast(err.message || "Upload failed.");
        return;
    }

    // Server returns { created: [...], errors: [...] }, not a bare array.
    const createdRows = Array.isArray(created) ? created : (created && created.created) || [];
    const uploadErrors = (created && !Array.isArray(created) && created.errors) || [];
    const newRecordings = createdRows.map(mapRecording);
    if (!RECORDINGS[subjectId]) RECORDINGS[subjectId] = [];
    RECORDINGS[subjectId].push(...newRecordings);
    if (selectedSubject && selectedSubject.id === subjectId) renderRecordings();
    invalidateSubjectAnalysisCache(subjectId);
    if (uploadErrors.length) {
        console.error("Upload errors:", uploadErrors);
        showToast(`${newRecordings.length} uploaded, ${uploadErrors.length} failed: ${uploadErrors.map(e => e.filename).join(", ")}`);
    } else {
        showToast(`${newRecordings.length} recording${newRecordings.length > 1 ? "s" : ""} uploaded & logged`);
    }
    broadcastProjectDataChanged();
});

addRecordingFlyout.addEventListener("click", (e) => e.stopPropagation());

addDocListener("click", () => {
    if (!isTabActive()) return;
    closeAddRecordingFlyout();
});

addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape") closeAddRecordingFlyout();
});

// ================= Recording-select dropdown (Subjects -> Recordings
// drill-down, opened from the menubar) =================

const selectRecordingBtn = container.querySelector("#select-recording-btn");
const selectRecordingLabel = container.querySelector("#select-recording-label");
const recordingSelectDropdown = container.querySelector("#recording-select-dropdown");

updateWidgetButtonsAvailability();

// Set while the .closing animation (see recordingDropdownClose in
// subjects.css) is in flight, so a fast reopen can cancel it cleanly
// instead of leaving a stale animationend listener around or fighting
// the close animation for control of opacity/transform.
let recordingDropdownCloseHandler = null;

function openRecordingSelectDropdown() {
    container.querySelectorAll(".menubar-menu.open").forEach(m => m.classList.remove("open"));
    if (typeof closeAllTypeDropdownsFn === "function") closeAllTypeDropdownsFn();
    if (recordingDropdownCloseHandler) {
        recordingSelectDropdown.removeEventListener("animationend", recordingDropdownCloseHandler);
        recordingDropdownCloseHandler = null;
    }
    recordingSelectDropdown.classList.remove("closing");
    recordingSelectDropdown.classList.add("open");
    updateRecordingMultiselectBar();
}

function closeRecordingSelectDropdown() {
    // Guard against the many unconditional call sites (outside click,
    // Escape, etc.) re-triggering the close animation on an already-
    // closed (or already-closing) panel.
    if (!recordingSelectDropdown.classList.contains("open")) return;
    recordingSelectDropdown.classList.remove("open");
    recordingSelectDropdown.classList.add("closing");
    if (recordingMultiselectBar) recordingMultiselectBar.classList.remove("open");
    // Closing without pressing "Continue" discards any tentative dot
    // clicks -- revert to whatever's actually the committed target so
    // reopening the dropdown later doesn't show stale selections.
    syncMultiSelectFromTarget();
    renderRecordings();

    recordingDropdownCloseHandler = () => {
        recordingSelectDropdown.classList.remove("closing");
        recordingDropdownCloseHandler = null;
    };
    recordingSelectDropdown.addEventListener("animationend", recordingDropdownCloseHandler, { once: true });
}
closeRecordingSelectDropdownFn = closeRecordingSelectDropdown;

selectRecordingBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = recordingSelectDropdown.classList.contains("open");
    if (isOpen) {
        closeRecordingSelectDropdown();
    } else {
        openRecordingSelectDropdown();
    }
});

recordingSelectDropdown.addEventListener("click", (e) => e.stopPropagation());

// ---- Search filtering (still mock data, but the search box now actually
// filters it) --------------------------------------------------------
// Panel opens onto just the search bar, vertically centered (idle) --
// typing narrows .subject-picker-group rows down to name/id/group
// matches, and the search bar animates up to its pinned top position to
// make room for the results (or the "no matches" hint). Filtering runs
// on every keystroke ("input"), no Enter needed.
(function () {
    const searchInput = container.querySelector("#subjectPickerSearchInput");
    const modal = container.querySelector("#subjectPickerModal");
    const searchWrap = container.querySelector(".subject-picker-search");
    const list = container.querySelector("#subjectPickerList");
    const hint = container.querySelector("#subjectPickerHint");
    if (!searchInput || !modal || !searchWrap || !list || !hint) return;

    // Moves the search bar between its idle (auto-margin, vertically
    // centered) and searching (pinned near the top) positions with a
    // FLIP transform -- CSS can't transition a margin to/from "auto", so
    // instead: measure where the bar is now, flip the class (which jumps
    // it to its new CSS position), measure again, then animate a
    // transform from the old visual spot back to zero.
    // Moves the search bar between its idle (auto-margin, vertically
    // centered + a small upward nudge) and searching (pinned near the
    // top) positions with a FLIP transform -- CSS can't transition a
    // margin to/from "auto", so instead: measure where the bar is now,
    // clear any transform override and flip the class (landing it at its
    // new CSS-driven position, idle nudge included), measure again, then
    // animate a transform from the old visual spot back down to
    // whatever the class itself specifies (cleared inline transform, not
    // a hardcoded translateY(0)) -- that way a future change to the idle
    // nudge in subjects.css doesn't need any matching change here.
    function setSearching(isSearching) {
        if (modal.classList.contains("is-searching") === isSearching) return;
        const before = searchWrap.getBoundingClientRect().top;

        searchWrap.style.transition = "none";
        searchWrap.style.transform = "";
        modal.classList.toggle("is-searching", isSearching);
        const after = searchWrap.getBoundingClientRect().top;

        const delta = before - after;
        if (!delta) return;

        searchWrap.style.transform = `translateY(${delta}px)`;
        void searchWrap.offsetHeight; // force reflow before re-enabling the transition
        searchWrap.style.transition = "transform .22s ease";
        searchWrap.style.transform = "";
    }

    function filterSubjectPickerRows() {
        // Rows are rebuilt from scratch by renderSubjectPicker() whenever
        // SUBJECTS changes, so this is re-queried on every call instead of
        // captured once -- a stale reference here would keep filtering rows
        // that got thrown away on the last rebuild.
        const groups = Array.from(container.querySelectorAll(".subject-picker-group"));
        const query = searchInput.value.trim().toLowerCase();
        setSearching(!!query);

        if (!query) {
            list.classList.remove("has-matches");
            hint.classList.remove("visible");
            groups.forEach((g) => g.classList.remove("picker-row-hidden"));
            return;
        }

        let anyMatch = false;
        groups.forEach((group) => {
            const name = group.querySelector(".subject-picker-name")?.textContent.toLowerCase() || "";
            const sub = group.querySelector(".subject-picker-sub")?.textContent.toLowerCase() || "";
            const matches = name.includes(query) || sub.includes(query);
            group.classList.toggle("picker-row-hidden", !matches);
            if (matches) anyMatch = true;
        });

        list.classList.toggle("has-matches", anyMatch);
        hint.classList.toggle("visible", !anyMatch);
        if (!anyMatch) hint.textContent = "No subjects match your search";
    }

    searchInput.addEventListener("input", filterSubjectPickerRows);
    filterSubjectPickerRows(); // idle state on load

    // Exposed so renderSubjectPicker() (which rebuilds the rows whenever
    // SUBJECTS changes) can re-apply whatever's currently typed, instead
    // of a rebuild silently dropping the active filter.
    refreshSubjectPickerFilterFn = filterSubjectPickerRows;
})();

function isInsideOpenModal(target) {
    if (!target.closest) return false;
    const overlay = target.closest(".subject-modal-overlay");
    return !!(overlay && overlay.classList.contains("visible"));
}

addDocListener("click", (e) => {
    if (!isTabActive()) return;
    // Any click inside an open modal (backdrop or panel) shouldn't do
    // anything else — in particular it shouldn't close the
    // recording-select dropdown.
    if (isInsideOpenModal(e.target)) return;
    closeRecordingSelectDropdown();
});

addDocListener("keydown", (e) => {
    if (!isTabActive()) return;
    if (e.key === "Escape") closeRecordingSelectDropdown();
});

// ================= Titlebar controls (menubar, hamburger accordion,
// theme toggle, window minimize/maximize/close, Export) have all moved
// to the shared shell (UI/shell.html + UI/js/shell.js) -- this page is
// now pure tab CONTENT with no titlebar of its own, so none of those
// elements exist here anymore. See shell.js for that wiring.


// ================= Pinboard: draggable / resizable / pinnable widgets =================
// Widgets (Values, Quality, Graph) are dropped onto the pinboard (#nav-strip)
// via their respective buttons. Each widget can be dragged around, resized
// from its bottom-right corner, and pinned in place.

(function () {
    const board = container.querySelector("#nav-strip");
    if (!board) return;

    // Every ResizeObserver created below (one per rendered spectrogram
    // widget) is tracked here so pinboardWidgetsCleanupFn can disconnect
    // all of them on destroy() -- otherwise each one keeps watching a
    // canvas indefinitely, even after this tab and its DOM are gone.
    const pinboardResizeObservers = [];
    pinboardWidgetsCleanupFn = function () {
        pinboardResizeObservers.forEach((ro) => ro.disconnect());
        pinboardResizeObservers.length = 0;
    };
    // Widgets are parented to this pannable/zoomable layer instead of the
    // board itself (see the pan/zoom IIFE below), so they move and scale
    // along with the camera. Falls back to the board for safety if the
    // layer is somehow missing from the page.
    const canvas = container.querySelector("#pinboard-canvas") || board;

    // Exposed so the analysis-target logic (subject/recording
    // selection) can clear the board whenever what's being analyzed
    // changes — every widget (Values, Quality, and Graph alike) is scoped
    // to whatever subject/recording is currently selected, so none
    // of them should linger once the user picks a different target.
    clearPinboardWidgetsFn = function () {
        board.querySelectorAll(".pinboard-widget").forEach(w => w.remove());
        updatePinboardEmptyState();
        // Widgets removed this way (target switch) don't go through the
        // close button, so nothing else clears the is-open highlight --
        // do it here for every graph button (legacy toolbar ids, plus
        // whatever graph buttons the sidebar currently has rendered) so
        // it doesn't linger lit up for a widget that no longer exists.
        Object.values(GRAPH_BUTTON_IDS).forEach((btnId) => {
            const btn = container.querySelector("#" + btnId);
            if (btn) btn.classList.remove("is-open");
        });
        container.querySelectorAll(".sidebar-graph-btn.is-open").forEach((btn) => {
            btn.classList.remove("is-open");
        });
    };

    const WIDGET_W = 220;
    const WIDGET_H = 160;
    const MIN_W = 200;
    const MIN_H = 140;

    // Values/Quality widgets are sized to their content's natural
    // (max-content) width, which packs the label/value columns too
    // tightly. This adds extra breathing room on top of that natural
    // width — applied everywhere a metric-type widget's width gets
    // measured, so wider content still ends up proportionally wider.
    const METRIC_WIDTH_BUFFER = 60;

    let widgetCount = 0;
    let zCounter = 1;

    // Widgets always spawn at a fixed starting spot on the board — no
    // memory of where the previous widget landed. The user can drag each
    // one wherever they like after it appears.
    const SPAWN_LEFT = 16;
    const SPAWN_TOP = 16;

    // Metric rows shown inside each Values/Quality widget type. Labels only
    // for now — actual figures get wired up once the backend is connected.
    //
    // Values' two keys ARE its task types (Sustained/DDK) -- this is
    // already filtered by getAvailableTaskTypesForTarget() up top (see
    // the Values dropdown filtering in updateWidgetButtonsAvailability
    // and the direct-select bypass in getDirectRecordingValueType()).
    // Quality's four keys (Overall/SNR/RMS/Ambient) are all task-
    // agnostic ("Both") -- recording quality isn't Sustained- or
    // DDK-specific, so none of them need that filtering.
    const WIDGET_METRICS = {
        Values: {
            Sustained: ["F0 Mean", "F0 Min", "F0 Max", "F1 Mean", "F2 Mean", "HNR", "Jitter Local"],
            DDK: ["DDK Repetition Count", "DDK Repetition Rate", "DDK Interval Mean", "DDK Regularity", "Speech Rate", "Pause/Speech Ratio", "DDK Interval Std"],
        },
        Quality: {
            "Overall": ["Recording Quality Rating", "Recording Quality Score", "Environment", "Recommendation", "Confidence"],
            "SNR/Signal": ["Cross-Channel SNR (dB)", "WADA SNR (dB)", "Mean Segmental SNR (dB)", "Minimum Segmental SNR (dB)", "Low-SNR Frame Percentage"],
            "RMS/Noise/Clipping": ["Patient RMS", "Ambient RMS", "Noise Floor (linear)", "Noise Floor (dB)", "Patient Clipping (%)", "Ambient Clipping (%)", "Clipping Detected", "Silence Percentage", "Silence Detected"],
            "Ambient/Spectral": ["Ambient RMS", "Ambient Peak", "Noise Floor", "Spectral Centroid", "Spectral Flatness"],
        },
    };

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    // Computes the metric values a Values/Quality widget should show right
    // now, based on the current analysis target (subject/recording
    // — see setAnalysisTarget/analysisTargetRef above). "recording" targets
    // read straight from the recording row's own data (already fetched with
    // the recordings list); "subject" targets read from the
    // lazily-fetched ref._summary (see ensureAnalysisSummary) and may not be
    // populated yet, in which case rows just fall back to the em-dash.
    function getWidgetValuesSync(widgetTitle, valueType) {
        if (!analysisTargetType || !analysisTargetRef) return {};

        if (widgetTitle === "Values") {
            const metrics = (WIDGET_METRICS.Values[valueType] || []);
            const values = {};

            if (analysisTargetType === "recording") {
                const features = (analysisTargetRef._raw && analysisTargetRef._raw.features) || {};
                metrics.forEach(key => { values[key] = formatRawValue(features[key]); });
                return values;
            }

            // subject — mean ± SD summary
            const summary = analysisTargetRef._summary;
            if (!summary) return values;
            const meanKey = valueType === "DDK" ? "ddk_mean" : "vowel_mean";
            const sdKey = valueType === "DDK" ? "ddk_sd" : "vowel_sd";
            const mean = summary[meanKey] || {};
            const sd = summary[sdKey] || {};
            metrics.forEach(key => { values[key] = formatMeanSd(mean[key], sd[key]); });
            return values;
        }

        if (widgetTitle === "Quality") {
            // Quality is only ever shown for a single-recording target (the
            // "Quality" pinboard button itself is hidden otherwise).
            if (analysisTargetType !== "recording") return {};
            const raw = analysisTargetRef._raw || {};
            const values = {};
            let source = {};
            let metrics = [];
            if (valueType === "Overall") {
                source = raw.quality_classification || {};
                metrics = WIDGET_METRICS.Quality.Overall;
            } else if (valueType === "SNR/Signal" || valueType === "RMS/Noise/Clipping") {
                source = raw.quality_metrics || {};
                metrics = WIDGET_METRICS.Quality[valueType];
            } else if (valueType === "Ambient/Spectral") {
                source = raw.ambient_metrics || {};
                metrics = WIDGET_METRICS.Quality["Ambient/Spectral"];
            }
            metrics.forEach(key => {
                if (key === "Recording Quality Rating") {
                    const pct = qualityPercentFromRating(source[key]);
                    values[key] = pct === null ? "—" : `${pct}%`;
                } else {
                    values[key] = formatRawValue(source[key]);
                }
            });
            return values;
        }

        return {};
    }

    // ---- Live data accessors for graph widgets ----
    //
    // Every graph used to render from two hardcoded stand-in objects
    // regardless of what was actually being analyzed. These accessors
    // replace that: they read the SAME underlying values (features on
    // _raw for a single recording, vowel_mean/ddk_mean on _summary for
    // a subject) already used by getWidgetValuesSync() above,
    // so a graph and the matching Values widget can never disagree —
    // and because _summary is a live mean/SD rollup across every
    // recording in the subject (recomputed on every fetch, see
    // compute_date_summary()/compute_subject_summary() in
    // app/recording_store.py), a graph on a subject target
    // automatically reflects newly added/removed recordings the next
    // time it re-renders (see refreshAllWidgetValues() below, which
    // now re-renders open graph widgets too, not just Values/Quality).
    //
    // Return null when there's nothing to plot yet (no target picked,
    // or the relevant features/summary aren't loaded/present) —
    // callers must handle that by showing an empty state (see
    // graphEmptyStateHTML) rather than rendering stale or fake numbers.
    function getSustainedValuesForTarget() {
        if (!analysisTargetType || !analysisTargetRef) return null;
        const source = analysisTargetType === "recording"
            ? (analysisTargetRef._raw && analysisTargetRef._raw.features)
            : (analysisTargetRef._summary && analysisTargetRef._summary.vowel_mean);
        if (!source || Object.keys(source).length === 0) return null;
        return {
            f0Mean: source["F0 Mean"], f0Min: source["F0 Min"], f0Max: source["F0 Max"],
            f1Mean: source["F1 Mean"], f2Mean: source["F2 Mean"],
            hnr: source["HNR"], jitterLocal: source["Jitter Local"],
        };
    }

    function getDdkValuesForTarget() {
        if (!analysisTargetType || !analysisTargetRef) return null;
        const source = analysisTargetType === "recording"
            ? (analysisTargetRef._raw && analysisTargetRef._raw.features)
            : (analysisTargetRef._summary && analysisTargetRef._summary.ddk_mean);
        if (!source || Object.keys(source).length === 0) return null;
        return {
            ddkRepetitionCount: source["DDK Repetition Count"], ddkRepetitionRate: source["DDK Repetition Rate"],
            ddkIntervalMean: source["DDK Interval Mean"], ddkRegularity: source["DDK Regularity"],
            speechRate: source["Speech Rate"], pauseSpeechRatio: source["Pause/Speech Ratio"],
            ddkIntervalStd: source["DDK Interval Std"],
        };
    }

    // Reuses the same empty-state look as the Values/Quality metric
    // widgets (see buildWidgetMarkup's emptyText/pinboard-widget-empty).
    function graphEmptyStateHTML(label) {
        return `<div class="pinboard-widget-empty">No ${label} data yet</div>`;
    }

    // ==========================================================
    // DDK per-recording graphs: Peak Tracker, Interval Bar Chart,
    // Regularity Trend, Pause Ratio, DDK Summary
    // ==========================================================
    //
    // Peak Tracker / Interval Bar Chart / Regularity Trend all plot
    // different views of the exact same underlying data (see
    // extract_ddk_contour() in app/feature_extractor.py) -- one shared
    // cache means opening more than one of them for the same recording
    // doesn't trigger duplicate requests, and flipping back to a
    // recently-viewed recording is instant. A failed fetch is not
    // cached, so re-opening the widget retries instead of getting stuck
    // on a transient error.
    const _ddkContourCache = new Map(); // "subjectId:recordingId" -> Promise<contour|null>

    function fetchDDKContourForTarget(subjectId, recordingId) {
        const key = `${subjectId}:${recordingId}`;
        if (_ddkContourCache.has(key)) return _ddkContourCache.get(key);
        const p = api.getRecordingDdkContour(subjectId, recordingId).catch((err) => {
            console.error(err);
            _ddkContourCache.delete(key);
            return null;
        });
        _ddkContourCache.set(key, p);
        return p;
    }

    // Pause Ratio and DDK Summary only need the scalar features already
    // returned by getDdkValuesForTarget() (real for both a single
    // recording and a subject aggregate). Peak Tracker/Interval
    // Bar/Regularity Trend need the granular arrays a subject aggregate
    // has no single-waveform equivalent of -- same recording-only
    // restriction as Spectrogram/DDK Waveform/Pitch Waveform (see
    // updateWidgetButtonsAvailability), so a subject target shows the
    // empty state here too.
    let _ddkContourTokenCounter = 0;

    function loadDDKContourForWidget(container, label, onData) {
        if (!(analysisTargetType === "recording" && analysisTargetRef)) {
            container.innerHTML = graphEmptyStateHTML(label);
            return;
        }
        const subjectId = analysisTargetRef.subjectId
            || (analysisTargetRef._raw && analysisTargetRef._raw.subject_id);
        const recordingId = analysisTargetRef.id
            || (analysisTargetRef._raw && analysisTargetRef._raw.recording_id);
        if (!subjectId || !recordingId) {
            container.innerHTML = graphEmptyStateHTML(label);
            return;
        }

        const token = String(++_ddkContourTokenCounter);
        container.dataset.ddkContourToken = token;
        container.innerHTML = `<div class="pinboard-widget-empty">Loading ${label}\u2026</div>`;

        fetchDDKContourForTarget(subjectId, recordingId).then((data) => {
            if (container.dataset.ddkContourToken !== token) return; // stale — target/widget moved on
            if (!data || !data.peak_times || data.peak_times.length < 2) {
                container.innerHTML = graphEmptyStateHTML(label);
                return;
            }
            onData(container, data);
        });
    }

    // Sparse x-axis tick labels for a bar/point series with `n` items --
    // always includes the first and last item, fills in evenly spaced
    // labels between them, and skips the rest so a 60+ repetition run
    // doesn't crowd the axis. Returns {index, label, pct} pairs, where
    // pct is that index's exact horizontal position (0-100) along the
    // chart -- via fracFor(index), which each caller supplies to match
    // its own bar-center or point x-coordinate formula -- so the label
    // can be placed precisely under its data point instead of relying
    // on flexbox's even visual spacing.
    function sparseIndexTicks(n, maxTicks, labelFor, fracFor) {
        if (n <= 0) return [];
        const count = Math.max(2, Math.min(maxTicks, n));
        const ticks = [];
        for (let i = 0; i < count; i++) {
            const idx = Math.round((i / (count - 1)) * (n - 1));
            if (ticks.length && ticks[ticks.length - 1].index === idx) continue;
            ticks.push({ index: idx, label: labelFor(idx), pct: fracFor(idx) * 100 });
        }
        return ticks;
    }

    // Exact edge-to-edge x-fractions for a series with one point per
    // recording (used by DDK Regularity Trend below) -- i/(n-1) so the
    // first point sits at the plot's left edge and the last at its right
    // edge, with the n===1 case (division by zero) short-circuited to a
    // single centered point instead. Feed the result into
    // sparseIndexTicks()'s fracFor so axis ticks land exactly on the
    // same x-coordinates as the plotted dots, rather than flexbox
    // space-between's even *visual* spacing, which drifts once point
    // count/label width aren't uniform.
    function longLineXFracs(n) {
        if (n <= 1) return [0.5];
        const out = [];
        for (let i = 0; i < n; i++) out.push(i / (n - 1));
        return out;
    }

    // ---- DDK Peak Tracker -------------------------------------------
    // Real raw waveform (faint background) + real intensity contour +
    // real detected repetition peaks for one recording, all from the
    // same detector extract_ddk_features's scalars were computed from
    // (see extract_ddk_contour() docstring) -- hovering shows the peak
    // count/timing a clinician would otherwise have to infer from the
    // "DDK Repetition Count"/"DDK Interval Mean" numbers alone.
    let _ddkPeakInstances = 0;

    function renderDDKPeakTracker(container) {
        loadDDKContourForWidget(container, "DDK Peak Tracker", drawDDKPeakTracker);
    }

    function drawDDKPeakTracker(container, data) {
        const id = ++_ddkPeakInstances;
        const duration = data.duration;
        const iTimes = data.intensity_times;
        const iValues = data.intensity_values;
        const peakTimes = data.peak_times;

        const iMin = Math.min.apply(null, iValues);
        const iMax = Math.max.apply(null, iValues);
        const iSpan = (iMax - iMin) || 1;

        const wMin = data.waveform_min, wMax = data.waveform_max;
        const wSpan = Math.max(
            Math.max.apply(null, wMax.map(Math.abs)),
            Math.max.apply(null, wMin.map(Math.abs)),
            0.001
        );

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const centerY = padT + plotH / 2;
        const waveAmp = plotH / 2 - 6;

        const xAt = (t) => padL + (t / duration) * plotW;
        const yAtIntensity = (v) => baseY - ((v - iMin) / iSpan) * plotH;

        let waveBars = "";
        const barW = Math.max(1, plotW / wMin.length - 0.5);
        for (let i = 0; i < wMin.length; i++) {
            const x = padL + (i / wMin.length) * plotW;
            const y1 = centerY - (wMax[i] / wSpan) * waveAmp;
            const y2 = centerY - (wMin[i] / wSpan) * waveAmp;
            waveBars += `<rect x="${x.toFixed(2)}" y="${Math.min(y1, y2).toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(1, Math.abs(y2 - y1)).toFixed(2)}" fill="#9a9aa2" opacity="0.16"/>`;
        }

        let intensityD = "";
        iTimes.forEach((t, i) => {
            const x = xAt(t).toFixed(2), y = yAtIntensity(iValues[i]).toFixed(2);
            intensityD += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
        });

        let peakMarks = "";
        peakTimes.forEach((t) => {
            const x = xAt(t).toFixed(2);
            peakMarks += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${baseY.toFixed(2)}" stroke="#ffb454" stroke-width="1" opacity="0.35"/>`;
            peakMarks += `<circle cx="${x}" cy="${padT + 4}" r="2.6" fill="#ffb454"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${waveBars}
                <path d="${intensityD}" fill="none" stroke="#6ea8fe" stroke-width="1.6" stroke-linejoin="round"/>
                ${peakMarks}
                <g class="ddk-hover-group"></g>
            </svg>`;

        const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
            label: (duration * f).toFixed(1) + "s",
            pct: (xAt(duration * f) / W) * 100,
        }));

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">DDK Peak Tracker</div>
                        <div class="area-sub">Real intensity contour &amp; detected repetition peaks</div>
                    </div>
                    <div class="area-range-pill">${peakTimes.length} peaks</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis">
                        <span>${fmt(iMax, 0)}</span>
                        <span>${fmt((iMax + iMin) / 2, 0)}</span>
                        <span>${fmt(iMin, 0)}</span>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer"></div>
                    <div class="area-xaxis--precise">${xTicks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}</div>
                </div>
                <div class="area-legend">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#9a9aa2;opacity:0.5"></span>Raw waveform</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>Intensity contour</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffb454"></span>Voiced peaks</div>
                </div>
            </div>`;

        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");
        const hoverGroup = container.querySelector(".ddk-hover-group");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const t = relX * duration;

            // nearest peak (for the "interval since previous peak" readout)
            let nearestIdx = 0, nearestDist = Infinity;
            peakTimes.forEach((pt, i) => {
                const d = Math.abs(pt - t);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const nearestT = peakTimes[nearestIdx];
            const prevT = nearestIdx > 0 ? peakTimes[nearestIdx - 1] : null;
            const interval = prevT !== null ? nearestT - prevT : null;

            const cx = xAt(t);
            hoverGroup.innerHTML = `<line x1="${cx.toFixed(2)}" y1="${padT}" x2="${cx.toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#ffffff" stroke-width="1" opacity="0.28"/>`;

            let rows = `<div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:#ffb454"></span>Peak #${nearestIdx + 1} at ${fmt(nearestT, 2)}s</div>`;
            if (interval !== null) rows += `<div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:#6ea8fe"></span>${fmt(interval, 3)}s since previous</div>`;

            tooltip.innerHTML = `<div class="ddk-tooltip-title">${fmt(t, 2)}s</div>${rows}`;
            tooltip.classList.add("visible");
            const wrapW = rect.width, wrapH = rect.height;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, relX * wrapW)) + "px";
            // Pin near the top of the chart rather than tracking the
            // hovered y-value -- following y let the tooltip (anchored
            // above its `top` via translate(-50%,-100%)) overflow past
            // the card's edge whenever the hover point was already near
            // the top of the plot.
            tooltip.style.top = "22px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            hoverGroup.innerHTML = "";
            tooltip.classList.remove("visible");
        });
    }

    // ---- Interval Bar Chart -------------------------------------------
    // One bar per rep-to-rep gap, flagged red where it falls outside the
    // run's mean ± 1 SD band -- the same interval array behind the
    // "DDK Interval Mean"/"DDK Interval Std" scalars, just per-repetition
    // instead of aggregated.
    function renderIntervalBarChart(container) {
        loadDDKContourForWidget(container, "Interval Bar Chart", drawIntervalBarChart);
    }

    function drawIntervalBarChart(container, data) {
        const intervals = data.intervals;
        const n = intervals.length;
        const mean = intervals.reduce((a, b) => a + b, 0) / n;
        const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
        const lo = mean - sd, hi = mean + sd;
        const vMax = Math.max.apply(null, intervals) * 1.12 || 1;
        const flaggedCount = intervals.filter((v) => v < lo || v > hi).length;

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const yAt = (v) => baseY - (v / vMax) * plotH;
        const gap = plotW / n;
        const barW = Math.max(1.5, gap * 0.62);

        const bandY1 = yAt(hi), bandY2 = yAt(lo);
        const band = `<rect x="${padL}" y="${bandY1.toFixed(2)}" width="${plotW.toFixed(2)}" height="${(bandY2 - bandY1).toFixed(2)}" fill="#ffffff" opacity="0.06"/>`;
        const meanLine = `<line x1="${padL}" y1="${yAt(mean).toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${yAt(mean).toFixed(2)}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;

        let bars = "";
        intervals.forEach((v, i) => {
            const outside = v < lo || v > hi;
            const x = padL + i * gap + (gap - barW) / 2;
            const y = yAt(v);
            bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${(baseY - y).toFixed(2)}" fill="${outside ? "#ff6b6b" : "#6ea8fe"}" opacity="${outside ? 0.9 : 0.85}"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${band}
                ${bars}
                ${meanLine}
                <g class="ddk-hover-group"></g>
            </svg>`;

        const centerXAt = (i) => padL + i * gap + gap / 2;
        const ticks = sparseIndexTicks(n, 10, (i) => String(i + 1), (i) => centerXAt(i) / W);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Interval Bar Chart</div>
                        <div class="area-sub">Rep-to-rep gap duration - mean ${fmt(mean, 3)}s &plusmn; ${fmt(sd, 3)}s</div>
                    </div>
                    <div class="area-range-pill" style="${flaggedCount ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${flaggedCount ? `${flaggedCount} of ${n} beyond 1 SD` : "All within 1 SD"}</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis">
                        <span>${fmt(vMax, 2)}s</span>
                        <span>${fmt(vMax / 2, 2)}s</span>
                        <span>0.00s</span>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer"></div>
                    <div class="area-xaxis--precise">
                        ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                    </div>
                </div>
                <div class="area-legend">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>Interval</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>&gt;1 SD from mean</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff;opacity:0.3"></span>Mean &plusmn; 1 SD band</div>
                </div>
            </div>`;

        // Hover: snap to the nearest bar by its center x -- same
        // .ddk-chart-wrap/.ddk-tooltip shell as DDK Peak Tracker, plus a
        // vertical hoverGroup guide line since bars (unlike the trend
        // widgets) don't already have a dot to anchor the eye on.
        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");
        const hoverGroup = container.querySelector(".ddk-hover-group");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const targetX = relX * W;
            let nearestIdx = 0, nearestDist = Infinity;
            intervals.forEach((v, i) => {
                const d = Math.abs(centerXAt(i) - targetX);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const v = intervals[nearestIdx];
            const flagged = v < lo || v > hi;
            const cx = centerXAt(nearestIdx);

            hoverGroup.innerHTML = `<line x1="${cx.toFixed(2)}" y1="${padT}" x2="${cx.toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#ffffff" stroke-width="1" opacity="0.28"/>`;

            tooltip.innerHTML = `
                <div class="ddk-tooltip-title">Rep ${nearestIdx + 1}</div>
                <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${flagged ? "#ff6b6b" : "#6ea8fe"}"></span>${fmt(v, 3)}s${flagged ? " (beyond 1 SD)" : ""}</div>`;
            tooltip.classList.add("visible");
            const wrapW = rect.width;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, (cx / W) * wrapW)) + "px";
            const barTopScreenY = (yAt(v) / H) * rect.height;
            tooltip.style.top = (barTopScreenY - tooltip.offsetHeight - 10) + "px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            hoverGroup.innerHTML = "";
            tooltip.classList.remove("visible");
        });
    }

    // ---- Regularity Trend -------------------------------------------
    // Per-interval percent deviation from the run's mean interval --
    // same coefficient-of-variation-style units as the "DDK Regularity"
    // scalar (HIGHER = MORE irregular, matching that existing metric's
    // convention throughout the app), just plotted per repetition
    // instead of collapsed into one aggregate number.
    function renderRegularityTrend(container) {
        loadDDKContourForWidget(container, "Regularity Trend", drawRegularityTrend);
    }

    function drawRegularityTrend(container, data) {
        const irregularity = data.interval_local_irregularity;
        const n = irregularity.length;
        const avg = irregularity.reduce((a, b) => a + b, 0) / n;
        const vMax = Math.max(100, Math.max.apply(null, irregularity) * 1.1);
        const flaggedCount = irregularity.filter((v) => v > avg + 15).length;

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const yAt = (v) => baseY - (Math.min(v, vMax) / vMax) * plotH;
        const xAt = (i) => padL + (n === 1 ? 0.5 : i / (n - 1)) * plotW;

        let grid = "";
        [0, 25, 50, 75, 100].forEach((v) => {
            if (v > vMax) return;
            const y = yAt(v).toFixed(2);
            grid += `<line x1="${padL}" y1="${y}" x2="${(W - padR).toFixed(2)}" y2="${y}" stroke="#232327" stroke-width="1"/>`;
        });

        const avgLine = `<line x1="${padL}" y1="${yAt(avg).toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${yAt(avg).toFixed(2)}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;

        let pathD = "";
        let dots = "";
        irregularity.forEach((v, i) => {
            const x = xAt(i), y = yAt(v);
            pathD += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
            const flagged = v > avg + 15;
            dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.8" fill="${flagged ? "#ff6b6b" : "#3ddc84"}"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${grid}
                ${avgLine}
                <path d="${pathD}" fill="none" stroke="#3ddc84" stroke-width="1.6" stroke-linejoin="round"/>
                ${dots}
                <g class="ddk-hover-group"></g>
            </svg>`;

        const ticks = sparseIndexTicks(n, 10, (i) => String(i + 1), (i) => xAt(i) / W);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Regularity Trend</div>
                        <div class="area-sub">Per-interval deviation from mean timing (avg ${fmt(avg, 1)}%)</div>
                    </div>
                    <div class="area-range-pill" style="${flaggedCount ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${flaggedCount ? `${flaggedCount} irregular point${flaggedCount === 1 ? "" : "s"}` : "Consistent timing"}</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis">
                        <span>${fmt(vMax, 0)}%</span>
                        <span>${fmt(vMax / 2, 0)}%</span>
                        <span>0%</span>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer"></div>
                    <div class="area-xaxis--precise">
                        ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                    </div>
                </div>
                <div class="area-legend">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#3ddc84"></span>Local irregularity</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>&gt;15pt above average</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff;opacity:0.3"></span>Recording average</div>
                </div>
            </div>`;

        // Hover: snap to the nearest interval by x -- same
        // .ddk-chart-wrap/.ddk-tooltip shell as DDK Peak Tracker, with a
        // hoverGroup guide line since points sit close together here.
        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");
        const hoverGroup = container.querySelector(".ddk-hover-group");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const targetX = relX * W;
            let nearestIdx = 0, nearestDist = Infinity;
            irregularity.forEach((v, i) => {
                const d = Math.abs(xAt(i) - targetX);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const v = irregularity[nearestIdx];
            const flagged = v > avg + 15;
            const cx = xAt(nearestIdx);

            hoverGroup.innerHTML = `<line x1="${cx.toFixed(2)}" y1="${padT}" x2="${cx.toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#ffffff" stroke-width="1" opacity="0.28"/>`;

            tooltip.innerHTML = `
                <div class="ddk-tooltip-title">Interval ${nearestIdx + 1}</div>
                <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${flagged ? "#ff6b6b" : "#3ddc84"}"></span>${fmt(v, 1)}% deviation${flagged ? " (irregular)" : ""}</div>`;
            tooltip.classList.add("visible");
            const wrapW = rect.width;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, (cx / W) * wrapW)) + "px";
            const pointScreenY = (yAt(v) / H) * rect.height;
            tooltip.style.top = (pointScreenY - tooltip.offsetHeight - 10) + "px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            hoverGroup.innerHTML = "";
            tooltip.classList.remove("visible");
        });
    }

    // ---- DDK Repetition Count Trend -----------------------------------
    // Longitudinal view across every DDK recording for the current
    // subject target (needs 2+ DDK recordings to mean anything,
    // so it only ever renders for a "multi" target — see
    // getSidebarContextKey()). Reads the SAME "DDK Repetition Count"
    // scalar already stored per recording (compute_date_summary /
    // compute_subject_summary in app/recording_store.py), tagged with
    // _created_at/_recording_id so trials can be sorted chronologically
    // and labeled with real dates — no new backend endpoint needed, this
    // is the same ddk_trials array getDdkValuesForTarget() already
    // reads, just walked point-by-point instead of averaged.
    function renderDDKRepetitionCountTrend(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("DDK Repetition Count Trend");
            return;
        }
        const trials = analysisTargetRef._summary && analysisTargetRef._summary.ddk_trials;
        if (!trials) {
            container.innerHTML = graphEmptyStateHTML("DDK Repetition Count Trend");
            return;
        }

        const points = trials
            .map((t) => ({ count: t["DDK Repetition Count"], createdAt: t._created_at, recordingId: t._recording_id }))
            .filter((p) => typeof p.count === "number" && p.createdAt)
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        if (points.length < 2) {
            container.innerHTML = graphEmptyStateHTML("DDK Repetition Count Trend");
            return;
        }

        const counts = points.map((p) => p.count);
        const n = points.length;

        // Baseline = the first 3 recordings (or fewer, if the run is
        // shorter) rather than the whole-run mean -- later recordings are
        // judged against where the subject started, not against
        // themselves, so a real decline shows up as red bars instead of
        // being averaged away.
        const baselineN = Math.min(3, n);
        const baselineVals = counts.slice(0, baselineN);
        const baselineMean = baselineVals.reduce((a, b) => a + b, 0) / baselineN;
        const baselineSD = Math.sqrt(baselineVals.reduce((a, b) => a + (b - baselineMean) * (b - baselineMean), 0) / baselineN);
        // With fewer than 3 baseline recordings the SD is ~0 and every
        // tiny dip goes red -- only flag once there's a real baseline,
        // and only recordings AFTER it.
        const threshold = baselineN >= 3 ? baselineMean - baselineSD : -Infinity;
        const flaggedCount = counts.filter((v, i) => i >= baselineN && v < threshold).length;
        const vMax = Math.max(Math.max.apply(null, counts) * 1.15, 1);

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const yAt = (v) => baseY - (v / vMax) * plotH;
        const gap = plotW / n;
        const xAt = (i) => padL + i * gap + gap / 2;

        const fullDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        let grid = "";
        [0.25, 0.5, 0.75].forEach((f) => {
            const y = (padT + plotH * (1 - f)).toFixed(2);
            grid += `<line x1="${padL}" y1="${y}" x2="${(W - padR).toFixed(2)}" y2="${y}" stroke="#232327" stroke-width="1"/>`;
        });

        const baselineLine = `<line x1="${padL}" y1="${yAt(baselineMean).toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${yAt(baselineMean).toFixed(2)}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;

        const barW = Math.max(1.5, gap * 0.62);

        let bars = "";
        points.forEach((p, i) => {
            const x = xAt(i) - barW / 2, y = yAt(p.count);
            const flagged = i >= baselineN && p.count < threshold;
            bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${(baseY - y).toFixed(2)}" rx="2" ry="2" fill="${flagged ? "#ff6b6b" : "#6ea8fe"}" opacity="${flagged ? 0.9 : 0.85}"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${grid}
                ${bars}
                ${baselineLine}
            </svg>`;

        const ticks = sparseIndexTicks(n, 20, (i) => String(i + 1), (i) => xAt(i) / W);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Repetition Count Trend</div>
                        <div class="area-sub">Reps per recording across ${n} DDK recordings - declining = reduced endurance</div>
                    </div>
                    <div class="area-range-pill" style="${flaggedCount ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${flaggedCount ? "Below baseline" : "Within baseline"}</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis-wrap">
                        <div class="area-yaxis-label">Reps</div>
                        <div class="area-yaxis">
                            <span>${fmt(vMax, 0)}</span>
                            <span>${fmt(vMax / 2, 0)}</span>
                            <span>0</span>
                        </div>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer" style="width:44px;"></div>
                    <div class="area-xaxis--labeled" style="flex:1;display:flex;flex-direction:column;">
                        <div class="area-xaxis--precise" style="flex:none;">
                            ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                        </div>
                        <div class="area-axis-title">Recording #</div>
                    </div>
                </div>
                <div class="area-legend" style="padding-left:52px;">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>Repetition count</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>Below baseline &plusmn;1 SD</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff;opacity:0.3"></span>Baseline (first ${baselineN} recording${baselineN === 1 ? "" : "s"})</div>
                </div>
            </div>`;

        // hover: snap to the nearest recording (points are discrete, not
        // a continuous time axis) — same .ddk-chart-wrap/.ddk-tooltip
        // shell as DDK Peak Tracker.
        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const targetX = relX * W;
            let nearestIdx = 0, nearestDist = Infinity;
            points.forEach((p, i) => {
                const d = Math.abs(xAt(i) - targetX);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const p = points[nearestIdx];

            tooltip.innerHTML = `
                <div class="ddk-tooltip-title">${fullDate(p.createdAt)}</div>
                <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${p.count < threshold ? "#ff6b6b" : "#6ea8fe"}"></span>${fmt(p.count, 0)} reps</div>`;
            tooltip.classList.add("visible");
            const wrapW = rect.width;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, (xAt(nearestIdx) / W) * wrapW)) + "px";
            // Anchored above the hovered bar's own top edge (not a fixed
            // top offset) -- .ddk-chart-wrap's overflow is visible now,
            // so this can float past the card's edge for a tall bar.
            const barTopScreenY = (yAt(p.count) / H) * rect.height;
            tooltip.style.top = (barTopScreenY - tooltip.offsetHeight - 10) + "px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            tooltip.classList.remove("visible");
        });
    }


    // ---- DDK Regularity Trend (across-recordings) ----------------------
    // Longitudinal view of the "DDK Regularity" scalar (std/mean * 100 of
    // DDK interval timing -- a coefficient-of-variation percentage) across
    // every DDK recording for the current subject target. Same
    // ddk_trials array as DDK Repetition Count Trend above, just reading
    // "DDK Regularity" instead of "DDK Repetition Count" -- no new
    // backend endpoint needed.
    //
    // Direction note (get this right): DDK Regularity is HIGHER = MORE
    // IRREGULAR, same convention as the per-recording Regularity Trend
    // widget above (drawRegularityTrend) -- so points ABOVE the baseline
    // band are the problem here, not below. This has already gone
    // backwards once in that per-recording widget; don't repeat it here.
    //
    // Registered as "DDK Regularity Trend" (not bare "Regularity Trend")
    // -- GRAPH_RENDERERS below is a single flat object keyed by title,
    // and the per-recording widget above already owns the "Regularity
    // Trend" key. Reusing that exact key here wouldn't just be a display
    // collision, it would silently overwrite that entry in the object,
    // breaking whichever widget got defined first. Same "DDK "-prefix
    // pattern already used for DDK Repetition Count Trend.
    function renderDDKRegularityLongTrend(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("Regularity Trend");
            return;
        }
        const trials = analysisTargetRef._summary && analysisTargetRef._summary.ddk_trials;
        if (!trials) {
            container.innerHTML = graphEmptyStateHTML("Regularity Trend");
            return;
        }

        const points = trials
            .map((t) => ({ value: t["DDK Regularity"], createdAt: t._created_at, recordingId: t._recording_id }))
            .filter((p) => typeof p.value === "number" && p.createdAt)
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        if (points.length < 2) {
            container.innerHTML = graphEmptyStateHTML("Regularity Trend");
            return;
        }

        const values = points.map((p) => p.value);
        const n = points.length;

        // Baseline = mean/SD of the first min(3, n) recordings
        // chronologically (a "baseline period"), not the whole-series
        // average -- same convention as DDK Repetition Count Trend, so
        // later recordings are judged against where the subject started.
        const baselineN = Math.min(3, n);
        const baselineVals = values.slice(0, baselineN);
        const baselineMean = baselineVals.reduce((a, b) => a + b, 0) / baselineN;
        const baselineSD = Math.sqrt(baselineVals.reduce((a, b) => a + (b - baselineMean) * (b - baselineMean), 0) / baselineN);
        const upperThreshold = baselineN >= 3 ? baselineMean + baselineSD : Infinity;
        const lowerBand = baselineMean - baselineSD;
        const flaggedCount = values.filter((v, i) => i >= baselineN && v > upperThreshold).length;

        // Y-axis is sized off the real data (and the baseline band), NOT
        // clamped to a fixed 0-100 range -- DDK Regularity is an
        // unbounded CV%, real recordings can exceed 100.
        const dataMax = Math.max.apply(null, values);
        const dataMin = Math.min.apply(null, values);
        const spanTop = Math.max(dataMax, upperThreshold);
        const spanBottom = Math.min(dataMin, lowerBand, 0);
        const pad = Math.max((spanTop - spanBottom) * 0.12, 1);
        const vMax = spanTop + pad;
        const vMin = spanBottom - (spanBottom < 0 ? pad : 0);
        const vRange = Math.max(vMax - vMin, 1e-6);

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const yAt = (v) => baseY - ((v - vMin) / vRange) * plotH;
        const fracs = longLineXFracs(n);
        const xAt = (i) => padL + fracs[i] * plotW;

        const fullDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        let grid = "";
        [0.2, 0.4, 0.6, 0.8].forEach((f) => {
            const y = (padT + plotH * f).toFixed(2);
            grid += `<line x1="${padL}" y1="${y}" x2="${(W - padR).toFixed(2)}" y2="${y}" stroke="#232327" stroke-width="1"/>`;
        });

        // Shaded baseline band (mean +/- SD) + dashed mean line.
        const bandTopY = yAt(baselineMean + baselineSD);
        const bandBotY = yAt(baselineMean - baselineSD);
        const band = `<rect x="${padL}" y="${bandTopY.toFixed(2)}" width="${plotW.toFixed(2)}" height="${(bandBotY - bandTopY).toFixed(2)}" fill="transparent"/>`;
        const meanLine = `<line x1="${padL}" y1="${yAt(baselineMean).toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${yAt(baselineMean).toFixed(2)}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;

        let pathD = "";
        let dots = "";
        points.forEach((p, i) => {
            const x = xAt(i), y = yAt(p.value);
            pathD += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
            const flagged = i >= baselineN && p.value > upperThreshold;
            dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${flagged ? "#ff6b6b" : "#3fd185"}"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${grid}
                ${band}
                <path d="${pathD}" fill="none" stroke="#3fd185" stroke-width="1.6" stroke-linejoin="round"/>
                ${dots}
                ${meanLine}
            </svg>`;

        // Status pill: compares the LAST recording to the FIRST (not the
        // flagged-point count) -- "worse" means regularity climbed by
        // more than 5 points end-to-end, matching the CV% = more
        // irregular direction used for the dot coloring above.
        const trendDelta = values[n - 1] - values[0];
        const trendingUp = trendDelta > 5;

        const ticks = sparseIndexTicks(n, 15, (i) => String(i + 1), (i) => fracs[i]);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Regularity Trend</div>
                        <div class="area-sub">DDK Regularity across ${n} recordings - higher = more irregular timing</div>
                    </div>
                    <div class="area-range-pill" style="${trendingUp ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${trendingUp ? "Trending up" : "Stable / improving"}</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis-wrap">
                        <div class="area-yaxis-label">Regularity</div>
                        <div class="area-yaxis">
                            <span>${fmt(vMax, 0)}%</span>
                            <span>${fmt((vMax + vMin) / 2, 0)}%</span>
                            <span>${fmt(vMin, 0)}%</span>
                        </div>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer" style="width:44px;"></div>
                    <div class="area-xaxis--labeled" style="flex:1;display:flex;flex-direction:column;">
                        <div class="area-xaxis--precise" style="flex:none;">
                            ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                        </div>
                        <div class="area-axis-title">Recording #</div>
                    </div>
                </div>
                <div class="area-legend" style="padding-left:52px;">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#3fd185"></span>Regularity</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>Above baseline band</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff;opacity:0.3"></span>Baseline (first ${baselineN} recording${baselineN === 1 ? "" : "s"})</div>
                </div>
            </div>`;

        // Hover: snap to the nearest recording by x-fraction distance
        // (points are discrete, one per recording, not a continuous time
        // axis) -- same .ddk-chart-wrap/.ddk-tooltip shell as DDK
        // Repetition Count Trend.
        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            let nearestIdx = 0, nearestDist = Infinity;
            fracs.forEach((f, i) => {
                const d = Math.abs(f - relX);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const p = points[nearestIdx];
            const flagged = i >= baselineN && p.value > upperThreshold;

            tooltip.innerHTML = `
                <div class="ddk-tooltip-title">${fullDate(p.createdAt)}</div>
                <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${flagged ? "#ff6b6b" : "#3fd185"}"></span>${fmt(p.value, 1)}% regularity</div>`;
            tooltip.classList.add("visible");
            const wrapW = rect.width;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, fracs[nearestIdx] * wrapW)) + "px";
            // Anchored above the hovered point's own screen position (not
            // a fixed top offset) -- .ddk-chart-wrap's overflow is
            // visible now, so this can float past the card's edge.
            const pointScreenY = (yAt(p.value) / H) * rect.height;
            tooltip.style.top = (pointScreenY - tooltip.offsetHeight - 10) + "px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            tooltip.classList.remove("visible");
        });
    }


    // ---- DDK Interval Stability Trend (across-recordings) --------------
    // Longitudinal view of "DDK Interval Mean" across every DDK recording
    // for the current subject target -- same ddk_trials array
    // (and no new backend endpoint) as DDK Repetition Count Trend / DDK
    // Regularity Trend above, just reading "DDK Interval Mean" (the line)
    // and "DDK Interval Std" (the band) instead of Repetition Count or
    // Regularity.
    //
    // The band is the point of this widget: it's each recording's OWN
    // "DDK Interval Std" plotted as a per-point +/-1 SD ribbon around
    // that recording's mean, not a single flat baseline band -- a
    // widening ribbon over time means repetitions WITHIN a date group are
    // getting less consistent, which a flat mean-only line (or the
    // dashed baseline reference line below) can't show on its own even
    // if the mean itself stays flat.
    //
    // Direction note: rising Interval Mean = slower repetitions, same
    // "higher on this line = worse" convention as DDK Regularity Trend's
    // note above -- baseline/flag logic here mirrors that widget's
    // mean+SD-of-the-first-few-recordings threshold exactly, just applied
    // to Interval Mean instead of Regularity.
    function renderDDKIntervalStabilityTrend(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("Interval Stability Trend");
            return;
        }
        const trials = analysisTargetRef._summary && analysisTargetRef._summary.ddk_trials;
        if (!trials) {
            container.innerHTML = graphEmptyStateHTML("Interval Stability Trend");
            return;
        }

        const points = trials
            .map((t) => ({ mean: t["DDK Interval Mean"], sd: t["DDK Interval Std"], createdAt: t._created_at, recordingId: t._recording_id }))
            .filter((p) => typeof p.mean === "number" && typeof p.sd === "number" && p.createdAt)
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        if (points.length < 2) {
            container.innerHTML = graphEmptyStateHTML("Interval Stability Trend");
            return;
        }

        const values = points.map((p) => p.mean);
        const sds = points.map((p) => Math.max(0, p.sd));
        const n = points.length;

        // Baseline = mean/SD of the first min(3, n) recordings -- same
        // "baseline period, not whole-run average" convention as DDK
        // Repetition Count Trend / DDK Regularity Trend above.
        const baselineN = Math.min(3, n);
        const baselineVals = values.slice(0, baselineN);
        const baselineMean = baselineVals.reduce((a, b) => a + b, 0) / baselineN;
        const baselineSD = Math.sqrt(baselineVals.reduce((a, b) => a + (b - baselineMean) * (b - baselineMean), 0) / baselineN);
        const upperThreshold = baselineN >= 3 ? baselineMean + baselineSD : Infinity;
        const flaggedCount = values.filter((v, i) => i >= baselineN && v > upperThreshold).length;

        // Time-valued axis (seconds), so the floor is a real 0, not a
        // data-relative min -- same convention as Interval Bar Chart's
        // y-axis, rather than DDK Regularity Trend's floating vMin (that
        // one's a CV% that can legitimately dip below its baseline).
        const dataMax = Math.max.apply(null, values.map((v, i) => v + sds[i]));
        const vMax = Math.max(dataMax, upperThreshold, 1e-6) * 1.15;

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const yAt = (v) => baseY - (Math.max(0, v) / vMax) * plotH;
        const fracs = longLineXFracs(n);
        const xAt = (i) => padL + fracs[i] * plotW;

        const fullDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        // Per-point +/-1 SD ribbon -- upper edge forward, lower edge
        // (clamped to 0, an interval can't go negative) back, closed
        // into one filled polygon. This is what makes within-recording
        // jitter visible independent of the mean line itself.
        let bandD = "";
        points.forEach((p, i) => {
            const x = xAt(i).toFixed(2), y = yAt(values[i] + sds[i]).toFixed(2);
            bandD += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
        });
        for (let i = n - 1; i >= 0; i--) {
            const x = xAt(i).toFixed(2), y = yAt(Math.max(0, values[i] - sds[i])).toFixed(2);
            bandD += ` L ${x} ${y}`;
        }
        bandD += " Z";
        const band = `<path d="${bandD}" fill="#6ea8fe" opacity="0.16" stroke="none"/>`;

        const baselineLine = `<line x1="${padL}" y1="${yAt(baselineMean).toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${yAt(baselineMean).toFixed(2)}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;

        let pathD = "";
        let dots = "";
        points.forEach((p, i) => {
            const x = xAt(i), y = yAt(values[i]);
            pathD += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
            const flagged = i >= baselineN && values[i] > upperThreshold;
            dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${flagged ? "#ff6b6b" : "#6ea8fe"}"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${band}
                <path d="${pathD}" fill="none" stroke="#6ea8fe" stroke-width="1.6" stroke-linejoin="round"/>
                ${dots}
                ${baselineLine}
            </svg>`;

        // maxTicks = n -- label every recording, not a sparse subset.
        const ticks = sparseIndexTicks(n, n, (i) => String(i + 1), (i) => fracs[i]);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Interval Stability Trend</div>
                        <div class="area-sub">DDK Interval Mean across ${n} recordings - band is each recording's own &plusmn;1 SD jitter</div>
                    </div>
                    <div class="area-range-pill" style="${flaggedCount ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${flaggedCount ? "Above baseline (slower)" : "Within baseline"}</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis-wrap">
                        <div class="area-yaxis-label">Interval (s)</div>
                        <div class="area-yaxis">
                            <span>${fmt(vMax, 2)}s</span>
                            <span>${fmt(vMax / 2, 2)}s</span>
                            <span>0.00s</span>
                        </div>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer" style="width:44px;"></div>
                    <div class="area-xaxis--labeled" style="flex:1;display:flex;flex-direction:column;">
                        <div class="area-xaxis--precise" style="flex:none;">
                            ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                        </div>
                        <div class="area-axis-title">Recording #</div>
                    </div>
                </div>
                <div class="area-legend" style="padding-left:52px;">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>Interval mean</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe;opacity:0.35"></span>&plusmn;1 SD (within-recording jitter)</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>Above baseline &plusmn;1 SD</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff;opacity:0.3"></span>Baseline (first ${baselineN} recording${baselineN === 1 ? "" : "s"})</div>
                </div>
            </div>`;

        // Hover: snap to the nearest recording by x-fraction distance --
        // same .ddk-chart-wrap/.ddk-tooltip shell as DDK Repetition Count
        // Trend / DDK Regularity Trend above.
        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            let nearestIdx = 0, nearestDist = Infinity;
            fracs.forEach((f, i) => {
                const d = Math.abs(f - relX);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const p = points[nearestIdx];
            const flagged = nearestIdx >= baselineN && values[nearestIdx] > upperThreshold;

            tooltip.innerHTML = `
                <div class="ddk-tooltip-title">${fullDate(p.createdAt)}</div>
                <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${flagged ? "#ff6b6b" : "#6ea8fe"}"></span>${fmt(p.mean, 3)}s &plusmn; ${fmt(p.sd, 3)}s</div>`;
            tooltip.classList.add("visible");
            const wrapW = rect.width;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, fracs[nearestIdx] * wrapW)) + "px";
            // Anchored above the hovered point's own screen position (not
            // a fixed top offset) -- .ddk-chart-wrap's overflow is
            // visible now, so this can float past the card's edge.
            const pointScreenY = (yAt(values[nearestIdx]) / H) * rect.height;
            tooltip.style.top = (pointScreenY - tooltip.offsetHeight - 10) + "px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            tooltip.classList.remove("visible");
        });
    }


    // ---- Pause Ratio Trend (across-recordings) --------------------------
    // Longitudinal view of "Pause/Speech Ratio" across every DDK recording
    // for the current subject target -- same ddk_trials array
    // (and no new backend endpoint) as DDK Repetition Count Trend / DDK
    // Regularity Trend / Interval Stability Trend above, just reading
    // "Pause/Speech Ratio" instead.
    //
    // Filled line (not bare stroke) -- built the same way as Interval
    // Stability Trend's +/-1 SD ribbon above: a forward path along the
    // data, then a closing return path, only here the return path runs
    // back along the axis baseline instead of a second data series, so
    // the fill reads as "area under the ratio" rather than a band.
    //
    // Direction note: rising Pause/Speech Ratio = MORE pausing relative
    // to speech, which is the concerning direction here -- same
    // "higher on this line = worse" convention as DDK Regularity Trend,
    // and the status-pill wording/logic below is copied from that
    // widget's last-vs-first trend check (see its comment), just scaled
    // by this metric's own baseline SD instead of a flat point count,
    // since a ratio has no fixed 0-100 scale to borrow a magic number
    // from.
    function renderPauseRatioTrend(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("Pause Ratio Trend");
            return;
        }
        const trials = analysisTargetRef._summary && analysisTargetRef._summary.ddk_trials;
        if (!trials) {
            container.innerHTML = graphEmptyStateHTML("Pause Ratio Trend");
            return;
        }

        const points = trials
            .map((t) => ({ value: t["Pause/Speech Ratio"], createdAt: t._created_at, recordingId: t._recording_id }))
            .filter((p) => typeof p.value === "number" && p.createdAt)
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        if (points.length < 2) {
            container.innerHTML = graphEmptyStateHTML("Pause Ratio Trend");
            return;
        }

        const values = points.map((p) => p.value);
        const n = points.length;

        // Baseline = mean/SD of the first min(3, n) recordings -- same
        // "baseline period, not whole-run average" convention as every
        // other across-recording DDK trend graph above.
        const baselineN = Math.min(3, n);
        const baselineVals = values.slice(0, baselineN);
        const baselineMean = baselineVals.reduce((a, b) => a + b, 0) / baselineN;
        const baselineSD = Math.sqrt(baselineVals.reduce((a, b) => a + (b - baselineMean) * (b - baselineMean), 0) / baselineN);
        const upperThreshold = baselineN >= 3 ? baselineMean + baselineSD : Infinity;
        const flaggedCount = values.filter((v, i) => i >= baselineN && v > upperThreshold).length;

        // Ratio-valued axis, floor at a real 0 (a ratio can't go
        // negative) -- same convention as Interval Stability Trend's
        // seconds axis, not DDK Regularity Trend's floating vMin.
        const dataMax = Math.max.apply(null, values);
        const vMax = Math.max(dataMax, upperThreshold, 1e-6) * 1.15;

        const W = 640, H = 260;
        const padL = 6, padR = 6, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const yAt = (v) => baseY - (Math.max(0, v) / vMax) * plotH;
        const fracs = longLineXFracs(n);
        const xAt = (i) => padL + fracs[i] * plotW;

        const fullDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        // Filled area under the ratio line -- forward along the data,
        // then back along the axis baseline, closed into one polygon
        // (same forward-then-back-and-close technique as Interval
        // Stability Trend's ribbon, just closing to the axis here).
        let fillD = "";
        points.forEach((p, i) => {
            const x = xAt(i).toFixed(2), y = yAt(values[i]).toFixed(2);
            fillD += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
        });
        fillD += ` L ${xAt(n - 1).toFixed(2)} ${baseY.toFixed(2)} L ${xAt(0).toFixed(2)} ${baseY.toFixed(2)} Z`;
        const fill = `<path d="${fillD}" fill="#AA6747" opacity="0.16" stroke="none"/>`;

        const baselineLine = `<line x1="${padL}" y1="${yAt(baselineMean).toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${yAt(baselineMean).toFixed(2)}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;

        let pathD = "";
        let dots = "";
        points.forEach((p, i) => {
            const x = xAt(i), y = yAt(values[i]);
            pathD += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
            const flagged = i >= baselineN && values[i] > upperThreshold;
            dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${flagged ? "#ff6b6b" : "#AA6747"}"/>`;
        });

        const svg = `
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                <line x1="${padL}" y1="${baseY.toFixed(2)}" x2="${(W - padR).toFixed(2)}" y2="${baseY.toFixed(2)}" stroke="#232327" stroke-width="1"/>
                ${fill}
                <path d="${pathD}" fill="none" stroke="#AA6747" stroke-width="1.6" stroke-linejoin="round"/>
                ${dots}
                ${baselineLine}
            </svg>`;

        // Status pill: compares the LAST recording to the FIRST (not the
        // flagged-point count) -- same approach as DDK Regularity
        // Trend's pill, just scaled by this metric's own baseline SD
        // rather than a flat magic number, since Pause/Speech Ratio has
        // no fixed scale (unlike Regularity's 0-100 CV%) to borrow one
        // from.
        const trendDelta = values[n - 1] - values[0];
        const trendingUp = trendDelta > baselineSD;

        // maxTicks = n -- label every recording, not a sparse subset.
        const ticks = sparseIndexTicks(n, n, (i) => String(i + 1), (i) => fracs[i]);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Pause Ratio Trend</div>
                        <div class="area-sub">Pause/Speech Ratio across ${n} recordings - rising = more pausing relative to speech</div>
                    </div>
                    <div class="area-range-pill" style="${trendingUp ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${trendingUp ? "Trending up" : "Stable / improving"}</div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis-wrap">
                        <div class="area-yaxis-label">Pause:Speech</div>
                        <div class="area-yaxis">
                            <span>${fmt(vMax, 2)}:1</span>
                            <span>${fmt(vMax / 2, 2)}:1</span>
                            <span>0.00:1</span>
                        </div>
                    </div>
                    <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${svg}<div class="ddk-tooltip"></div></div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer" style="width:44px;"></div>
                    <div class="area-xaxis--labeled" style="flex:1;display:flex;flex-direction:column;">
                        <div class="area-xaxis--precise" style="flex:none;">
                            ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                        </div>
                        <div class="area-axis-title">Recording #</div>
                    </div>
                </div>
                <div class="area-legend" style="padding-left:52px;">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#AA6747"></span>Pause:Speech ratio</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>Above baseline &plusmn;1 SD</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff;opacity:0.3"></span>Baseline (first ${baselineN} recording${baselineN === 1 ? "" : "s"})</div>
                </div>
            </div>`;

        // Hover: snap to the nearest recording by x-fraction distance --
        // same .ddk-chart-wrap/.ddk-tooltip shell as the other DDK trend
        // graphs above.
        const chartWrap = container.querySelector(".ddk-chart-wrap");
        const tooltip = container.querySelector(".ddk-tooltip");

        chartWrap.addEventListener("mousemove", (e) => {
            const rect = chartWrap.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            let nearestIdx = 0, nearestDist = Infinity;
            fracs.forEach((f, i) => {
                const d = Math.abs(f - relX);
                if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            });
            const p = points[nearestIdx];
            const flagged = nearestIdx >= baselineN && values[nearestIdx] > upperThreshold;

            tooltip.innerHTML = `
                <div class="ddk-tooltip-title">${fullDate(p.createdAt)}</div>
                <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${flagged ? "#ff6b6b" : "#AA6747"}"></span>${fmt(p.value, 3)}:1 pause:speech</div>`;
            tooltip.classList.add("visible");
            const wrapW = rect.width;
            tooltip.style.left = Math.max(60, Math.min(wrapW - 60, fracs[nearestIdx] * wrapW)) + "px";
            // Anchored above the hovered point's own screen position (not
            // a fixed top offset) -- .ddk-chart-wrap's overflow is
            // visible now, so this can float past the card's edge.
            const pointScreenY = (yAt(values[nearestIdx]) / H) * rect.height;
            tooltip.style.top = (pointScreenY - tooltip.offsetHeight - 10) + "px";
        });

        chartWrap.addEventListener("mouseleave", () => {
            tooltip.classList.remove("visible");
        });
    }


    // ---- Rate Trend (across-recordings) ---------------------------------
    // Longitudinal view of "Speech Rate" (syllables/sec) and "DDK
    // Repetition Rate" (repetitions/sec) across every DDK recording for
    // the current subject target -- same ddk_trials array (and
    // no new backend endpoint) as DDK Repetition Count Trend / DDK
    // Regularity Trend / Interval Stability Trend / Pause Ratio Trend
    // above, just reading two scalars instead of one.
    //
    // Two stacked mini-charts, not one combined chart: Speech Rate and
    // Repetition Rate are different units on different scales, so a
    // shared y-axis would make one dwarf the other or overlap
    // meaninglessly. No baseline/SD band on either one (unlike Interval
    // Stability's ribbon or the other trends' flagged-threshold dots) --
    // this widget is just two independent trend lines for comparison.
    //
    // Shared x-axis, gap-aware per line: both mini-charts plot against
    // ONE chronological list of every DDK recording that has a valid
    // value for at least one of the two rates, so "Recording #" and its
    // date line up identically top and bottom. A recording missing just
    // one of the two rates still gets a slot on that shared axis --
    // that rate's line simply skips drawing through it (no dot, path
    // breaks and resumes at the next valid point) rather than dropping
    // the recording from the axis entirely, so a lone Repetition Rate
    // extraction failure doesn't shift every later Speech Rate point
    // sideways on its own chart.
    function renderRateTrend(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("Rate Trend");
            return;
        }
        const trials = analysisTargetRef._summary && analysisTargetRef._summary.ddk_trials;
        if (!trials) {
            container.innerHTML = graphEmptyStateHTML("Rate Trend");
            return;
        }

        const master = trials
            .map((t) => ({ speech: t["Speech Rate"], rep: t["DDK Repetition Rate"], createdAt: t._created_at, recordingId: t._recording_id }))
            .filter((t) => t.createdAt && (typeof t.speech === "number" || typeof t.rep === "number"))
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Same "2+ valid recordings or it isn't a trend" gate every other
        // across-recording DDK graph applies to its own metric, checked
        // against EACH rate here -- a card with only one working
        // mini-chart isn't the side-by-side comparison this widget is
        // for, so it falls back to the same empty state as everywhere
        // else in this file rather than rendering half a card.
        const speechCount = master.filter((t) => typeof t.speech === "number").length;
        const repCount = master.filter((t) => typeof t.rep === "number").length;
        if (speechCount < 2 || repCount < 2) {
            container.innerHTML = graphEmptyStateHTML("Rate Trend");
            return;
        }

        const n = master.length;
        const fullDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const fracs = longLineXFracs(n);

        // Half-height mini-chart (100 vs. the usual 260) since two of
        // these stack inside one card -- same W/pad convention as every
        // other trend graph above, just shorter so the stacked pair
        // doesn't make the card taller than it needs to be.
        const W = 640, H = 100;
        const padL = 6, padR = 6, padT = 8, padB = 8;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const baseY = padT + plotH;
        const xAt = (i) => padL + fracs[i] * plotW;

        // Builds one mini-chart's SVG (line + dots, gap-aware) and its
        // own y-axis scale, reading `key` ("speech"/"rep") off the
        // shared `master` list above so both mini-charts share x
        // positions without sharing a y-axis or a color.
        function buildMiniChart(key, color) {
            const validVals = master.map((t) => t[key]).filter((v) => typeof v === "number");
            const vMax = Math.max(Math.max.apply(null, validVals) * 1.15, 1e-6);
            const yAt = (v) => baseY - (Math.max(0, v) / vMax) * plotH;

            let pathD = "";
            let dots = "";
            let segmentOpen = false;
            master.forEach((t, i) => {
                const v = t[key];
                if (typeof v !== "number") { segmentOpen = false; return; }
                const x = xAt(i), y = yAt(v);
                pathD += (!segmentOpen ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
                segmentOpen = true;
                dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${color}"/>`;
            });

            const svg = `
                <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
                    ${dots}
                </svg>`;

            return { svg, vMax };
        }

        // Orange/coral accent (not a new color -- the same #AA6747 the
        // Pause Ratio Trend widget already uses for its "second" line)
        // so Repetition Rate reads as clearly distinct from Speech
        // Rate's blue without introducing a hue nothing else in this
        // file uses.
        const speech = buildMiniChart("speech", "#6ea8fe");
        const rep = buildMiniChart("rep", "#AA6747");

        // maxTicks = n -- label every recording, not a sparse subset,
        // same convention as Interval Stability Trend / Pause Ratio
        // Trend above.
        const ticks = sparseIndexTicks(n, n, (i) => String(i + 1), (i) => fracs[i]);

        // Each mini-chart's unit label sits as a small caps caption
        // directly above its own plot (left-aligned, .area-axis-title's
        // existing type treatment) rather than the rotated
        // .area-yaxis-wrap side-label used for a single big chart
        // elsewhere in this file -- with two stacked mini-charts, a
        // caption per chart reads faster than a rotated label the eye
        // has to tilt for, and it frees the width that column would
        // otherwise take from both plots. The bare (non-wrap) 30px
        // .area-yaxis column still carries this chart's own tick
        // values underneath it.
        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Rate Trend</div>
                        <div class="area-sub">Speech Rate &amp; DDK Repetition Rate across ${n} DDK recordings - independent scales, plotted separately</div>
                    </div>
                    <div class="area-range-pill">${n} recording${n === 1 ? "" : "s"}</div>
                </div>
                <div class="area-body" style="flex-direction:column;gap:6px;">
                    <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-height:0;">
                        <div class="area-axis-title" style="text-align:left;margin-top:0;color:#6ea8fe;">Speech Rate (syll/s)</div>
                        <div style="flex:1;display:flex;gap:8px;min-height:0;">
                            <div class="area-yaxis">
                                <span>${fmt(speech.vMax, 1)}</span>
                                <span>${fmt(speech.vMax / 2, 1)}</span>
                                <span>0.0</span>
                            </div>
                            <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${speech.svg}<div class="ddk-tooltip"></div></div>
                        </div>
                    </div>
                    <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-height:0;">
                        <div class="area-axis-title" style="text-align:left;margin-top:0;color:#AA6747;">Repetition Rate (rep/s)</div>
                        <div style="flex:1;display:flex;gap:8px;min-height:0;">
                            <div class="area-yaxis">
                                <span>${fmt(rep.vMax, 1)}</span>
                                <span>${fmt(rep.vMax / 2, 1)}</span>
                                <span>0.0</span>
                            </div>
                            <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${rep.svg}<div class="ddk-tooltip"></div></div>
                        </div>
                    </div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer" style="width:30px;"></div>
                    <div class="area-xaxis--labeled" style="flex:1;display:flex;flex-direction:column;">
                        <div class="area-xaxis--precise" style="flex:none;">
                            ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                        </div>
                        <div class="area-axis-title">Recording #</div>
                    </div>
                </div>
                <div class="area-legend" style="padding-left:38px;">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>Speech Rate</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#AA6747"></span>DDK Repetition Rate</div>
                </div>
            </div>`;

        // Two independent hover tooltips, one per mini-chart -- same
        // .ddk-chart-wrap/.ddk-tooltip shell and nearest-by-x-fraction
        // snap as the other DDK trend graphs above, wired up twice so
        // hovering the top chart never touches the bottom one's tooltip.
        // Each only shows for recordings where THAT chart's own rate is
        // valid (gap-aware, matching the skipped-point line drawing
        // above) -- hovering a gap just hides the tooltip instead of
        // showing a stale/wrong value.
        function wireTooltip(chartWrap, tooltip, key, color, unitLabel, vMax) {
            const yAt = (v) => baseY - (Math.max(0, v) / vMax) * plotH;
            chartWrap.addEventListener("mousemove", (e) => {
                const rect = chartWrap.getBoundingClientRect();
                const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                let nearestIdx = 0, nearestDist = Infinity;
                fracs.forEach((f, i) => {
                    const d = Math.abs(f - relX);
                    if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
                });
                const t = master[nearestIdx];
                const v = t[key];
                if (typeof v !== "number") {
                    tooltip.classList.remove("visible");
                    return;
                }

                tooltip.innerHTML = `
                    <div class="ddk-tooltip-title">${fullDate(t.createdAt)}</div>
                    <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${color}"></span>${fmt(v, 2)} ${unitLabel}</div>`;
                tooltip.classList.add("visible");
                const wrapW = rect.width;
                tooltip.style.left = Math.max(60, Math.min(wrapW - 60, fracs[nearestIdx] * wrapW)) + "px";
                // Anchored above the hovered point's own screen position
                // (not a fixed top offset) -- .ddk-chart-wrap's overflow
                // is visible now, so this can float past the card's edge.
                const pointScreenY = (yAt(v) / H) * rect.height;
                tooltip.style.top = (pointScreenY - tooltip.offsetHeight - 10) + "px";
            });

            chartWrap.addEventListener("mouseleave", () => {
                tooltip.classList.remove("visible");
            });
        }

        const chartWraps = container.querySelectorAll(".ddk-chart-wrap");
        const tooltips = container.querySelectorAll(".ddk-tooltip");
        wireTooltip(chartWraps[0], tooltips[0], "speech", "#6ea8fe", "syll/s", speech.vMax);
        wireTooltip(chartWraps[1], tooltips[1], "rep", "#AA6747", "rep/s", rep.vMax);
    }


    // Real scalar already available via getDdkValuesForTarget() (works
    // for a single recording or a subject aggregate alike) --
    // no contour fetch needed.
    function renderPauseRatio(container) {
        const vals = getDdkValuesForTarget();
        if (!vals || typeof vals.pauseSpeechRatio !== "number") {
            container.innerHTML = graphEmptyStateHTML("Pause Ratio");
            return;
        }
        const ratio = vals.pauseSpeechRatio; // pause : speech
        const pausePct = (ratio / (ratio + 1)) * 100;
        const voicedPct = 100 - pausePct;

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Pause Ratio</div>
                        <div class="area-sub">Voiced vs. paused time across the run</div>
                    </div>
                    <div class="area-range-pill">${fmt(ratio, 2)} : 1 pause:speech</div>
                </div>
                <div class="area-body">
                    <div class="pr-body">
                        <div class="pr-bar-wrap">
                            <div class="pr-seg pr-seg-voiced" style="flex:${Math.max(voicedPct, 0.001)}">${voicedPct >= 14 ? fmt(voicedPct, 0) + "%" : ""}</div>
                            <div class="pr-seg pr-seg-pause" style="flex:${Math.max(pausePct, 0.001)}">${pausePct >= 14 ? fmt(pausePct, 0) + "%" : ""}</div>
                        </div>
                        <div class="pr-caption">
                            <span>Voiced: <b>${fmt(voicedPct, 1)}%</b></span>
                            <span>Paused: <b>${fmt(pausePct, 1)}%</b></span>
                        </div>
                    </div>
                </div>
                <div class="area-legend">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>Voiced</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#3a3a3f"></span>Silence / pause</div>
                </div>
            </div>`;
    }

    // ---- DDK Summary ---------------------------------------------------
    // Three whole-recording scalars, intentionally axis-less -- real
    // values via getDdkValuesForTarget() (single recording or
    // subject aggregate alike).
    function statCardHtml(label, value, decimals, unit) {
        const v = typeof value === "number" ? fmt(value, decimals) : "\u2014";
        return `
            <div class="stat-card">
                <div class="stat-label">${label}</div>
                <div class="stat-value-row">
                    <span class="stat-value">${v}</span>
                    <span class="stat-unit">${unit}</span>
                </div>
            </div>`;
    }

    function renderDDKSummary(container) {
        const vals = getDdkValuesForTarget();
        if (!vals) { container.innerHTML = graphEmptyStateHTML("DDK Summary"); return; }

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">DDK Summary</div>
                        <div class="area-sub">Whole-recording scalars - no within-run axis</div>
                    </div>
                </div>
                <div class="area-body">
                    <div class="stat-cluster">
                        ${statCardHtml("Speech Rate", vals.speechRate, 2, "syll/s")}
                        ${statCardHtml("Repetition Rate", vals.ddkRepetitionRate, 2, "rep/s")}
                        ${statCardHtml("Repetition Count", vals.ddkRepetitionCount, 0, "reps")}
                    </div>
                </div>
            </div>`;
    }

    const SPECTRO_STOPS = [
        [0.00, [4, 8, 20]], [0.15, [10, 40, 95]], [0.35, [20, 110, 165]], [0.50, [35, 170, 150]],
        [0.65, [140, 205, 90]], [0.80, [240, 205, 60]], [0.90, [245, 140, 40]], [1.00, [230, 60, 50]],
    ];

    function spectroColor(t) {
        t = Math.max(0, Math.min(1, t));
        for (let i = 0; i < SPECTRO_STOPS.length - 1; i++) {
            const [t0, c0] = SPECTRO_STOPS[i];
            const [t1, c1] = SPECTRO_STOPS[i + 1];
            if (t >= t0 && t <= t1) {
                const f = (t - t0) / (t1 - t0 || 1);
                return [
                    Math.round(c0[0] + (c1[0] - c0[0]) * f),
                    Math.round(c0[1] + (c1[1] - c0[1]) * f),
                    Math.round(c0[2] + (c1[2] - c0[2]) * f),
                ];
            }
        }
        return SPECTRO_STOPS[SPECTRO_STOPS.length - 1][1];
    }

    // Synthesizes a plausible harmonic spectrogram from the sustained-vowel
    // stats (F0/F1/F2/HNR) — a visual stand-in built from scalar features,
    // not a real STFT of the waveform. Used as the fallback when there's no
    // single recording to run a real STFT on (a subject aggregate
    // target has no one waveform), or if the real fetch below fails. See
    // renderRealSpectrogram for the real compute_spectrogram() output.
    function synthesizeSpectrogram(timeSteps, freqBins, maxFreq, vals) {
        const grid = new Float32Array(timeSteps * freqBins);
        const f0 = vals.f0Mean, f1 = vals.f1Mean, f2 = vals.f2Mean;
        const hnrNorm = Math.max(0, Math.min(1, vals.hnr / 25));
        const numHarmonics = Math.floor(maxFreq / f0);
        for (let t = 0; t < timeSteps; t++) {
            const time = t / timeSteps;
            const envelope = 0.75 + 0.25 * Math.sin(time * Math.PI * 6 + Math.sin(time * 17) * 0.5);
            for (let hIdx = 1; hIdx <= numHarmonics; hIdx++) {
                const freq = hIdx * f0;
                const freqRow = Math.round((freq / maxFreq) * (freqBins - 1));
                if (freqRow < 0 || freqRow >= freqBins) continue;
                let amp = 1 / Math.sqrt(hIdx);
                const distF1 = freq - f1, distF2 = freq - f2;
                amp *= 1 + 2.2 * Math.exp(-(distF1 * distF1) / (2 * 70 * 70));
                amp *= 1 + 1.6 * Math.exp(-(distF2 * distF2) / (2 * 90 * 90));
                amp *= envelope;
                for (let dr = -1; dr <= 1; dr++) {
                    const row = freqRow + dr;
                    if (row < 0 || row >= freqBins) continue;
                    const spread = dr === 0 ? 1 : 0.4;
                    const idx = t * freqBins + row;
                    grid[idx] = Math.max(grid[idx], amp * spread);
                }
            }
            const noiseAmt = (1 - hnrNorm) * 0.18;
            for (let r = 0; r < freqBins; r++) {
                const idx = t * freqBins + r;
                grid[idx] += noiseAmt * Math.random() * (1 - (r / freqBins) * 0.4);
            }
        }
        let maxV = 0;
        for (let i = 0; i < grid.length; i++) maxV = Math.max(maxV, grid[i]);
        if (maxV <= 0) maxV = 1;
        for (let i = 0; i < grid.length; i++) grid[i] = Math.min(1, grid[i] / maxV);
        return grid;
    }

    function drawSpectrogram(canvas, vals) {
        const timeSteps = 220, freqBins = 100, maxFreq = 4000;
        const grid = synthesizeSpectrogram(timeSteps, freqBins, maxFreq, vals);
        const off = document.createElement("canvas");
        off.width = timeSteps; off.height = freqBins;
        const octx = off.getContext("2d");
        const imgData = octx.createImageData(timeSteps, freqBins);
        for (let t = 0; t < timeSteps; t++) {
            for (let r = 0; r < freqBins; r++) {
                const v = grid[t * freqBins + r];
                const [cr, cg, cb] = spectroColor(v);
                const y = freqBins - 1 - r; // low frequency at the bottom
                const idx = (y * timeSteps + t) * 4;
                imgData.data[idx] = cr; imgData.data[idx + 1] = cg; imgData.data[idx + 2] = cb; imgData.data[idx + 3] = 255;
            }
        }
        octx.putImageData(imgData, 0, 0);
        const wrap = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        const cssW = wrap.clientWidth || 640, cssH = wrap.clientHeight || 288;
        canvas.width = cssW * dpr; canvas.height = cssH * dpr;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    }

    // Paints a REAL freq/time/magnitude-dB grid (from
    // GET /api/subjects/{id}/recordings/{id}/spectrogram, i.e. actual
    // compute_spectrogram() STFT output) instead of a synthesized one.
    // magnitudeDb is [freq_bins][time_bins], low frequency first (see
    // the route's docstring). Colored relative to a fixed 60dB dynamic
    // range below the grid's own peak -- a typical display range for a
    // speech spectrogram, and self-normalizing per recording so a quiet
    // vs. loud take both render with usable contrast.
    const SPECTROGRAM_DISPLAY_RANGE_DB = 60;

    function drawSpectrogramGrid(canvas, freqs, times, magnitudeDb) {
        const freqBins = magnitudeDb.length;
        const timeSteps = freqBins > 0 ? magnitudeDb[0].length : 0;
        if (freqBins === 0 || timeSteps === 0) return;

        let maxDb = -Infinity;
        for (let r = 0; r < freqBins; r++) {
            const row = magnitudeDb[r];
            for (let t = 0; t < timeSteps; t++) {
                if (row[t] > maxDb) maxDb = row[t];
            }
        }
        const dbFloor = maxDb - SPECTROGRAM_DISPLAY_RANGE_DB;
        const dbRange = maxDb - dbFloor || 1;

        const off = document.createElement("canvas");
        off.width = timeSteps; off.height = freqBins;
        const octx = off.getContext("2d");
        const imgData = octx.createImageData(timeSteps, freqBins);
        for (let t = 0; t < timeSteps; t++) {
            for (let r = 0; r < freqBins; r++) {
                const norm = Math.max(0, Math.min(1, (magnitudeDb[r][t] - dbFloor) / dbRange));
                const [cr, cg, cb] = spectroColor(norm);
                const y = freqBins - 1 - r; // low frequency at the bottom
                const idx = (y * timeSteps + t) * 4;
                imgData.data[idx] = cr; imgData.data[idx + 1] = cg; imgData.data[idx + 2] = cb; imgData.data[idx + 3] = 255;
            }
        }
        octx.putImageData(imgData, 0, 0);
        const wrap = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        const cssW = wrap.clientWidth || 640, cssH = wrap.clientHeight || 288;
        canvas.width = cssW * dpr; canvas.height = cssH * dpr;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    }

    function formatFreqAxisLabel(hz) {
        if (hz <= 0) return "0";
        if (hz >= 1000) {
            const k = hz / 1000;
            return (Math.round(k * 10) / 10).toString().replace(/\.0$/, "") + "k";
        }
        return String(Math.round(hz));
    }

    // `showRangeControl` renders the frequency-range pill (the "0–4k Hz ⌄"
    // element) in the header. It's only useful for DDK, where wider bursts
    // can have meaningful energy above 4kHz — for Sustained Vowel the
    // range is always a fixed 0–4kHz (formants live well under that), so
    // there's nothing to switch between and the (currently non-functional)
    // dropdown-look control is hidden rather than shown for no reason.
    function spectroMarkup(rangeLabel, yLabels, xLabels, showRangeControl) {
        return `
            <div class="spectro-root">
                <div class="spectro-header">
                    <div>
                        <div class="spectro-title">Spectrogram</div>
                        <div class="spectro-sub">Voice energy across time and frequency</div>
                    </div>
                    ${showRangeControl ? `
                    <div class="spectro-range-pill">
                        ${rangeLabel}
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                    </div>` : ""}
                </div>
                <div class="spectro-body">
                    <div class="spectro-yaxis">${yLabels.map((l) => `<span>${l}</span>`).join("")}</div>
                    <div class="spectro-canvas-wrap">
                        <canvas class="spectro-canvas"></canvas>
                        <div class="spectro-gridlines"></div>
                    </div>
                </div>
                <div class="spectro-xaxis-row">
                    <div class="spectro-xaxis-spacer"></div>
                    <div class="spectro-xaxis">${xLabels.map((l) => `<span>${l}</span>`).join("")}</div>
                </div>
                <div class="spectro-legend">
                    <span class="spectro-legend-label">LOW</span>
                    <div class="spectro-legend-bar"></div>
                    <span class="spectro-legend-label">HIGH</span>
                </div>
            </div>`;
    }

    function renderSynthesizedSpectrogram(container, vals) {
        const maxFreq = 4000, duration = 3.0;
        container.innerHTML = spectroMarkup(
            "0\u20134 kHz",
            ["4k", "3k", "2k", "1k", "0"],
            ["0.0s", "0.75s", "1.5s", "2.25s", "3.0s"],
            false, // Sustained-only fallback (see getSustainedValuesForTarget below) -- no range control
        );
        const canvas = container.querySelector(".spectro-canvas");
        drawSpectrogram(canvas, vals);
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => drawSpectrogram(canvas, vals));
            ro.observe(canvas.parentElement);
            pinboardResizeObservers.push(ro);
        }
    }

    // Loads the real STFT grid for a single recording and paints it in
    // place of the synthesized stand-in. `token` guards against a stale
    // response landing after the user has switched targets or the
    // widget has re-rendered again in the meantime -- same pattern as
    // renderRealAudioWaveform above.
    let _rtSpectrogramTokenCounter = 0;

    function renderRealSpectrogram(container, opts) {
        const token = String(++_rtSpectrogramTokenCounter);
        container.dataset.rtSpectrogramToken = token;
        container.innerHTML = `<div class="pinboard-widget-empty">Loading spectrogram\u2026</div>`;

        api.getRecordingSpectrogram(opts.subjectId, opts.recordingId).then((data) => {
            if (container.dataset.rtSpectrogramToken !== token) return; // stale — target/widget moved on
            const freqs = data.freqs || [];
            const times = data.times || [];
            const magnitudeDb = data.magnitude_db || [];
            if (!freqs.length || !times.length || !magnitudeDb.length) {
                if (opts.fallback) opts.fallback();
                else container.innerHTML = graphEmptyStateHTML("Spectrogram");
                return;
            }

            const freqMax = freqs[freqs.length - 1];
            const duration = times[times.length - 1];
            const yLabels = [1, 0.75, 0.5, 0.25, 0].map((f) => formatFreqAxisLabel(freqMax * f));
            const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => (duration * f).toFixed(2) + "s");
            container.innerHTML = spectroMarkup(
                `0\u2013${formatFreqAxisLabel(freqMax)} Hz`,
                yLabels,
                xLabels,
                !opts.isSustained, // hide the range control for Sustained Vowel (fixed 0–4kHz)
            );
            const canvas = container.querySelector(".spectro-canvas");
            drawSpectrogramGrid(canvas, freqs, times, magnitudeDb);
            if (window.ResizeObserver) {
                const ro = new ResizeObserver(() => drawSpectrogramGrid(canvas, freqs, times, magnitudeDb));
                ro.observe(canvas.parentElement);
                pinboardResizeObservers.push(ro);
            }
        }).catch((err) => {
            if (container.dataset.rtSpectrogramToken !== token) return;
            console.error(err);
            if (opts.fallback) opts.fallback();
            else container.innerHTML = graphEmptyStateHTML("Spectrogram");
        });
    }

    // Entry point for the Spectrogram widget. A single recording has a
    // real WAV file behind it, so try the real STFT first, falling
    // back to the synthesized harmonic stand-in only if that specific
    // recording's fetch fails. A subject aggregate target has no
    // single waveform a spectrogram can be computed from -- there's
    // no meaningful way to average multiple STFT grids -- so it shows
    // the empty state rather than a synthesized stand-in that could be
    // mistaken for real data.
    function renderSpectrogram(container) {
        if (analysisTargetType === "recording" && analysisTargetRef) {
            const subjectId = analysisTargetRef.subjectId
                || (analysisTargetRef._raw && analysisTargetRef._raw.subject_id);
            const recordingId = analysisTargetRef.id
                || (analysisTargetRef._raw && analysisTargetRef._raw.recording_id);
            if (subjectId && recordingId) {
                const vals = getSustainedValuesForTarget();
                const isSustained = getDirectRecordingValueType() === "Sustained";
                renderRealSpectrogram(container, {
                    subjectId,
                    recordingId,
                    isSustained,
                    fallback: () => {
                        // Never show a synthesised stand-in as if it were the
                        // recording -- a clinician can't tell it's fabricated.
                        container.innerHTML = graphEmptyStateHTML("Spectrogram (audio unavailable)");
                    },
                });
                return;
            }
        }

        container.innerHTML = graphEmptyStateHTML("Spectrogram");
    }

    // ---- Formants graph content ----
    function fmt(v, d) {
        return Number(v).toFixed(d === undefined ? 1 : d);
    }

    function svgWrap(title, inner, filterIds, w, h) {
        w = w || 320; h = h || 200;
        const defs = filterIds.map((id) => `
            <filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="2.2" result="blur"/>
                <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>`).join("");
        return `
            <svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
                <defs>${defs}</defs>
                <text x="14" y="22" fill="var(--text-muted)" font-size="11" letter-spacing="1">${title.toUpperCase()}</text>
                ${inner}
            </svg>`;
    }

    function barChartSVG(id, title, bars) {
        const W = 320, H = 200, top = 46, baseline = 168, maxH = baseline - top;
        const n = bars.length, gap = 22, barW = (W - gap * (n + 1)) / n;
        let body = `<line x1="${gap - 8}" y1="${baseline}" x2="${W - gap + 8}" y2="${baseline}" stroke="var(--border-strong)"/>`;
        bars.forEach((b, i) => {
            const frac = Math.max(0, Math.min(1, b.value / b.max));
            const bh = frac * maxH;
            const x = gap + i * (barW + gap);
            const y = baseline - bh;
            body += `
                <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" fill="var(--text-primary)" opacity="0.92" filter="url(#glow-${id})"/>
                <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" fill="var(--text-primary)" font-size="12" font-weight="700">${fmt(b.value)}${b.unit}</text>
                <text x="${x + barW / 2}" y="${baseline + 18}" text-anchor="middle" fill="var(--text-muted)" font-size="9" letter-spacing="0.5">${b.label.toUpperCase()}</text>`;
        });
        return svgWrap(title, body, [`glow-${id}`], W, H);
    }

    function renderFormants(container) {
        const vals = getSustainedValuesForTarget();
        if (!vals) { container.innerHTML = graphEmptyStateHTML("Formants"); return; }
        container.innerHTML = barChartSVG("formants", "Formant Means", [
            { label: "F0", value: vals.f0Mean, max: 400, unit: "Hz" },
            { label: "F1", value: vals.f1Mean, max: 1200, unit: "Hz" },
            { label: "F2", value: vals.f2Mean, max: 3000, unit: "Hz" },
        ]);
    }

    function ringGaugeSVG(id, title, a, b) {
        const W = 320, H = 200, r = 40, c = 2 * Math.PI * r, cy = 96;
        const cxA = 92, cxB = 228;
        function ring(cx, frac, fid) {
            const dash = c * Math.max(0, Math.min(1, frac));
            return `
                <circle cx="${cx}" cy="${cy}" r="${r}" stroke="var(--chart-ring-track)" stroke-width="8" fill="none"/>
                <circle cx="${cx}" cy="${cy}" r="${r}" stroke="var(--text-primary)" stroke-width="8" fill="none"
                    stroke-dasharray="${dash} ${c}" stroke-linecap="round"
                    transform="rotate(-90 ${cx} ${cy})" filter="url(#${fid})"/>`;
        }
        const body = `
            ${ring(cxA, a.value / a.max, `glow-${id}-a`)}
            ${ring(cxB, b.value / b.max, `glow-${id}-b`)}
            <text x="${cxA}" y="${cy - 2}" text-anchor="middle" fill="var(--text-primary)" font-size="16" font-weight="700">${fmt(a.value, 2)}</text>
            <text x="${cxA}" y="${cy + 14}" text-anchor="middle" fill="var(--text-muted)" font-size="9">${a.unit}</text>
            <text x="${cxA}" y="${cy + 56}" text-anchor="middle" fill="var(--text-muted)" font-size="9" letter-spacing="0.5">${a.label.toUpperCase()}</text>
            <text x="${cxB}" y="${cy - 2}" text-anchor="middle" fill="var(--text-primary)" font-size="16" font-weight="700">${fmt(b.value, 2)}</text>
            <text x="${cxB}" y="${cy + 14}" text-anchor="middle" fill="var(--text-muted)" font-size="9">${b.unit}</text>
            <text x="${cxB}" y="${cy + 56}" text-anchor="middle" fill="var(--text-muted)" font-size="9" letter-spacing="0.5">${b.label.toUpperCase()}</text>`;
        return svgWrap(title, body, [`glow-${id}-a`, `glow-${id}-b`], W, H);
    }

    function renderVoiceQuality(container) {
        const vals = getSustainedValuesForTarget();
        if (!vals) { container.innerHTML = graphEmptyStateHTML("Voice Quality"); return; }
        container.innerHTML = ringGaugeSVG("voice-quality", "Voice Quality",
            { label: "HNR", value: vals.hnr, max: 30, unit: "dB" },
            { label: "Jitter", value: vals.jitterLocal, max: 1, unit: "%" });
    }

    // ---- MDVP Voice Profile (classic KayPENTAX-style spider chart) -----
    //
    // One spoke per acoustic parameter, a shared green "normative" ring,
    // and the patient's values connected into a polygon -- a spike
    // poking outside the ring flags which specific dimension (pitch,
    // jitter, HNR) is driving an abnormal voice. Reads the same
    // getSustainedValuesForTarget() scalars Formants/Voice Quality
    // already use (f0Mean/f0Min/f0Max/hnr/jitterLocal) -- no new
    // backend endpoint, this is a different view of data already on
    // the page.
    //
    // The core trick that makes ONE ring work as a shared normal-range
    // boundary across 3 different units (Hz, dB, %) is mdvpSeverity()
    // below: every spoke is independently rescaled so its OWN clinical
    // cutoff always lands at exactly RING_FRAC of that spoke's radius,
    // regardless of the spoke's actual unit or scale. Radial position
    // is therefore a severity fraction, not the raw value -- the raw
    // value only ever appears in the perimeter label text.
    const RING_FRAC = 0.5;

    // param.direction is one of:
    //   "band"       -- F0 Mean/Min/Max: a normal range [low, high]. Deviation
    //                    is distance from the range's midpoint.
    //   "lower-bad"  -- HNR: normGood is the ideal (higher is better),
    //                    normLow is the cutoff below which it's abnormal.
    //                    Deviation is how far BELOW normGood the value sits
    //                    (values at/above normGood get deviation 0 -- better
    //                    than ideal is never "bad").
    //   "higher-bad" -- Jitter: 0 is ideal, normHigh is the cutoff above
    //                    which it's abnormal. Deviation is just the value
    //                    itself (clamped at 0).
    // All three reduce to the same shape once you have a deviation and a
    // cutoff deviation: 0..cutoff maps onto [0, RING_FRAC], and anything
    // past cutoff maps onto [RING_FRAC, 1] over a further 1.4x-of-cutoff
    // span, clamped at 1 -- so one wildly extreme outlier still lands on
    // the chart instead of flying off it.
    function mdvpSeverity(param) {
        let deviation, cutoff;
        if (param.direction === "higher-bad") {
            deviation = Math.max(0, param.value);
            cutoff = param.normHigh;
        } else if (param.direction === "lower-bad") {
            deviation = Math.max(0, param.normGood - param.value);
            cutoff = param.normGood - param.normLow;
        } else { // "band"
            const mid = (param.low + param.high) / 2;
            deviation = Math.abs(param.value - mid);
            cutoff = (param.high - param.low) / 2;
        }
        const extension = cutoff * 1.4;
        let frac;
        if (deviation <= cutoff) {
            frac = cutoff > 0 ? (deviation / cutoff) * RING_FRAC : 0;
        } else {
            const beyond = Math.min(deviation - cutoff, extension);
            frac = RING_FRAC + (extension > 0 ? (beyond / extension) * (1 - RING_FRAC) : 0);
        }
        return { frac: Math.max(0, Math.min(1, frac)), flagged: frac > RING_FRAC };
    }

    // The 5 spokes -- norm ranges/cutoffs are standard MDVP-style
    // reference values for sustained /a/, not derived from this
    // subject's own data.
        function buildMDVPParams(vals) {
        // Sex-specific adult F0 bands (sustained /a/): male ~85-180 Hz,
        // female ~165-255 Hz; unknown sex keeps the wide 100-300 band.
        const sex = selectedSubject && selectedSubject.sex;
        const band = sex === "Male" ? { low: 85, high: 180 }
                   : sex === "Female" ? { low: 165, high: 255 }
                   : { low: 100, high: 300 };
        return [
            { key: "f0Mean", label: "F0 Mean", unit: "Hz", value: vals.f0Mean, direction: "band", ...band },
            { key: "f0Min", label: "F0 Min", unit: "Hz", value: vals.f0Min, direction: "band", ...band },
            { key: "f0Max", label: "F0 Max", unit: "Hz", value: vals.f0Max, direction: "band", ...band },
            { key: "hnr", label: "HNR", unit: "dB", value: vals.hnr, direction: "lower-bad", normLow: 15.0, normGood: 25.0 },
            { key: "jitterLocal", label: "Jitter", unit: "%", value: vals.jitterLocal, direction: "higher-bad", normHigh: 1.040 },
        ];
    }

    // Generic n-spoke radial/spider chart -- takes any `params` array (not
    // just MDVP's 5) plus a pixel `size`, so it's reusable beyond this one
    // widget. Each param needs {label, unit, value} and whatever
    // mdvpSeverity() needs to score it; angle 0 (top, 12 o'clock) is
    // param index 0, going clockwise.
    function radialSpiderSVG(params, size) {
        const cx = size / 2, cy = size / 2;
        const R = size / 2 - 46; // leave room for the perimeter labels outside the 100% ring
        const n = params.length;
        const angleAt = (i) => -Math.PI / 2 + i * (2 * Math.PI / n);
        const ptAt = (frac, i) => {
            const a = angleAt(i);
            return { x: cx + frac * R * Math.cos(a), y: cy + frac * R * Math.sin(a) };
        };

        // Background grid: dashed rings at 25%/75%, a solid one at 100%,
        // and straight spokes from center to each vertex.
        let grid = "";
        [0.25, 0.75].forEach((f) => {
            grid += `<circle cx="${cx}" cy="${cy}" r="${(f * R).toFixed(2)}" fill="none" stroke="#232327" stroke-width="1" stroke-dasharray="3,3"/>`;
        });
        grid += `<circle cx="${cx}" cy="${cy}" r="${R.toFixed(2)}" fill="none" stroke="#232327" stroke-width="1"/>`;
        for (let i = 0; i < n; i++) {
            const p = ptAt(1, i);
            grid += `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}" stroke="#232327" stroke-width="1"/>`;
        }

        // The shared normative ring -- a plain circle at RING_FRAC radius.
        // It only has to be one circle (not a per-spoke polygon) because
        // mdvpSeverity() already did the work of rescaling every spoke's
        // own clinical cutoff to land exactly here.
        const ring = `<circle cx="${cx}" cy="${cy}" r="${(RING_FRAC * R).toFixed(2)}" fill="rgba(63,209,133,0.13)" stroke="rgba(63,209,133,0.55)" stroke-width="1.5"/>`;

        const sev = params.map((p) => mdvpSeverity(p));

        let polyPts = "";
        params.forEach((p, i) => {
            const pt = ptAt(sev[i].frac, i);
            polyPts += `${pt.x.toFixed(2)},${pt.y.toFixed(2)} `;
        });
        const polygon = `<polygon points="${polyPts.trim()}" fill="rgba(255,255,255,0.10)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>`;

        let dots = "";
        params.forEach((p, i) => {
            const pt = ptAt(sev[i].frac, i);
            dots += `<circle cx="${pt.x.toFixed(2)}" cy="${pt.y.toFixed(2)}" r="3.6" fill="${sev[i].flagged ? "#ff6b6b" : "#ffffff"}"/>`;
        });

        // Perimeter labels sit just outside the 100% ring -- text-anchor
        // depends on which side of the circle the spoke lands on (cosine
        // of its angle), so labels on the right read left-to-right away
        // from the chart, labels on the left read right-to-left away from
        // it, and labels near the top/bottom center on the point.
        let labels = "";
        params.forEach((p, i) => {
            const cosA = Math.cos(angleAt(i));
            const anchor = cosA > 0.3 ? "start" : (cosA < -0.3 ? "end" : "middle");
            const lp = ptAt(1.2, i);
            const color = sev[i].flagged ? "#ff8a8a" : "#c7c7cd";
            const decimals = p.unit === "%" ? 3 : (p.unit === "dB" ? 1 : 0);
            labels += `
                <text x="${lp.x.toFixed(2)}" y="${(lp.y - 4).toFixed(2)}" text-anchor="${anchor}" fill="${color}" font-size="10" font-weight="700">${p.label}</text>
                <text x="${lp.x.toFixed(2)}" y="${(lp.y + 9).toFixed(2)}" text-anchor="${anchor}" fill="${color}" font-size="9.5" opacity="0.85">${fmt(p.value, decimals)}${p.unit}</text>`;
        });

        return `
            <svg viewBox="0 0 ${size} ${size}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
                ${grid}
                ${ring}
                ${polygon}
                ${dots}
                ${labels}
            </svg>`;
    }

    // Registered under the display title "MDVP Profile" (the GRAPH_RENDERERS
    // key every sidebar button/renderer in this file is looked up by --
    // see the SIDEBAR_LAYOUTS comment above). Recording-only, same as
    // DDK Waveform/Pitch Waveform/Spectrogram (see
    // updateWidgetButtonsAvailability) -- unlike Formants/Voice Quality's
    // plain scalar bars/rings, this widget's whole point is a single
    // sample's diagnostic profile, so it's left out of every
    // *_multi/mixed sidebar section and guards against a subject
    // target directly here too, in case an already-open widget's target
    // changes underneath it.
    function renderMDVPSpider(container) {
        if (analysisTargetType !== "recording") {
            container.innerHTML = graphEmptyStateHTML("MDVP Profile");
            return;
        }

        const vals = getSustainedValuesForTarget();
        if (!vals) { container.innerHTML = graphEmptyStateHTML("MDVP Profile"); return; }

        const params = buildMDVPParams(vals);
        // A spoke with no value would silently collapse to the chart's
        // center, which reads as "perfectly normal" rather than "no
        // data" -- so any missing scalar falls back to the same empty
        // state as everywhere else in this file instead of drawing a
        // misleading partial spider.
        if (params.some((p) => typeof p.value !== "number")) {
            container.innerHTML = graphEmptyStateHTML("MDVP Profile");
            return;
        }

        const flaggedCount = params.filter((p) => mdvpSeverity(p).flagged).length;
        const svg = radialSpiderSVG(params, 300);

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">MDVP Voice Profile</div>
                        <div class="area-sub">Multi-dimensional voice program - sustained /a/</div>
                    </div>
                    <div class="area-range-pill" style="${flaggedCount ? "color:#ff8a8a;border-color:rgba(255,107,107,0.35);" : ""}">${flaggedCount ? `${flaggedCount} of ${params.length} outside range` : "All within normal range"}</div>
                </div>
                <div class="area-body" style="align-items:center;justify-content:center;">
                    <div style="width:100%;max-width:300px;aspect-ratio:1;flex-shrink:0;">${svg}</div>
                </div>
                <div class="area-legend">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#3fd185"></span>Normative range</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ffffff"></span>Patient value</div>
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>Outside range</div>
                </div>
            </div>`;
    }

    // ---- Vowel Space (F1-F2) chart ---------------------------------------
    // A 2D tongue-position chart, not a time series and not a
    // deviation-from-normative chart like MDVP. Both axes are inverted on
    // purpose so the plot mirrors a sagittal (side-view) diagram of the
    // mouth:
    //   X = F2, inverted -> high F2 (front) plots LEFT, low F2 (back) plots RIGHT
    //   Y = F1, inverted -> low F1 (tongue high) plots TOP, high F1 (tongue low) plots BOTTOM
    // Concretely that just means F1 maps directly to SVG y (already
    // increases downward) and F2 maps to SVG x in reverse -- no double
    // negative to get wrong.
    //
    // Generic and mode-driven so every vowel-space presentation shares one
    // rendering path instead of forking: takes a single {f1Mean, f2Mean}
    // point (opts.mode = "point", one sustained-vowel recording -- see
    // renderVowelSpaceCard below), an array of points with opts.mode =
    // "trajectory" (open path, one point per RECORDING instead of one per
    // vowel token -- what the across-recordings widget below feeds it),
    // or opts.mode = "quadrilateral" (closed shape through 3+ points --
    // still unwired, no multi-vowel-token-per-recording data exists yet,
    // but the drawing path is ready for it).
    //
    // Optional opts for trajectory mode:
    //   baseline               {f1Mean, f2Mean} reference point to overlay
    //   defaultBaseline        value the "Reset to default" control restores
    //   onBaselineChange(next) called when the clinician edits the baseline
    //                          inputs or hits reset -- omit to render a
    //                          static baseline marker with no editable
    //                          controls
    //   subText                override the card's subtitle line
    //   endpointLabels         [firstLabel, lastLabel] for the trajectory legend
    function renderVowelSpaceChart(container, pointsInput, opts) {
        opts = opts || {};
        const points = Array.isArray(pointsInput) ? pointsInput : [pointsInput];
        const n = points.length;
        const mode = opts.mode || (n > 1 ? "quadrilateral" : "point");

        // Generous adult vowel-formant range (not a phonetic boundary
        // claim, just chart bounds) so a single point reads in context
        // instead of sitting dead-center with nothing to compare against.
        const domain = opts.domain || { f1Min: 200, f1Max: 1000, f2Min: 700, f2Max: 2500 };
        const W = 480, H = 380, padL = 10, padR = 10, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;

        const xAt = (f2) => padL + ((domain.f2Max - f2) / (domain.f2Max - domain.f2Min)) * plotW;
        const yAt = (f1) => padT + ((f1 - domain.f1Min) / (domain.f1Max - domain.f1Min)) * plotH;
        const clampVal = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

        const midF1 = (domain.f1Min + domain.f1Max) / 2;
        const midF2 = (domain.f2Min + domain.f2Max) / 2;

        // Front/back and high/low quadrant boundaries live at FIXED
        // formant values (midpoint of the full default range), not the
        // midpoint of whatever's currently zoomed/panned into view --
        // otherwise the divider (and the quadrant it implies a point sits
        // in) would silently redefine itself every time you scroll.
        // Clamped to the plot box so it still reads sensibly if you
        // zoom/pan past it.
        const REF_F1_MID = 600, REF_F2_MID = 1600;
        const crossX = clampVal(xAt(REF_F2_MID), padL, W - padR);
        const crossY = clampVal(yAt(REF_F1_MID), padT, H - padB);
        const crosshair = `
            <line x1="${crossX.toFixed(2)}" y1="${padT}" x2="${crossX.toFixed(2)}" y2="${H - padB}" stroke="#1c1c20" stroke-width="1"/>
            <line x1="${padL}" y1="${crossY.toFixed(2)}" x2="${W - padR}" y2="${crossY.toFixed(2)}" stroke="#1c1c20" stroke-width="1"/>`;

        // Labels ride next to the (real, fixed-value) divider instead of
        // pinning to the chart's four corners, so they pan/zoom with the
        // actual front/back-high/low boundary rather than staying put
        // while the data moves underneath them.
        const qLX = clampVal(crossX - 6, padL + 6, W - padR - 6);
        const qRX = clampVal(crossX + 6, padL + 6, W - padR - 6);
        const qTY = clampVal(crossY - 6, padT + 11, H - padB - 6);
        const qBY = clampVal(crossY + 15, padT + 11, H - padB - 6);

        // Soft orientation labels only -- deliberately not drawing precise
        // phonetic boundary curves, since no real reference data was given.
        const quadrantLabels = `
            <text x="${qLX.toFixed(2)}" y="${qTY.toFixed(2)}" fill="#4a4a52" font-size="12" font-weight="400" letter-spacing="0.5" text-anchor="end">FRONT &middot; HIGH</text>
            <text x="${qRX.toFixed(2)}" y="${qTY.toFixed(2)}" fill="#4a4a52" font-size="12" font-weight="400" letter-spacing="0.5" text-anchor="start">BACK &middot; HIGH</text>
            <text x="${qLX.toFixed(2)}" y="${qBY.toFixed(2)}" fill="#4a4a52" font-size="12" font-weight="400" letter-spacing="0.5" text-anchor="end">FRONT &middot; LOW</text>
            <text x="${qRX.toFixed(2)}" y="${qBY.toFixed(2)}" fill="#4a4a52" font-size="12" font-weight="400" letter-spacing="0.5" text-anchor="start">BACK &middot; LOW</text>`;

        // Baseline reference marker (diamond) + faint dashed crosshair
        // guides to both axes, drawn UNDER the trajectory/shape so the
        // real data reads on top of it.
        let baselineSvg = "";
        if (opts.baseline) {
            const bx = xAt(opts.baseline.f2Mean), by = yAt(opts.baseline.f1Mean);
            const s = 6;
            baselineSvg = `
                <line x1="${bx.toFixed(2)}" y1="${padT}" x2="${bx.toFixed(2)}" y2="${H - padB}" stroke="#c7c7cd" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
                <line x1="${padL}" y1="${by.toFixed(2)}" x2="${W - padR}" y2="${by.toFixed(2)}" stroke="#c7c7cd" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
                <polygon points="${bx.toFixed(2)},${(by - s).toFixed(2)} ${(bx + s).toFixed(2)},${by.toFixed(2)} ${bx.toFixed(2)},${(by + s).toFixed(2)} ${(bx - s).toFixed(2)},${by.toFixed(2)}" fill="#e8e8ec" stroke="#0a0a0b" stroke-width="1.2"/>`;
        }

        const screenPts = points.map((p) => ({ ...p, x: xAt(p.f2Mean), y: yAt(p.f1Mean) }));
        const endpointLabels = opts.endpointLabels || ["Onset", "Offset"];

        let shapeSvg = "", markersSvg = "";
        if (mode === "point") {
            const p = screenPts[0];
            shapeSvg = `
                <line x1="${p.x.toFixed(2)}" y1="${p.y.toFixed(2)}" x2="${p.x.toFixed(2)}" y2="${H - padB}" stroke="#6ea8fe" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
                <line x1="${padL}" y1="${p.y.toFixed(2)}" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}" stroke="#6ea8fe" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>`;
            markersSvg = `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="5.5" fill="#6ea8fe" stroke="#0a0a0b" stroke-width="1.5"/>`;
        } else if (mode === "trajectory") {
            let path = "";
            screenPts.forEach((p, i) => { path += (i === 0 ? "M" : "L") + `${p.x.toFixed(2)},${p.y.toFixed(2)} `; });
            shapeSvg = `<path d="${path}" fill="none" stroke="#6ea8fe" stroke-width="1.8" stroke-linejoin="round" opacity="0.9"/>`;
            markersSvg = screenPts.map((p, i) => {
                const isEnd = i === 0 || i === screenPts.length - 1;
                const color = i === 0 ? "#3fd185" : (i === screenPts.length - 1 ? "#ff6b6b" : "#6ea8fe");
                return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${isEnd ? 4.5 : 2.6}" fill="${color}"/>`;
            }).join("");
        } else {
            // quadrilateral -- closed shape through all supplied vowel tokens
            const path = "M" + screenPts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" L") + " Z";
            shapeSvg = `<path d="${path}" fill="rgba(110,168,254,0.14)" stroke="#6ea8fe" stroke-width="1.6" stroke-linejoin="round"/>`;
            markersSvg = screenPts.map((p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4.5" fill="#6ea8fe" stroke="#0a0a0b" stroke-width="1.2"/>`).join("");
        }

        const f1TickVals = [domain.f1Min, midF1, domain.f1Max];
        const f2TickVals = [domain.f2Max, midF2, domain.f2Min]; // left->right, descending (inverted axis)
        const yTicksHtml = f1TickVals.map((v) => `<span>${fmt(v, 0)}</span>`).join("");
        const xTicksHtml = f2TickVals.map((v) => `<span>${fmt(v, 0)}</span>`).join("");

        // Articulatory-range area (shoelace, in the F2xF1 plane) -- a
        // relative size metric only, for the still-unwired quadrilateral
        // mode. No collapse threshold is asserted since none has been
        // confirmed; the shape's size speaks for itself.
        let area = null;
        if (mode === "quadrilateral" && n >= 3) {
            let a = 0;
            for (let i = 0; i < n; i++) {
                const p1 = points[i], p2 = points[(i + 1) % n];
                a += p1.f2Mean * p2.f1Mean - p2.f2Mean * p1.f1Mean;
            }
            area = Math.abs(a) / 2;
        }

        let pillText;
        if (mode === "point") {
            pillText = `F1 ${fmt(points[0].f1Mean, 0)} Hz &middot; F2 ${fmt(points[0].f2Mean, 0)} Hz`;
        } else if (opts.baseline && mode === "trajectory") {
            const last = points[n - 1];
            const dist = Math.sqrt(Math.pow(last.f1Mean - opts.baseline.f1Mean, 2) + Math.pow(last.f2Mean - opts.baseline.f2Mean, 2));
            pillText = `Latest &Delta; ${fmt(dist, 0)} Hz from baseline`;
        } else if (area != null) {
            pillText = `Range &asymp; ${fmt(area, 0)} Hz&sup2;`;
        } else {
            pillText = `${n} vowel tokens`;
        }

        const subText = opts.subText || (mode === "point"
            ? "Sustained vowel - tongue position, sagittal orientation"
            : mode === "trajectory"
                ? "Onset&rarr;offset trajectory - tongue movement, sagittal orientation"
                : "Corner-vowel quadrilateral - articulatory range, sagittal orientation");

        // Baseline F1/F2 are plain editable numbers, not a normal-range
        // measure like MDVP's spokes, so their inputs use the file's CSS
        // variables inline rather than a new shared class for a control
        // that (so far) only ever appears on this one card. ".graph-
        // interactive" is the same escape hatch Pitch Waveform's play
        // button/seek bar already use so wireWidget()'s drag-start
        // handler leaves clicks/drags on these controls alone instead of
        // dragging the whole widget.
        const baselineControlsHtml = opts.onBaselineChange ? `
            <div class="graph-interactive" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.3px;">
                    Baseline F1
                    <input type="number" class="vs-baseline-f1" value="${Math.round(opts.baseline.f1Mean)}" step="10" style="width:64px;background:var(--bg-inset);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:inherit;font-size:11px;padding:4px 6px;">
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.3px;">
                    F2
                    <input type="number" class="vs-baseline-f2" value="${Math.round(opts.baseline.f2Mean)}" step="10" style="width:64px;background:var(--bg-inset);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:inherit;font-size:11px;padding:4px 6px;">
                </label>
                <button type="button" class="vs-baseline-reset" style="font-family:inherit;font-size:10px;color:var(--text-secondary);background:var(--bg-chip);border:1px solid var(--border);border-radius:6px;padding:5px 9px;cursor:pointer;">Reset to default</button>
            </div>` : "";

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Vowel Space (F1&ndash;F2)</div>
                        <div class="area-sub">${subText}</div>
                    </div>
                    <div class="area-range-pill">${pillText}</div>
                </div>
                ${baselineControlsHtml}
                <div class="area-body">
                    <div class="area-yaxis-wrap">
                        <div class="area-yaxis-label">F1 (Hz)</div>
                        <div class="area-yaxis">${yTicksHtml}</div>
                    </div>
                    <div class="area-chart-wrap vs-chart-wrap graph-interactive" style="cursor:grab;touch-action:none;position:relative;">
                        <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                            ${crosshair}
                            ${quadrantLabels}
                            ${baselineSvg}
                            ${shapeSvg}
                            ${markersSvg}
                        </svg>
                        <div class="vs-tooltip ddk-tooltip"></div>
                    </div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer" style="width:44px;"></div>
                    <div class="area-xaxis">${xTicksHtml}</div>
                </div>
                <div class="area-axis-title" style="padding-left:44px;">F2 (Hz)</div>
                <div class="area-legend" style="padding-left:44px;">
                    <div class="area-legend-item"><span class="area-legend-dot" style="background:#6ea8fe"></span>${mode === "point" ? "Patient vowel position" : "Vowel token"}</div>
                    ${mode === "quadrilateral" ? '<div class="area-legend-item"><span class="area-legend-dot" style="background:rgba(110,168,254,0.35)"></span>Articulatory range</div>' : ""}
                    ${mode === "trajectory" ? `<div class="area-legend-item"><span class="area-legend-dot" style="background:#3fd185"></span>${endpointLabels[0]}</div><div class="area-legend-item"><span class="area-legend-dot" style="background:#ff6b6b"></span>${endpointLabels[1]}</div>` : ""}
                    ${opts.baseline ? '<div class="area-legend-item"><span class="area-legend-dot" style="background:#e8e8ec"></span>Baseline (reference)</div>' : ""}
                </div>
            </div>`;

        if (opts.onBaselineChange) {
            const f1Input = container.querySelector(".vs-baseline-f1");
            const f2Input = container.querySelector(".vs-baseline-f2");
            const resetBtn = container.querySelector(".vs-baseline-reset");
            const commit = () => {
                const f1 = parseFloat(f1Input.value);
                const f2 = parseFloat(f2Input.value);
                if (!isNaN(f1) && !isNaN(f2)) opts.onBaselineChange({ f1Mean: f1, f2Mean: f2 });
            };
            // Same drag-start guard as Pitch Waveform's play button --
            // ".graph-interactive" above already makes wireWidget() skip
            // these, but stop propagation here too as defense in depth.
            [f1Input, f2Input, resetBtn].forEach((el) => el && el.addEventListener("mousedown", (e) => e.stopPropagation()));
            f1Input.addEventListener("change", commit);
            f2Input.addEventListener("change", commit);
            if (resetBtn && opts.defaultBaseline) {
                resetBtn.addEventListener("click", () => opts.onBaselineChange({ ...opts.defaultBaseline }));
            }
        }

        // Per-point hover -- which recording/token is THIS dot, not just
        // the pill's onset/latest summary. Only wired for multi-point
        // modes (trajectory, quadrilateral): a "point" mode chart is a
        // single dot already fully described by the header pill above,
        // so there's nothing a hover would disambiguate.
        if (screenPts.length > 1) {
            const chartWrap = container.querySelector(".vs-chart-wrap");
            const tooltip = container.querySelector(".vs-tooltip");
            const fullDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
            const HIT_RADIUS = 16; // svg-space (viewBox) units -- generous hit target around each ~4-5px-radius dot

            chartWrap.addEventListener("mousemove", (e) => {
                // Suppress mid-drag (attachVowelSpaceZoomPan sets this on
                // the same container passed in here) so the tooltip isn't
                // fighting the pan for attention.
                if (container._vsPanning) {
                    tooltip.classList.remove("visible");
                    return;
                }
                const rect = chartWrap.getBoundingClientRect();
                const relX = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
                const relY = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
                const vx = relX * W, vy = relY * H;

                let nearest = null, nearestIdx = -1, nearestDist = Infinity;
                screenPts.forEach((p, i) => {
                    const d = Math.hypot(p.x - vx, p.y - vy);
                    if (d < nearestDist) { nearestDist = d; nearest = p; nearestIdx = i; }
                });
                if (!nearest || nearestDist > HIT_RADIUS) {
                    tooltip.classList.remove("visible");
                    return;
                }

                const dateStr = fullDate(nearest.date);
                const distFromBaseline = opts.baseline
                    ? Math.sqrt(Math.pow(nearest.f1Mean - opts.baseline.f1Mean, 2) + Math.pow(nearest.f2Mean - opts.baseline.f2Mean, 2))
                    : null;
                tooltip.innerHTML = `
                    <div class="ddk-tooltip-title">${nearest.label || `Point ${nearestIdx + 1}`}${dateStr ? ` &middot; ${dateStr}` : ""}</div>
                    <div class="ddk-tooltip-row">F1 ${fmt(nearest.f1Mean, 0)} Hz</div>
                    <div class="ddk-tooltip-row">F2 ${fmt(nearest.f2Mean, 0)} Hz</div>
                    ${distFromBaseline != null ? `<div class="ddk-tooltip-row">${fmt(distFromBaseline, 0)} Hz from baseline</div>` : ""}`;
                tooltip.classList.add("visible");

                // Anchored to the hovered dot's own screen position, not
                // the raw cursor -- reads as "this is that point's info"
                // rather than a cursor-follower. Measured against the
                // tooltip's own (just-set) height so the box sits fully
                // above the dot instead of straddling it, and left
                // unclamped on the low end -- .vs-chart-wrap's overflow
                // is visible now, so it's free to float past the card's
                // top edge for a dot near the top of the plot.
                const screenX = (nearest.x / W) * rect.width;
                const screenY = (nearest.y / H) * rect.height;
                tooltip.style.left = Math.max(50, Math.min(rect.width - 50, screenX)) + "px";
                tooltip.style.top = (screenY - tooltip.offsetHeight - 10) + "px";
            });

            chartWrap.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));
        }
    }

    // Single-recording point view -- one sustained-vowel trial's own
    // tongue position. Registered as "Vowel Space" alongside MDVP
    // Profile in sustained_single only (see SIDEBAR_LAYOUTS below):
    // averaging this across a subject's several recordings
    // would blur exactly the per-trial signal it exists to show, which
    // is what the across-recordings Trajectory/Drift Trend widgets
    // below are for instead. Guards against a subject target
    // directly here too (same reasoning as MDVP Profile above), since
    // getSustainedValuesForTarget() itself happily falls back to a
    // subject's averaged vowel_mean and would otherwise render
    // a real (but misleadingly blended) dot if an already-open widget's
    // target ever changed underneath it.
    function renderVowelSpaceCard(container) {
        if (analysisTargetType !== "recording") {
            container.innerHTML = graphEmptyStateHTML("Vowel Space (F1-F2)");
            return;
        }
        const vals = getSustainedValuesForTarget();
        if (!vals || typeof vals.f1Mean !== "number" || typeof vals.f2Mean !== "number") {
            container.innerHTML = graphEmptyStateHTML("Vowel Space (F1-F2)");
            return;
        }
        renderVowelSpaceChart(container, { f1Mean: vals.f1Mean, f2Mean: vals.f2Mean }, { mode: "point" });
    }

    // ---- Vowel Space Trajectory (across-recordings) ----------------------
    // Only one vowel token is captured per recording (sustained /a/), so
    // there's no per-recording quadrilateral to draw -- instead this
    // tracks how that single point DRIFTS across recordings, reusing
    // renderVowelSpaceChart's "trajectory" mode above: one point per
    // recording instead of one point per vowel token within a recording.
    // Reads analysisTargetRef._summary.vowel_trials -- the same
    // per-recording array the Sustained Values widget's mean/SD already
    // reads -- no new backend endpoint.
    //
    // Baseline here is a CLINICIAN-EDITABLE reference point, unlike every
    // other longitudinal graph's automatic first-3-recordings mean. It's
    // initialized to that same first-3 mean (same inline slice(0,3)/
    // reduce pattern the other longitudinal graphs above use), but then
    // stored as mutable state ON THE TARGET (analysisTargetRef.
    // _vowelSpaceBaseline) -- same place _summary/_raw already live --
    // rather than a module-level variable or recomputed fresh every
    // render, so: (1) a clinician's edit survives redraws for as long as
    // this target stays the active one, (2) switching to a different
    // subject gets THAT target's own default instead of
    // inheriting whatever the last-viewed target's baseline was edited
    // to, and (3) switching back later restores the edit, since
    // ensureAnalysisSummary() mutates ref._summary in place rather than
    // replacing the ref object. If a per-recording point-mode Vowel Space
    // widget is ever wired up with its own baseline display, it should
    // read this same analysisTargetRef._vowelSpaceBaseline so the two
    // never disagree about "distance from baseline."
    function vowelSpaceBaselineFromTrials(points) {
        const baselineN = Math.min(3, points.length);
        const slice = points.slice(0, baselineN);
        const meanOf = (key) => slice.reduce((a, p) => a + p[key], 0) / baselineN;
        return { f1Mean: meanOf("f1Mean"), f2Mean: meanOf("f2Mean") };
    }

    function buildVowelSpaceTrajectoryPoints() {
        const trials = analysisTargetRef._summary && analysisTargetRef._summary.vowel_trials;
        if (!trials) return null;
        return trials
            .map((t) => ({ f1Mean: t["F1 Mean"], f2Mean: t["F2 Mean"], createdAt: t._created_at }))
            .filter((p) => typeof p.f1Mean === "number" && typeof p.f2Mean === "number" && p.createdAt)
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
            .map((p, i) => ({ f1Mean: p.f1Mean, f2Mean: p.f2Mean, date: p.createdAt, label: `Recording #${i + 1}` }));
    }

    // Shared-baseline "who's listening" registry -- Vowel Space
    // Trajectory and Vowel Drift Trend both derive their chart from the
    // exact same analysisTargetRef._vowelSpaceBaseline (see the big
    // comment above vowelSpaceBaselineFromTrials() above), so an edit
    // made on either card's baseline controls needs to redraw BOTH
    // cards, not just the one the clinician typed into. Lives on the
    // target ref itself (not a module-level Set), same reasoning as the
    // baseline itself: switching to a different subject target
    // shouldn't carry over listeners registered against the previous
    // target, and switching back should find the survivors of that
    // target's own widgets, not some other target's.
    //
    // Entries are {container, draw} pairs rather than bare callbacks so
    // a stale listener (its widget closed, its container removed from
    // the DOM) can be dropped lazily the next time a baseline change
    // fires, instead of needing a MutationObserver just to notice a
    // widget closed. A container re-registers on every render (any
    // existing entry for that same container is replaced below), so
    // this only ever grows by one entry per open widget instance, not
    // by one per render.
    function registerVowelSpaceBaselineListener(ref, container, draw) {
        if (!ref._vowelSpaceBaselineListeners) ref._vowelSpaceBaselineListeners = new Set();
        for (const entry of ref._vowelSpaceBaselineListeners) {
            if (entry.container === container) ref._vowelSpaceBaselineListeners.delete(entry);
        }
        ref._vowelSpaceBaselineListeners.add({ container, draw });
    }

    function notifyVowelSpaceBaselineListeners(ref) {
        const listeners = ref._vowelSpaceBaselineListeners;
        if (!listeners) return;
        for (const entry of Array.from(listeners)) {
            if (!entry.container.isConnected) {
                listeners.delete(entry); // widget closed since it last registered -- drop it
                continue;
            }
            entry.draw();
        }
    }

    // Scroll-wheel zoom + drag-to-pan for the vowel space trajectory
    // chart. IMPORTANT: renderVowelSpaceChart rewrites the card's entire
    // innerHTML on every redraw (including every pan/zoom step), which
    // destroys and recreates .vs-chart-wrap each time. Binding listeners
    // directly to that element would lose pointer capture mid-drag the
    // moment it's recreated. Bind once to `container` instead (the
    // stable .pinboard-widget-graph-content div that's never replaced,
    // only its innerHTML changes) and look up the current .vs-chart-wrap
    // fresh inside every handler -- same for the redraw callback, fetched
    // fresh off container._vowelSpaceState.draw rather than captured at
    // bind time, so it always redraws whichever target/points this
    // container is currently showing.
    //
    // Bound at most once per container ever (guarded by
    // container._vowelSpaceZoomPanBound) since the entry point below can
    // be re-invoked without the container itself being recreated (e.g. a
    // data refresh) -- rebinding on every call would stack duplicate
    // listeners.
    function attachVowelSpaceZoomPan(container) {
        if (container._vowelSpaceZoomPanBound) return;
        container._vowelSpaceZoomPanBound = true;

        const W = 480, H = 380, padL = 10, padR = 10, padT = 10, padB = 10;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const MIN_F1_SPAN = 60, MIN_F2_SPAN = 150;
        const F1_MARGIN = 100, F2_MARGIN = 200;

        function getWrap() { return container.querySelector(".vs-chart-wrap"); }
        function getState() { return container._vowelSpaceState; }
        function redraw() { const s = getState(); if (s && s.draw) s.draw(); }

        // Clamped so you can't zoom/pan more than a fixed margin past the
        // default domain -- don't let the chart scroll into meaningless
        // formant ranges.
        function clampDomain(d, baseDomain) {
            let { f1Min, f1Max, f2Min, f2Max } = d;
            if (f1Min < baseDomain.f1Min - F1_MARGIN) { f1Max += (baseDomain.f1Min - F1_MARGIN) - f1Min; f1Min = baseDomain.f1Min - F1_MARGIN; }
            if (f1Max > baseDomain.f1Max + F1_MARGIN) { f1Min -= f1Max - (baseDomain.f1Max + F1_MARGIN); f1Max = baseDomain.f1Max + F1_MARGIN; }
            if (f2Min < baseDomain.f2Min - F2_MARGIN) { f2Max += (baseDomain.f2Min - F2_MARGIN) - f2Min; f2Min = baseDomain.f2Min - F2_MARGIN; }
            if (f2Max > baseDomain.f2Max + F2_MARGIN) { f2Min -= f2Max - (baseDomain.f2Max + F2_MARGIN); f2Max = baseDomain.f2Max + F2_MARGIN; }
            return { f1Min, f1Max, f2Min, f2Max };
        }

        container.addEventListener("wheel", (e) => {
            const wrap = getWrap();
            const state = getState();
            if (!wrap || !state || !wrap.contains(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            const { domain, baseDomain } = state;
            const baseF1Span = baseDomain.f1Max - baseDomain.f1Min;
            const baseF2Span = baseDomain.f2Max - baseDomain.f2Min;
            const rect = wrap.getBoundingClientRect();
            const relX = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
            const relY = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
            const vx = relX * W, vy = relY * H;

            // data value under the cursor, in the current domain
            const f2At = domain.f2Max - ((vx - padL) / plotW) * (domain.f2Max - domain.f2Min);
            const f1At = domain.f1Min + ((vy - padT) / plotH) * (domain.f1Max - domain.f1Min);

            const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85; // scroll up = zoom in
            let f1Span = Math.min(Math.max((domain.f1Max - domain.f1Min) * factor, MIN_F1_SPAN), baseF1Span);
            let f2Span = Math.min(Math.max((domain.f2Max - domain.f2Min) * factor, MIN_F2_SPAN), baseF2Span);

            let next;
            if (f1Span >= baseF1Span && f2Span >= baseF2Span) {
                next = { ...baseDomain };
            } else {
                const tF1 = (f1At - domain.f1Min) / (domain.f1Max - domain.f1Min);
                const tF2 = (domain.f2Max - f2At) / (domain.f2Max - domain.f2Min);
                const f1Min = f1At - tF1 * f1Span;
                const f2Max = f2At + tF2 * f2Span;
                next = clampDomain({ f1Min, f1Max: f1Min + f1Span, f2Min: f2Max - f2Span, f2Max }, baseDomain);
            }
            state.domain = next;
            redraw();
        }, { passive: false });

        let panning = false, activePointerId = null, startX = 0, startY = 0, startDomain = null;

        container.addEventListener("pointerdown", (e) => {
            const wrap = getWrap();
            const state = getState();
            if (!wrap || !state || !wrap.contains(e.target)) return;
            panning = true;
            container._vsPanning = true;
            activePointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            startDomain = { ...state.domain };
            wrap.style.cursor = "grabbing";
            container.setPointerCapture(e.pointerId);
            e.stopPropagation();
        });

        container.addEventListener("pointermove", (e) => {
            if (!panning || e.pointerId !== activePointerId) return;
            e.stopPropagation();
            const wrap = getWrap();
            const state = getState();
            if (!wrap || !state) return;
            const rect = wrap.getBoundingClientRect();
            const dxPx = (e.clientX - startX) * (W / rect.width);
            const dyPx = (e.clientY - startY) * (H / rect.height);
            const f1Span = startDomain.f1Max - startDomain.f1Min;
            const f2Span = startDomain.f2Max - startDomain.f2Min;
            const df1 = (dyPx / plotH) * f1Span;
            const df2 = (dxPx / plotW) * f2Span;
            state.domain = clampDomain({
                f1Min: startDomain.f1Min - df1,
                f1Max: startDomain.f1Max - df1,
                f2Min: startDomain.f2Min + df2,
                f2Max: startDomain.f2Max + df2,
            }, state.baseDomain);
            redraw();
        });

        function endPan(e) {
            if (!panning || (e && e.pointerId !== activePointerId)) return;
            panning = false;
            container._vsPanning = false;
            activePointerId = null;
            const wrap = getWrap();
            if (wrap) wrap.style.cursor = "grab";
        }
        container.addEventListener("pointerup", endPan);
        container.addEventListener("pointercancel", endPan);

        container.addEventListener("dblclick", (e) => {
            const wrap = getWrap();
            const state = getState();
            if (!wrap || !state || !wrap.contains(e.target)) return;
            e.stopPropagation();
            state.domain = { ...state.baseDomain };
            redraw();
        });
    }

    function renderVowelSpaceTrajectory(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("Vowel Space Trajectory");
            return;
        }

        const points = buildVowelSpaceTrajectoryPoints();
        if (!points || points.length < 2) {
            container.innerHTML = graphEmptyStateHTML("Vowel Space Trajectory");
            return;
        }

        // Default baseline computed once per target and then left alone --
        // NOT recomputed from vowel_trials on every render -- so a
        // clinician's edit survives redraws (zoom/pan, refreshes) as long
        // as the same target stays open. See the comment above this
        // section for why these live on the ref itself.
        if (!analysisTargetRef._vowelSpaceDefaultBaseline) {
            analysisTargetRef._vowelSpaceDefaultBaseline = vowelSpaceBaselineFromTrials(points);
        }
        if (!analysisTargetRef._vowelSpaceBaseline) {
            analysisTargetRef._vowelSpaceBaseline = { ...analysisTargetRef._vowelSpaceDefaultBaseline };
        }

        // Zoom/pan domain lives on the container (ephemeral -- resets if
        // the target changes while this widget is open, or the widget is
        // reopened), separately from the baseline above (which lives on
        // the target ref and persists across reopens).
        if (!container._vowelSpaceState || container._vowelSpaceState.forRef !== analysisTargetRef) {
            const baseDomain = { f1Min: 200, f1Max: 1000, f2Min: 700, f2Max: 2500 };
            container._vowelSpaceState = { domain: { ...baseDomain }, baseDomain, forRef: analysisTargetRef };
        }

        function draw() {
            renderVowelSpaceChart(container, points, {
                mode: "trajectory",
                domain: container._vowelSpaceState.domain,
                baseline: analysisTargetRef._vowelSpaceBaseline,
                defaultBaseline: analysisTargetRef._vowelSpaceDefaultBaseline,
                onBaselineChange(next) {
                    analysisTargetRef._vowelSpaceBaseline = next;
                    // Notifies every registered listener for this target
                    // (this card included -- it re-registers itself
                    // below on every render) rather than calling draw()
                    // directly, so a Vowel Drift Trend card open on the
                    // same target redraws with the new baseline too.
                    notifyVowelSpaceBaselineListeners(analysisTargetRef);
                },
                subText: `Across ${points.length} recordings - sustained-vowel drift, sagittal orientation`,
                endpointLabels: ["Earliest recording", "Most recent recording"],
            });
        }

        container._vowelSpaceState.draw = draw;
        registerVowelSpaceBaselineListener(analysisTargetRef, container, draw);
        attachVowelSpaceZoomPan(container);
        draw();
    }

    // ---- Vowel Drift Trend (across-recordings) ---------------------------
    // Companion to Vowel Space Trajectory: the exact same per-recording
    // F1/F2 points (buildVowelSpaceTrajectoryPoints(), no separate
    // fetch/derivation) and the exact same clinician-editable baseline
    // (analysisTargetRef._vowelSpaceBaseline) as the trajectory card
    // above -- just collapsed from a 2D F1/F2 position down to one
    // Euclidean "how far from baseline" number per recording, so drift
    // reads as a scannable up/down line instead of a shape a clinician
    // has to mentally parse.
    //
    // Deliberately does NOT own or recompute a baseline of its own --
    // it reads/writes the same analysisTargetRef._vowelSpaceBaseline
    // the trajectory card does, and registers itself into the shared
    // registerVowelSpaceBaselineListener() registry above so editing
    // the baseline from EITHER card's inline F1/F2 inputs redraws both.
    function vowelDriftDistances(points, baseline) {
        return points.map((p) => Math.sqrt(
            Math.pow(p.f1Mean - baseline.f1Mean, 2) + Math.pow(p.f2Mean - baseline.f2Mean, 2)
        ));
    }

    function renderVowelDriftTrend(container) {
        if (!(analysisTargetType === "subject" || analysisTargetType === "recordings") || !analysisTargetRef) {
            container.innerHTML = graphEmptyStateHTML("Vowel Drift Trend");
            return;
        }

        const points = buildVowelSpaceTrajectoryPoints();
        if (!points || points.length < 2) {
            container.innerHTML = graphEmptyStateHTML("Vowel Drift Trend");
            return;
        }

        // Same lazy default-baseline init as Vowel Space Trajectory (see
        // the comment above that function) -- guarded so whichever of
        // the two cards happens to render FIRST for this target sets it
        // up, and the other just reads what's already there.
        if (!analysisTargetRef._vowelSpaceDefaultBaseline) {
            analysisTargetRef._vowelSpaceDefaultBaseline = vowelSpaceBaselineFromTrials(points);
        }
        if (!analysisTargetRef._vowelSpaceBaseline) {
            analysisTargetRef._vowelSpaceBaseline = { ...analysisTargetRef._vowelSpaceDefaultBaseline };
        }

        function draw() {
            const baseline = analysisTargetRef._vowelSpaceBaseline;
            const distances = vowelDriftDistances(points, baseline);
            const n = points.length;

            const fullDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

            // Distance is a real Euclidean Hz magnitude -- floor is a
            // real 0, same "magnitude axis" convention as Interval
            // Stability Trend's y-axis above, not a data-relative min.
            const dataMax = Math.max.apply(null, distances);
            const vMax = Math.max(dataMax, 1e-6) * 1.15;
            const vMin = 0;
            const vRange = vMax - vMin;

            const W = 640, H = 260;
            const padL = 6, padR = 6, padT = 10, padB = 10;
            const plotW = W - padL - padR, plotH = H - padT - padB;
            const baseY = padT + plotH;
            const yAt = (v) => baseY - ((v - vMin) / vRange) * plotH;
            const fracs = longLineXFracs(n);
            const xAt = (i) => padL + fracs[i] * plotW;

            // Violet -- not a color any other longitudinal LINE chart in
            // this file already claims: Rate Trend/Interval Stability
            // Trend use #6ea8fe (blue), Rate Trend's Repetition Rate /
            // Pause Ratio Trend use #AA6747 (brown), Regularity Trend
            // uses #3fd185 (green).
            const COLOR = "#a78bfa";

            let pathD = "";
            let dots = "";
            distances.forEach((d, i) => {
                const x = xAt(i), y = yAt(d);
                pathD += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
                dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${COLOR}"/>`;
            });

            // No baseline band/shading here (unlike Interval Stability
            // Trend's +/-1 SD ribbon) -- this whole chart already IS
            // "distance from baseline", so there's nothing left to shade
            // relative to.
            const svg = `
                <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
                    <path d="${pathD}" fill="none" stroke="${COLOR}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                    ${dots}
                </svg>`;

            // Status pill: last-vs-first (not a flagged-point count),
            // same convention as Regularity Trend / Pause Ratio Trend
            // above, scaled by ~8% of this chart's own y-range rather
            // than a flat Hz number or SD multiple -- a raw Euclidean
            // distance has no fixed scale to borrow a magic number from,
            // but the chart's own range is always meaningful.
            const trendDelta = distances[n - 1] - distances[0];
            const trendingUp = trendDelta > vRange * 0.08;

            // maxTicks = n -- label every recording, same convention as
            // Interval Stability Trend / Pause Ratio Trend above.
            const ticks = sparseIndexTicks(n, n, (i) => String(i + 1), (i) => fracs[i]);

            container.innerHTML = `
                <div class="area-root">
                    <div class="area-header">
                        <div>
                            <div class="area-title">Vowel Drift Trend</div>
                            <div class="area-sub">Distance from baseline across ${n} recordings - same F1/F2 data as Vowel Space Trajectory, collapsed to one number</div>
                        </div>
                        <div class="area-range-pill" style="${trendingUp ? "color:#ffb454;border-color:rgba(255,180,84,0.35);" : ""}">${trendingUp ? "Trending up" : "Stable / improving"}</div>
                    </div>
                    <div class="area-body">
                        <div class="area-yaxis-wrap">
                            <div class="area-yaxis-label">Distance (Hz)</div>
                            <div class="area-yaxis">
                                <span>${fmt(vMax, 0)}</span>
                                <span>${fmt(vMax / 2, 0)}</span>
                                <span>0</span>
                            </div>
                        </div>
                        <div class="area-chart-wrap ddk-chart-wrap" style="border-color:#0F0F10;">${svg}<div class="ddk-tooltip"></div></div>
                    </div>
                    <div class="area-xaxis-row">
                        <div class="area-xaxis-spacer" style="width:44px;"></div>
                        <div class="area-xaxis--labeled" style="flex:1;display:flex;flex-direction:column;">
                            <div class="area-xaxis--precise" style="flex:none;">
                                ${ticks.map((t) => `<span style="left:${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
                            </div>
                            <div class="area-axis-title">Recording #</div>
                        </div>
                    </div>
                    <div class="area-legend" style="padding-left:52px;">
                        <div class="area-legend-item"><span class="area-legend-dot" style="background:${COLOR}"></span>Distance from baseline</div>
                    </div>
                </div>`;

            // Same nearest-by-x-fraction hover pattern (and .ddk-chart-
            // wrap/.ddk-tooltip shell) every other longitudinal graph in
            // this file already uses -- see Interval Stability Trend
            // above for the original this is copied from.
            const chartWrap = container.querySelector(".ddk-chart-wrap");
            const tooltip = container.querySelector(".ddk-tooltip");

            chartWrap.addEventListener("mousemove", (e) => {
                const rect = chartWrap.getBoundingClientRect();
                const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                let nearestIdx = 0, nearestDist = Infinity;
                fracs.forEach((f, i) => {
                    const fd = Math.abs(f - relX);
                    if (fd < nearestDist) { nearestDist = fd; nearestIdx = i; }
                });
                const p = points[nearestIdx];

                tooltip.innerHTML = `
                    <div class="ddk-tooltip-title">Recording #${nearestIdx + 1} &middot; ${fullDate(p.date)}</div>
                    <div class="ddk-tooltip-row"><span class="ddk-tooltip-dot" style="background:${COLOR}"></span>Distance: ${fmt(distances[nearestIdx], 0)} Hz</div>`;
                tooltip.classList.add("visible");
                const wrapW = rect.width;
                tooltip.style.left = Math.max(60, Math.min(wrapW - 60, fracs[nearestIdx] * wrapW)) + "px";
                // Anchored above the hovered point's own screen position
                // (not a fixed offset from the chart's top) -- .ddk-chart-
                // wrap's overflow is visible now (see CSS), so this is
                // free to float above the plot area, and past the card's
                // edge entirely, when the point sits near the top.
                const pointScreenY = (yAt(distances[nearestIdx]) / H) * rect.height;
                tooltip.style.top = (pointScreenY - tooltip.offsetHeight - 10) + "px";
            });

            chartWrap.addEventListener("mouseleave", () => {
                tooltip.classList.remove("visible");
            });
        }

        registerVowelSpaceBaselineListener(analysisTargetRef, container, draw);
        draw();
    }

    // ---- Pitch Waveform graph content ----
    //
    // A mirrored bar "audio waveform" — the classic audio-player look —
    // but driven by pitch (F0 in Hz) instead of amplitude. Real per-frame
    // pitch data isn't served by the backend yet (see
    // getPitchTraceForTarget() below), so the trace is synthesized from
    // the same scalar sustained-vowel stats (f0Mean/f0Min/f0Max/
    // jitterLocal) the Formants/Voice Quality widgets already read: a
    // ~5Hz vibrato sine + a ~0.35Hz slow drift sine + a seeded jitter
    // walk, scaled by the vowel's own F0 range. The seed is fixed (not
    // time-based), so the trace is stable across re-renders/resizes
    // instead of jittering into a new random shape every time.
    //
    // Everything downstream of the trace array (bar heights, the
    // oscillator sonification in wirePitchWaveformPlayback) only cares
    // that it's an array of Hz values — once a real per-frame contour is
    // available from the backend (e.g. an extract_pitch_contour()
    // endpoint), swap it in inside getPitchTraceForTarget() and nothing
    // else here needs to change.

    // ==========================================================
    // Real-audio waveform + playback (used by both Pitch Waveform
    // and DDK Waveform when the analysis target is a single
    // recording — a real WAV file, not an aggregated subject
    // rollup). Falls back to the synthesized trace above/below when
    // there's no single recording to point at, or if the audio fails
    // to load, so the widgets never break — they just degrade to the
    // stand-in look they already had.
    //
    // The backend already serves the raw file at
    // GET /api/recordings/audio?path=<patient_filepath> (see
    // api/routes.py get_recording_audio) — it was wired up for an
    // <audio> tag and had no frontend caller yet. This is that
    // caller: fetch the WAV, decode it once with the Web Audio API to
    // get the real per-sample PCM (for the bar heights) and the real
    // duration, then drive an actual <audio> element for playback so
    // the sound and the playhead are both genuinely real-time instead
    // of a fixed-length oscillator sweep.
    const AUDIO_DECODE_CACHE = new Map(); // patient_filepath -> Promise<AudioBuffer>
    let _sharedAudioCtx = null;

    function getSharedAudioCtx() {
        if (!_sharedAudioCtx) _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return _sharedAudioCtx;
    }

    // Decodes are cached per file so re-rendering (refreshAllWidgetValues,
    // switching widgets back and forth) doesn't refetch/redecode the same
    // WAV every time — only the first render per recording pays for it.
    function decodeRecordingAudio(filepath) {
        if (!filepath) return Promise.reject(new Error("No audio file for this target."));
        if (AUDIO_DECODE_CACHE.has(filepath)) return AUDIO_DECODE_CACHE.get(filepath);
        const promise = fetch(api.recordingAudioUrl(filepath))
            .then((res) => {
                if (!res.ok) throw new Error("Couldn't load the recording's audio.");
                return res.arrayBuffer();
            })
            .then((arrayBuf) => getSharedAudioCtx().decodeAudioData(arrayBuf))
            .catch((err) => {
                AUDIO_DECODE_CACHE.delete(filepath); // don't cache a failed decode
                throw err;
            });
        AUDIO_DECODE_CACHE.set(filepath, promise);
        return promise;
    }

    // Real peak-amplitude envelope, bucketed to `n` bars — the actual
    // waveform of the recording, not a synthesized stand-in. Peak (not
    // average) per bucket so short bursts/transients still read in a
    // 96-bar-wide view instead of getting smoothed away.
    function computePeakEnvelope(audioBuffer, n) {
        const data = audioBuffer.getChannelData(0);
        const total = data.length;
        const blockSize = Math.max(1, Math.floor(total / n));
        const trace = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            const start = i * blockSize;
            const end = i === n - 1 ? total : Math.min(total, start + blockSize);
            let peak = 0;
            for (let j = start; j < end; j++) {
                const a = Math.abs(data[j]);
                if (a > peak) peak = a;
            }
            trace[i] = peak;
        }
        return trace;
    }

    // Mirrored-bar SVG for a real amplitude envelope — same played/
    // unplayed clip-path trick as the synthesized versions below, just
    // bars sized by actual peak amplitude (0..maxAmp) instead of
    // deviation from a synthesized mean.
    function realWaveformSVG(id, trace, color) {
        const W = 700, H = 200, midY = H / 2;
        const n = trace.length;
        const maxAmp = Math.max(0.0005, ...trace);
        const barGap = 2;
        const barW = Math.max(1.5, W / n - barGap);
        let bars = "";
        for (let i = 0; i < n; i++) {
            const frac = Math.min(1, trace[i] / maxAmp);
            const halfH = Math.max(1, frac * (midY - 4));
            const x = (i / n) * W;
            bars += `<rect x="${x.toFixed(2)}" y="${(midY - halfH).toFixed(2)}" width="${barW.toFixed(2)}" height="${(halfH * 2).toFixed(2)}" rx="1"/>`;
        }
        return `
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pitch-wave-svg">
                <defs>
                    <clipPath id="rt-waveform-clip-${id}">
                        <rect id="rt-waveform-clip-rect-${id}" x="0" y="0" width="0" height="${H}"/>
                    </clipPath>
                </defs>
                <line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="var(--chart-grid-line)" stroke-width="1"/>
                <g fill="var(--text-tertiary)">${bars}</g>
                <g fill="${color}" clip-path="url(#rt-waveform-clip-${id})">${bars}</g>
                <line id="rt-waveform-playhead-${id}" x1="0" y1="0" x2="0" y2="${H}" stroke="${color}" stroke-width="1.5"/>
            </svg>`;
    }

    // Wires real playback for one real-audio waveform instance with an
    // actual <audio> element — play/pause, click-and-drag seeking, and
    // a playhead driven by the element's own currentTime via rAF, so
    // both the sound and the visual are genuinely in sync with real
    // playback instead of a projected/oscillator timeline.
    function wireRealAudioPlayback(container, id, filepath, duration) {
        const playBtn = container.querySelector(".pitch-play-btn");
        const playIcon = container.querySelector(".pitch-play-icon");
        const pauseIcon = container.querySelector(".pitch-pause-icon");
        const timeReadout = container.querySelector(".pitch-time-readout");
        const clipRect = container.querySelector(`#rt-waveform-clip-rect-${id}`);
        const playhead = container.querySelector(`#rt-waveform-playhead-${id}`);
        const seekOverlay = container.querySelector(".pitch-seek-overlay");
        const W = 700;

        const audioEl = new Audio(api.recordingAudioUrl(filepath));
        audioEl.preload = "auto";
        let rafId = null;

        function paint(t) {
            const frac = duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0;
            const x = frac * W;
            if (clipRect) clipRect.setAttribute("width", x.toFixed(2));
            if (playhead) { playhead.setAttribute("x1", x.toFixed(2)); playhead.setAttribute("x2", x.toFixed(2)); }
            if (timeReadout) timeReadout.textContent = `${formatClockTime(t)} / ${formatClockTime(duration)}`;
        }

        function tick() {
            paint(audioEl.currentTime);
            if (!audioEl.paused && !audioEl.ended) rafId = requestAnimationFrame(tick);
        }

        function setPlayingUI(isPlaying) {
            if (playIcon) playIcon.style.display = isPlaying ? "none" : "";
            if (pauseIcon) pauseIcon.style.display = isPlaying ? "" : "none";
        }

        function togglePlay() {
            if (audioEl.paused) {
                if (audioEl.ended) audioEl.currentTime = 0;
                audioEl.play().catch((err) => { console.error(err); showToast("Couldn't play this recording's audio."); });
            } else {
                audioEl.pause();
            }
        }

        audioEl.addEventListener("play", () => { setPlayingUI(true); if (rafId) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(tick); });
        audioEl.addEventListener("pause", () => { setPlayingUI(false); if (rafId) cancelAnimationFrame(rafId); rafId = null; });
        audioEl.addEventListener("ended", () => { setPlayingUI(false); paint(0); });

        // Same drag-start guard as the synthesized widgets — the card's
        // dragSurface skips ".graph-interactive", but stop propagation
        // here too as defense in depth.
        if (playBtn) {
            playBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            playBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
        }

        if (seekOverlay) {
            const seekTo = (clientX) => {
                const rect = seekOverlay.getBoundingClientRect();
                if (!rect.width) return;
                const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
                // Clamp just short of the true end: setting currentTime to
                // exactly `duration` fires the native "ended" event even
                // while paused, which snaps playback back to 0. With the
                // mouse held outside the widget, mousemove keeps re-firing
                // seekTo(), so that reset-to-0 immediately gets overwritten
                // by another jump to the end, then reset again — producing
                // a fast 0/end flicker for as long as the drag stays past
                // the edge.
                const target = Math.min(frac * duration, Math.max(0, duration - 0.05));
                audioEl.currentTime = target;
                paint(audioEl.currentTime);
            };
            seekOverlay.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                seekTo(e.clientX);
                function onMove(ev) { seekTo(ev.clientX); }
                function onUp() {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                }
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }

        paint(0);
        container._realWaveformState = {
            cleanup() {
                try { audioEl.pause(); } catch (e) { /* not playing */ }
                audioEl.src = "";
                if (rafId) cancelAnimationFrame(rafId);
            },
        };

        const widget = container.closest(".pinboard-widget");
        const closeBtn = widget && widget.querySelector(".pinboard-widget-close-btn, .pinboard-close-btn");
        if (closeBtn && !closeBtn.dataset.realWaveformCleanupBound) {
            closeBtn.dataset.realWaveformCleanupBound = "1";
            closeBtn.addEventListener("click", () => {
                if (container._realWaveformState) container._realWaveformState.cleanup();
            });
        }
    }

    // Loads + decodes the real recording, then renders the real
    // waveform + real playback controls in place of the synthesized
    // stand-in. `token` guards against a stale response landing after
    // the user has switched targets or the widget has re-rendered again
    // in the meantime (decodeRecordingAudio is async and can resolve
    // after the container has moved on).
    let _rtWaveformTokenCounter = 0;
    let _rtWaveformInstanceCount = 0;

    function renderRealAudioWaveform(container, opts) {
        const token = String(++_rtWaveformTokenCounter);
        container.dataset.rtWaveformToken = token;
        container.innerHTML = `<div class="pinboard-widget-empty">Loading audio\u2026</div>`;

        decodeRecordingAudio(opts.filepath).then((audioBuffer) => {
            if (container.dataset.rtWaveformToken !== token) return; // stale — target/widget moved on
            const trace = computePeakEnvelope(audioBuffer, 96);
            const duration = audioBuffer.duration;
            const id = ++_rtWaveformInstanceCount;
            const svg = realWaveformSVG(id, trace, opts.color);
            const xTicks = [0, 1, 2, 3, 4].map((i) => ((duration / 4) * i).toFixed(1) + "s");

            container.innerHTML = `
                <div class="area-root">
                    <div class="area-header">
                        <div>
                            <div class="area-title">${opts.title}</div>
                            <div class="area-sub">${opts.subtitle}</div>
                        </div>
                        <div class="pitch-controls-pill">
                            <button type="button" class="pitch-play-btn graph-interactive" title="Play" aria-label="Play">
                                <svg class="pitch-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                <svg class="pitch-pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
                            </button>
                            <span class="pitch-time-readout">0:00 / ${formatClockTime(duration)}</span>
                        </div>
                    </div>
                    <div class="area-body">
                        <div class="area-yaxis"><span>+</span><span>0</span><span>&minus;</span></div>
                        <div class="area-chart-wrap pitch-chart-wrap">
                            ${svg}
                            <div class="pitch-seek-overlay graph-interactive"></div>
                        </div>
                    </div>
                    <div class="area-xaxis-row">
                        <div class="area-xaxis-spacer"></div>
                        <div class="area-xaxis">${xTicks.map((t) => `<span>${t}</span>`).join("")}</div>
                    </div>
                </div>`;

            wireRealAudioPlayback(container, id, opts.filepath, duration);
        }).catch((err) => {
            if (container.dataset.rtWaveformToken !== token) return;
            console.error(err);
            if (opts.fallback) opts.fallback();
            else container.innerHTML = graphEmptyStateHTML(opts.title);
        });
    }

    let pitchWaveformInstanceCount = 0;
    const PITCH_WAVEFORM_SAMPLES = 96;
    // Fixed stand-in length, same approach as Spectrogram's hardcoded
    // 3.0s axis (see drawSpectrogram) until a real recording duration is
    // wired up.
    const PITCH_WAVEFORM_DURATION = 4.0;

    // Small deterministic PRNG so the jitter walk below is repeatable.
    function mulberry32(seed) {
        return function () {
            seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function synthesizePitchTrace(vals, n) {
        const mean = vals.f0Mean;
        const range = Math.max(6, (vals.f0Max - vals.f0Min) || mean * 0.15);
        const jitterStep = Math.max(0.002, vals.jitterLocal || 0.01) * mean * 2;
        const rand = mulberry32(0xA57C0DE ^ Math.round(mean * 97));
        let walk = 0;
        const trace = new Array(n);
        for (let i = 0; i < n; i++) {
            const t = (i / (n - 1)) * PITCH_WAVEFORM_DURATION;
            const vibrato = Math.sin(t * 2 * Math.PI * 5) * range * 0.16;
            const drift = Math.sin(t * 2 * Math.PI * 0.35) * range * 0.28;
            walk = walk * 0.88 + (rand() - 0.5) * jitterStep;
            trace[i] = Math.max(20, mean + vibrato + drift + walk);
        }
        return trace;
    }

    // Prefers a real per-frame pitch contour if the backend ever starts
    // sending one (analysisTargetRef._raw.pitch_contour for a single
    // recording, or the _summary equivalent for a subject
    // rollup), falling back to the synthesized stand-in otherwise.
    function getPitchTraceForTarget(vals) {
        const real = analysisTargetType === "recording"
            ? (analysisTargetRef && analysisTargetRef._raw && analysisTargetRef._raw.pitch_contour)
            : (analysisTargetRef && analysisTargetRef._summary && analysisTargetRef._summary.pitch_contour);
        if (Array.isArray(real) && real.length > 1) return real;
        return synthesizePitchTrace(vals, PITCH_WAVEFORM_SAMPLES);
    }

    function formatClockTime(seconds) {
        const s = Math.max(0, seconds);
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${String(sec).padStart(2, "0")}`;
    }

    // Builds the mirrored-bar SVG for one Pitch Waveform instance. Bars
    // are drawn twice — once gray as the full-track base layer, once
    // white on top clipped by a per-instance <clipPath> whose width
    // grows with playback progress (see wirePitchWaveformPlayback) — so
    // played/unplayed portions read like a familiar audio-player
    // waveform. `id` disambiguates the clipPath if more than one Pitch
    // Waveform card is open at once.
    function pitchWaveformSVG(id, trace) {
        const W = 700, H = 200, midY = H / 2;
        const n = trace.length;
        const mean = trace.reduce((a, b) => a + b, 0) / n;
        const maxDev = Math.max(1, ...trace.map((v) => Math.abs(v - mean)));
        const barGap = 2;
        const barW = Math.max(1.5, W / n - barGap);
        let bars = "";
        for (let i = 0; i < n; i++) {
            const frac = Math.min(1, Math.abs(trace[i] - mean) / maxDev);
            const halfH = frac * (midY - 4);
            const x = (i / n) * W;
            bars += `<rect x="${x.toFixed(2)}" y="${(midY - halfH).toFixed(2)}" width="${barW.toFixed(2)}" height="${(halfH * 2).toFixed(2)}" rx="1"/>`;
        }
        const svg = `
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pitch-wave-svg">
                <defs>
                    <clipPath id="pitch-waveform-clip-${id}">
                        <rect id="pitch-waveform-clip-rect-${id}" x="0" y="0" width="0" height="${H}"/>
                    </clipPath>
                </defs>
                <line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="var(--chart-grid-line)" stroke-width="1"/>
                <g fill="var(--text-tertiary)">${bars}</g>
                <g fill="var(--text-primary)" clip-path="url(#pitch-waveform-clip-${id})">${bars}</g>
                <line id="pitch-waveform-playhead-${id}" x1="0" y1="0" x2="0" y2="${H}" stroke="var(--text-primary)" stroke-width="1.5"/>
            </svg>`;
        return { mean, maxDev, svg };
    }

    // Wires up playback for one Pitch Waveform instance: play/pause,
    // click-and-drag seeking on the waveform itself, and an Web Audio
    // oscillator swept through the pitch trace so the contour is
    // actually audible in sync with the visual playhead.
    function wirePitchWaveformPlayback(container, id, trace, duration) {
        const playBtn = container.querySelector(".pitch-play-btn");
        const playIcon = container.querySelector(".pitch-play-icon");
        const pauseIcon = container.querySelector(".pitch-pause-icon");
        const timeReadout = container.querySelector(".pitch-time-readout");
        const clipRect = container.querySelector(`#pitch-waveform-clip-rect-${id}`);
        const playhead = container.querySelector(`#pitch-waveform-playhead-${id}`);
        const seekOverlay = container.querySelector(".pitch-seek-overlay");
        const W = 700;

        let audioCtx = null;
        let oscillator = null;
        let gainNode = null;
        let rafId = null;
        let playing = false;
        let startFrac = 0;    // playback fraction the current oscillator run started from
        let startCtxTime = 0; // audioCtx.currentTime at that moment

        function currentFraction() {
            if (!playing || !audioCtx) return startFrac;
            const elapsed = audioCtx.currentTime - startCtxTime;
            return Math.min(1, startFrac + elapsed / duration);
        }

        function paint(frac) {
            const x = frac * W;
            if (clipRect) clipRect.setAttribute("width", x.toFixed(2));
            if (playhead) { playhead.setAttribute("x1", x.toFixed(2)); playhead.setAttribute("x2", x.toFixed(2)); }
            if (timeReadout) timeReadout.textContent = `${formatClockTime(frac * duration)} / ${formatClockTime(duration)}`;
        }

        function tick() {
            const frac = currentFraction();
            paint(frac);
            if (!playing) return;
            if (frac >= 1) { stop(true); return; }
            rafId = requestAnimationFrame(tick);
        }

        function stopOscillator() {
            if (oscillator) {
                try { oscillator.onended = null; oscillator.stop(); } catch (e) { /* already stopped */ }
                oscillator.disconnect();
                oscillator = null;
            }
            if (gainNode) { gainNode.disconnect(); gainNode = null; }
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        }

        function stop(reset) {
            playing = false;
            stopOscillator();
            if (playIcon) playIcon.style.display = "";
            if (pauseIcon) pauseIcon.style.display = "none";
            if (reset) { startFrac = 0; paint(0); }
        }

        function startFrom(frac) {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === "suspended") audioCtx.resume();
            stopOscillator();

            startFrac = Math.min(0.999, Math.max(0, frac));
            const remaining = Math.max(0.02, duration * (1 - startFrac));
            const startIdx = Math.min(trace.length - 2, Math.floor(startFrac * trace.length));
            const curve = new Float32Array(trace.slice(startIdx));

            oscillator = audioCtx.createOscillator();
            oscillator.type = "sine";
            gainNode = audioCtx.createGain();
            oscillator.connect(gainNode).connect(audioCtx.destination);

            const now = audioCtx.currentTime;
            const fade = Math.min(0.03, remaining / 3);
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(0.15, now + fade);
            gainNode.gain.setValueAtTime(0.15, now + Math.max(fade, remaining - fade));
            gainNode.gain.linearRampToValueAtTime(0, now + remaining);

            oscillator.frequency.setValueCurveAtTime(curve, now, remaining);
            oscillator.start(now);
            oscillator.onended = () => { if (playing) stop(true); };

            startCtxTime = now;
            playing = true;
            if (playIcon) playIcon.style.display = "none";
            if (pauseIcon) pauseIcon.style.display = "";
            rafId = requestAnimationFrame(tick);
        }

        function togglePlay() {
            if (playing) stop(false);
            else startFrom(currentFraction() >= 1 ? 0 : currentFraction());
        }

        function seekToClientX(clientX) {
            const rect = seekOverlay.getBoundingClientRect();
            if (!rect.width) return;
            const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            if (playing) startFrom(frac);
            else { startFrac = frac; paint(frac); }
        }

        // The card system's drag-start handler listens for mousedown
        // anywhere on a header-less graph widget (see wireWidget's
        // dragSurface) and already skips anything matching
        // ".graph-interactive" — both controls below carry that class —
        // but stopPropagation here too as defense in depth.
        if (playBtn) {
            playBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            playBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
        }

        if (seekOverlay) {
            seekOverlay.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                seekToClientX(e.clientX);
                function onMove(ev) { seekToClientX(ev.clientX); }
                function onUp() {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                }
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }

        paint(0);
        container._pitchWaveformState = { cleanup() { stop(false); } };

        // Hook the widget's close button once so removing the card stops
        // the oscillator/rAF loop instead of leaking them. Re-renders
        // (refreshAllWidgetValues) rebuild this container's innerHTML but
        // never touch the close button itself, so this only needs
        // binding the first time — the listener re-reads
        // container._pitchWaveformState at click time, so it always
        // tears down whichever instance is current.
        const widget = container.closest(".pinboard-widget");
        const closeBtn = widget && widget.querySelector(".pinboard-widget-close-btn, .pinboard-close-btn");
        if (closeBtn && !closeBtn.dataset.pitchWaveformCleanupBound) {
            closeBtn.dataset.pitchWaveformCleanupBound = "1";
            closeBtn.addEventListener("click", () => {
                if (container._pitchWaveformState) container._pitchWaveformState.cleanup();
            });
        }
    }

    // ---- DDK Waveform graph content ----
    //
    // Same mirrored-bar audio-player look as Pitch Waveform, but driven
    // by the DDK intensity/rhythm envelope instead of F0. The backend
    // doesn't expose the real per-frame intensity contour yet (see
    // _ddk_intensity_contour() in feature_extractor.py — it's computed
    // internally for repetition-peak picking but only the scalar
    // aggregates like DDK Repetition Rate/Interval Mean/Regularity are
    // returned), so this is synthesized the same way Pitch Waveform's
    // trace is: a repeating burst envelope (one bump per pa-ta-ka
    // repetition) shaped from ddkRepetitionRate/ddkIntervalMean, with
    // timing jitter scaled by ddkIntervalStd/ddkRegularity so an
    // irregular DDK sequence visibly wobbles. Seeded, not time-based, so
    // it's stable across re-renders. Once a real contour is available
    // (e.g. GET /api/recordings/ddk-intensity-contour), swap it in
    // inside getIntensityTraceForTarget() and nothing else changes.
    let ddkWaveformInstanceCount = 0;
    const DDK_WAVEFORM_SAMPLES = 96;

    function synthesizeIntensityTrace(vals, n) {
        const rate = Math.max(1.5, vals.ddkRepetitionRate || 4.5); // reps/sec
        const period = 1 / rate;
        const duration = DDK_WAVEFORM_DURATION;
        const jitterFrac = Math.min(0.4, Math.max(0.02, (vals.ddkRegularity || 8) / 100));
        const rand = mulberry32(0xD57A11 ^ Math.round(rate * 977));
        const trace = new Array(n);
        // Pre-place burst centers across the duration, each nudged by
        // jitter so the envelope reads as slightly irregular rather than
        // a perfect metronome.
        const centers = [];
        for (let t = period / 2; t < duration; t += period) {
            centers.push(t + (rand() - 0.5) * period * jitterFrac);
        }
        const pauseDip = Math.min(0.6, (vals.pauseSpeechRatio || 0.1));
        for (let i = 0; i < n; i++) {
            const t = (i / (n - 1)) * duration;
            let level = 0;
            for (const c of centers) {
                const d = (t - c) / (period * 0.32);
                level = Math.max(level, Math.exp(-(d * d)));
            }
            trace[i] = 20 + level * 80 * (1 - pauseDip * 0.3);
        }
        return trace;
    }

    // Prefers a real per-frame intensity contour if the backend ever
    // starts sending one (analysisTargetRef._raw.ddk_intensity_contour
    // for a single recording, or the _summary equivalent for a
    // subject rollup), falling back to the synthesized stand-in
    // otherwise — same pattern as getPitchTraceForTarget().
    function getIntensityTraceForTarget(vals) {
        const real = analysisTargetType === "recording"
            ? (analysisTargetRef && analysisTargetRef._raw && analysisTargetRef._raw.ddk_intensity_contour)
            : (analysisTargetRef && analysisTargetRef._summary && analysisTargetRef._summary.ddk_intensity_contour);
        if (Array.isArray(real) && real.length > 1) return real;
        return synthesizeIntensityTrace(vals, DDK_WAVEFORM_SAMPLES);
    }

    const DDK_WAVEFORM_DURATION = 4.0;

    // Builds the mirrored-bar SVG for one DDK Waveform instance. Bars
    // are unsigned (0-100 intensity, not mirrored around a mean like
    // pitch), drawn full-height and scaled by level so repetition bursts
    // read as pulses along the track. Same gray-base/clipped-white-top
    // played-progress trick as pitchWaveformSVG.
    function ddkWaveformSVG(id, trace) {
        const W = 700, H = 200;
        const n = trace.length;
        const barW = W / n;
        const bars = trace.map((v, i) => {
            const h = Math.max(2, (v / 100) * H);
            const x = i * barW;
            const y = H - h;
            return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(barW * 0.7).toFixed(2)}" height="${h.toFixed(2)}"/>`;
        }).join("");
        const svg = `
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
                <defs>
                    <clipPath id="ddk-waveform-clip-${id}">
                        <rect id="ddk-waveform-clip-rect-${id}" x="0" y="0" width="0" height="${H}"/>
                    </clipPath>
                </defs>
                <g fill="#4c4c52">${bars}</g>
                <g fill="#6ea8fe" clip-path="url(#ddk-waveform-clip-${id})">${bars}</g>
                <line id="ddk-waveform-playhead-${id}" x1="0" y1="0" x2="0" y2="${H}" stroke="#6ea8fe" stroke-width="1.5"/>
            </svg>`;
        return { svg };
    }

    // Wires up playback for one DDK Waveform instance: play/pause,
    // click-and-drag seeking, and a clip-path playhead sweep — mirrors
    // wirePitchWaveformPlayback() exactly, just namespaced to "ddk-".
    function wireDDKWaveformPlayback(container, id, trace, duration) {
        const playBtn = container.querySelector(".pitch-play-btn");
        const playIcon = container.querySelector(".pitch-play-icon");
        const pauseIcon = container.querySelector(".pitch-pause-icon");
        const timeReadout = container.querySelector(".pitch-time-readout");
        const seekOverlay = container.querySelector(".pitch-seek-overlay");
        const clipRect = container.querySelector(`#ddk-waveform-clip-rect-${id}`);
        const playhead = container.querySelector(`#ddk-waveform-playhead-${id}`);
        if (!playBtn || !clipRect || !playhead) return;

        let playing = false, startTs = null, elapsed = 0, rafId = null;
        let audioCtx = null, oscNode = null, gainNode = null;

        function setProgress(t) {
            const frac = Math.min(1, Math.max(0, t / duration));
            clipRect.setAttribute("width", String(700 * frac));
            playhead.setAttribute("x1", String(700 * frac));
            playhead.setAttribute("x2", String(700 * frac));
            timeReadout.textContent = `${formatClockTime(t)} / ${formatClockTime(duration)}`;
        }

        function currentIntensityAt(t) {
            const idx = Math.min(trace.length - 1, Math.max(0, Math.round((t / duration) * (trace.length - 1))));
            return trace[idx];
        }

        function ensureAudio() {
            if (audioCtx) return;
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            audioCtx = new Ctx();
            oscNode = audioCtx.createOscillator();
            gainNode = audioCtx.createGain();
            oscNode.type = "square";
            oscNode.frequency.value = 220;
            gainNode.gain.value = 0;
            oscNode.connect(gainNode).connect(audioCtx.destination);
            oscNode.start();
        }

        function tick(ts) {
            if (!playing) return;
            if (startTs === null) startTs = ts;
            const t = elapsed + (ts - startTs) / 1000;
            if (t >= duration) { stop(true); return; }
            setProgress(t);
            if (gainNode) gainNode.gain.value = (currentIntensityAt(t) / 100) * 0.05;
            rafId = requestAnimationFrame(tick);
        }

        function play() {
            if (playing) return;
            playing = true;
            startTs = null;
            ensureAudio();
            if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
            playIcon.style.display = "none";
            pauseIcon.style.display = "";
            rafId = requestAnimationFrame(tick);
        }

        function stop(reset) {
            playing = false;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = null;
            if (gainNode) gainNode.gain.value = 0;
            playIcon.style.display = "";
            pauseIcon.style.display = "none";
            if (reset) { elapsed = 0; setProgress(0); }
        }

        playBtn.addEventListener("click", () => {
            if (playing) { elapsed = elapsed + (startTs !== null ? (performance.now() - startTs) / 1000 : 0); stop(false); }
            else play();
        });

        if (seekOverlay) {
            const seekTo = (clientX) => {
                const rect = seekOverlay.getBoundingClientRect();
                const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
                elapsed = frac * duration;
                startTs = null;
                setProgress(elapsed);
            };
            seekOverlay.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                seekTo(e.clientX);
                function onMove(ev) { seekTo(ev.clientX); }
                function onUp() {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                }
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }

        setProgress(0);

        container._ddkWaveformState = { cleanup() { stop(false); if (audioCtx) audioCtx.close(); } };

        const widget = container.closest(".pinboard-widget");
        const closeBtn = widget && widget.querySelector(".pinboard-widget-close-btn, .pinboard-close-btn");
        if (closeBtn && !closeBtn.dataset.ddkWaveformCleanupBound) {
            closeBtn.dataset.ddkWaveformCleanupBound = "1";
            closeBtn.addEventListener("click", () => {
                if (container._ddkWaveformState) container._ddkWaveformState.cleanup();
            });
        }
    }

    // Entry point for the DDK Waveform widget. A single recording has a
    // real WAV file behind it, so try that first (real waveform + real
    // playback); only fall back to the synthesized burst-envelope stand-in
    // if there's no audio to point at (target isn't a recording, or the
    // file failed to load).
    function renderDDKWaveform(container) {
        if (container._ddkWaveformState) container._ddkWaveformState.cleanup();
        if (container._realWaveformState) container._realWaveformState.cleanup();

        // Recording-only widget (see updateWidgetButtonsAvailability) --
        // if the analysis target changes out from under an already-open
        // DDK Waveform widget (e.g. user switches to a different subject), show
        // the empty state instead of a stale or meaningless trace.
        if (analysisTargetType !== "recording") {
            container.innerHTML = graphEmptyStateHTML("DDK Waveform");
            return;
        }
        const filepath = analysisTargetRef && analysisTargetRef._raw && analysisTargetRef._raw.patient_filepath;
        const vals = getDdkValuesForTarget();

        // Real playback only needs the WAV file, not the analysis stats --
        // check for it first so a recording still awaiting feature
        // extraction shows the real waveform instead of "no data yet".
        if (filepath) {
            renderRealAudioWaveform(container, {
                title: "DDK Waveform",
                subtitle: "Real waveform of the recorded pa-ta-ka repetitions",
                filepath,
                color: "#6ea8fe",
                fallback: () => {
                    container.innerHTML = graphEmptyStateHTML("DDK Waveform (audio unavailable)");
                },
            });
            return;
        }

        container.innerHTML = graphEmptyStateHTML("DDK Waveform");
    }

    function renderSynthesizedDDKWaveform(container, vals) {
        if (container._ddkWaveformState) container._ddkWaveformState.cleanup();

        const id = ++ddkWaveformInstanceCount;
        const trace = getIntensityTraceForTarget(vals);
        const { svg } = ddkWaveformSVG(id, trace);
        const duration = DDK_WAVEFORM_DURATION;
        const xTicks = [0, 1, 2, 3, 4].map((i) => ((duration / 4) * i).toFixed(1) + "s");

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">DDK Waveform</div>
                        <div class="area-sub">Intensity envelope of pa-ta-ka repetitions</div>
                    </div>
                    <div class="pitch-controls-pill">
                        <button type="button" class="pitch-play-btn graph-interactive" title="Play" aria-label="Play">
                            <svg class="pitch-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                            <svg class="pitch-pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
                        </button>
                        <span class="pitch-time-readout">0:00 / ${formatClockTime(duration)}</span>
                    </div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis"><span>100</span><span>50</span><span>0</span></div>
                    <div class="area-chart-wrap pitch-chart-wrap">
                        ${svg}
                        <div class="pitch-seek-overlay graph-interactive"></div>
                    </div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer"></div>
                    <div class="area-xaxis">${xTicks.map((t) => `<span>${t}</span>`).join("")}</div>
                </div>
            </div>`;

        wireDDKWaveformPlayback(container, id, trace, duration);
    }

    // Entry point for the Pitch Waveform widget. Recording-only, same as
    // DDK Waveform (see updateWidgetButtonsAvailability) — a waveform
    // plots one audio clip and has no coherent meaning averaged across a
    // subject's several trials, so those targets get the empty
    // state instead of the old synthesized F0 stand-in.
    function renderPitchWaveform(container) {
        if (container._pitchWaveformState) container._pitchWaveformState.cleanup();
        if (container._realWaveformState) container._realWaveformState.cleanup();

        if (analysisTargetType !== "recording") {
            container.innerHTML = graphEmptyStateHTML("Pitch Waveform");
            return;
        }

        const filepath = analysisTargetRef && analysisTargetRef._raw && analysisTargetRef._raw.patient_filepath;
        const vals = getSustainedValuesForTarget();

        // Real playback only needs the WAV file, not the analysis stats --
        // check for it first so a recording still awaiting feature
        // extraction shows the real waveform instead of "no data yet".
        if (filepath) {
            renderRealAudioWaveform(container, {
                title: "Vowel Waveform",
                subtitle: "Amplitude waveform of the recorded sustained /a/",
                filepath,
                color: "var(--text-primary)",
                fallback: () => {
                    container.innerHTML = graphEmptyStateHTML("Pitch Waveform (audio unavailable)");
                },
            });
            return;
        }

        container.innerHTML = graphEmptyStateHTML("Pitch Waveform");
    }

    function renderSynthesizedPitchWaveform(container, vals) {
        if (container._pitchWaveformState) container._pitchWaveformState.cleanup();

        const id = ++pitchWaveformInstanceCount;
        const trace = getPitchTraceForTarget(vals);
        const { mean, maxDev, svg } = pitchWaveformSVG(id, trace);
        const duration = PITCH_WAVEFORM_DURATION;

        const yTop = Math.round(mean + maxDev);
        const yMid = Math.round(mean);
        const xTicks = [0, 1, 2, 3, 4].map((i) => ((duration / 4) * i).toFixed(1) + "s");

        container.innerHTML = `
            <div class="area-root">
                <div class="area-header">
                    <div>
                        <div class="area-title">Pitch Waveform</div>
                        <div class="area-sub">F0 mirrored around its mean for a sustained /a/</div>
                    </div>
                    <div class="pitch-controls-pill">
                        <button type="button" class="pitch-play-btn graph-interactive" title="Play" aria-label="Play">
                            <svg class="pitch-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                            <svg class="pitch-pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
                        </button>
                        <span class="pitch-time-readout">0:00 / ${formatClockTime(duration)}</span>
                    </div>
                </div>
                <div class="area-body">
                    <div class="area-yaxis"><span>${yTop} Hz</span><span>${yMid} Hz</span><span>${yTop} Hz</span></div>
                    <div class="area-chart-wrap pitch-chart-wrap">
                        ${svg}
                        <div class="pitch-seek-overlay graph-interactive"></div>
                    </div>
                </div>
                <div class="area-xaxis-row">
                    <div class="area-xaxis-spacer"></div>
                    <div class="area-xaxis">${xTicks.map((t) => `<span>${t}</span>`).join("")}</div>
                </div>
            </div>`;

        wirePitchWaveformPlayback(container, id, trace, duration);
    }

    // Registry of graph widgets that have real render content wired up.
    // Only Spectrogram, Formants, Voice Quality, DDK Waveform, and
    // Pitch Waveform are ported for now — Contours stays as an empty
    // placeholder until requested.
    //
    // taskType is "Sustained", "DDK", or "Both" (task-agnostic) -- see
    // the big comment above getAvailableTaskTypesForTarget() near the
    // top of this file for the filtering this drives, and read it
    // before adding a new graph here so it gets tagged correctly.
    //
    // Formants and Voice Quality read live Sustained-vowel data (see
    // getSustainedValuesForTarget()), so they're tagged Sustained.
    // Spectrogram is tagged "Both": for a single-recording target it
    // renders the real compute_spectrogram() STFT of that recording's
    // waveform (see renderRealSpectrogram/api.getRecordingSpectrogram),
    // which is task-agnostic and works just as well for DDK audio; it
    // only falls back to the Sustained-only synthesized stand-in (see
    // renderSynthesizedSpectrogram) if that recording's real fetch
    // fails. A subject aggregate target has no single waveform
    // to analyze, so it shows the empty state instead of synthesizing
    // stand-in data.
    const GRAPH_RENDERERS = {
        Spectrogram: { render: renderSpectrogram, width: 520, height: 340, taskType: "Both" },
        Formants: { render: renderFormants, width: 320, height: 200, taskType: "Sustained" },
        "Voice Quality": { render: renderVoiceQuality, width: 320, height: 200, taskType: "Sustained" },
        "MDVP Profile": { render: renderMDVPSpider, width: 380, height: 360, taskType: "Sustained" },
        "Vowel Space": { render: renderVowelSpaceCard, width: 460, height: 420, taskType: "Sustained" },
        "Vowel Space Trajectory": { render: renderVowelSpaceTrajectory, width: 580, height: 520, taskType: "Sustained" },
        "Vowel Drift Trend": { render: renderVowelDriftTrend, width: 640, height: 300, taskType: "Sustained" },
        "Pitch Waveform": { render: renderPitchWaveform, width: 520, height: 320, taskType: "Sustained" },
        "DDK Waveform": { render: renderDDKWaveform, width: 520, height: 320, taskType: "DDK" },
        "DDK Peak Tracker": { render: renderDDKPeakTracker, width: 640, height: 380, taskType: "DDK" },
        "Interval Bar Chart": { render: renderIntervalBarChart, width: 640, height: 380, taskType: "DDK" },
        "Regularity Trend": { render: renderRegularityTrend, width: 640, height: 380, taskType: "DDK" },
        "Pause Ratio": { render: renderPauseRatio, width: 420, height: 260, taskType: "DDK" },
        "DDK Summary": { render: renderDDKSummary, width: 460, height: 220, taskType: "DDK" },
        "DDK Repetition Count Trend": { render: renderDDKRepetitionCountTrend, width: 640, height: 380, taskType: "DDK" },
        "DDK Regularity Trend": { render: renderDDKRegularityLongTrend, width: 640, height: 380, taskType: "DDK" },
        "Interval Stability Trend": { render: renderDDKIntervalStabilityTrend, width: 640, height: 380, taskType: "DDK" },
        "Pause Ratio Trend": { render: renderPauseRatioTrend, width: 640, height: 380, taskType: "DDK" },
        "Rate Trend": { render: renderRateTrend, width: 640, height: 400, taskType: "DDK" },
    };

    // Exposed so top-level code (updateWidgetButtonsAvailability, outside
    // this IIFE) can filter graph buttons by task type without duplicating
    // GRAPH_RENDERERS as the source of truth.
    graphTaskTypes = Object.fromEntries(
        Object.entries(GRAPH_RENDERERS).map(([title, cfg]) => [title, cfg.taskType])
    );

    // Builds a widget's inner markup for a given title/valueType — pulled
    // out so it can be reused both for real widgets and for measuring a
    // hypothetical widget's natural size (see measureWidgetWidth).
    function buildWidgetMarkup(widgetTitle, valueType) {
        const isMetricType = widgetTitle === "Values" || widgetTitle === "Quality";
        const subtypeHtml = isMetricType && valueType
            ? `<span class="pinboard-widget-subtype">${valueType}</span>`
            : "";
        const emptyText = isMetricType ? "No recordings selected yet" : "No graph selected yet";
        const metrics = isMetricType ? ((WIDGET_METRICS[widgetTitle] && WIDGET_METRICS[widgetTitle][valueType]) || []) : [];
        const metricValues = isMetricType ? getWidgetValuesSync(widgetTitle, valueType) : {};

        const bodyHtml = metrics.length
            ? `<div class="pinboard-values-list">
                ${metrics.map(label => `
                <div class="pinboard-values-row" data-metric-key="${label}">
                    <span class="pinboard-values-label">${label}</span>
                    <span class="pinboard-values-value">${metricValues[label] !== undefined ? metricValues[label] : "&mdash;"}</span>
                </div>`).join("")}
            </div>`
            : `<div class="pinboard-widget-empty">${emptyText}</div>`;
        const bodyClass = metrics.length ? "pinboard-widget-body pinboard-widget-body--list" : "pinboard-widget-body";

        if (!isMetricType) {
            // Graph placeholder widgets (Formants, Voice Quality, Spectrogram,
            // Pitch Waveform, DDK Waveform, and any plain "Widget N") are left completely
            // empty — no header, no title — with only a content container
            // (used by graph render functions) and hover-revealed pin/close
            // buttons in the corner, plus the resize handle.
            return `
                <div class="pinboard-widget-graph-content"></div>
                <button type="button" class="pinboard-widget-graph-pin-btn pinboard-pin-btn" title="Pin in place" aria-label="Pin graph">
                    <svg class="pin-icon" viewBox="2.5 6 86 86" xmlns="http://www.w3.org/2000/svg">
                        <path class="pin-fill" fill-rule="evenodd" d="
                            M33,24 L58,24 L58,29 L55,30 L55,46 L60,52 L60,56 L48,57 L48,71
                            L45.5,74 L43,71 L43,57 L31,56 L31,52 L36,46 L36,30 L33,29 Z
                            M41,30 L50,30 L50,49 L41,49 Z
                        "/>
                    </svg>
                </button>
                <button type="button" class="pinboard-widget-close-btn" title="Remove widget" aria-label="Remove graph">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
                <div class="pinboard-widget-resize-handle"></div>
            `;
        }

        return `
            <div class="pinboard-widget-header">
                <span class="pinboard-widget-title">${widgetTitle}</span>
                ${subtypeHtml}
                <div class="pinboard-widget-actions">
                    <button type="button" class="pinboard-widget-btn pinboard-pin-btn" title="Pin in place">
                        <svg class="pin-icon" viewBox="0 0 85 97" xmlns="http://www.w3.org/2000/svg">
                            <path class="pin-fill" fill-rule="evenodd" d="
                                M33,24 L58,24 L58,29 L55,30 L55,46 L60,52 L60,56 L48,57 L48,71
                                L45.5,74 L43,71 L43,57 L31,56 L31,52 L36,46 L36,30 L33,29 Z
                                M41,30 L50,30 L50,49 L41,49 Z
                            "/>
                        </svg>
                    </button>
                    <button type="button" class="pinboard-widget-btn pinboard-close-btn" title="Remove widget">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
                        </svg>
                    </button>
                </div>
            </div>
            <div class="${bodyClass}">
                ${bodyHtml}
            </div>
            <div class="pinboard-widget-resize-handle"></div>
        `;
    }

    // Re-reads current values for one widget and patches its rows in
    // place (no re-render) — used once a pending subject summary
    // fetch lands, so any Values widget already on the board picks up the
    // real numbers instead of staying on em-dashes.
    function refreshWidgetValues(widget) {
        const kind = widget.dataset.widgetKind;
        const widgetTitle = kind === "values" ? "Values" : kind === "quality" ? "Quality" : null;
        if (!widgetTitle) return;
        const values = getWidgetValuesSync(widgetTitle, widget.dataset.valueType);
        widget.querySelectorAll(".pinboard-values-row").forEach(row => {
            const key = row.dataset.metricKey;
            const valueEl = row.querySelector(".pinboard-values-value");
            if (valueEl) valueEl.textContent = (key in values) ? values[key] : "\u2014";
        });
    }

    refreshAllWidgetValuesFn = function () {
        board.querySelectorAll(".pinboard-widget[data-widget-kind]").forEach(refreshWidgetValues);
        // Also re-render every open graph widget (Formants, Voice Quality,
        // Spectrogram, Pitch Waveform, DDK Waveform) so they pick up the fresh
        // _summary/_raw data too, not just the Values/Quality number
        // widgets above -- e.g. after a new recording is added to the
        // subject currently being analyzed. Each graph reads its
        // own live data on every render (see getSustainedValuesForTarget/
        // getDdkValuesForTarget), so simply calling render() again is
        // enough; no separate "patch in place" step is needed the way
        // refreshWidgetValues() does for Values/Quality rows.
        board.querySelectorAll(".pinboard-widget[data-graph-title]").forEach(widget => {
            const renderer = GRAPH_RENDERERS[widget.dataset.graphTitle];
            const content = widget.querySelector(".pinboard-widget-graph-content");
            if (renderer && content) renderer.render(content);
        });
        // Also re-run task-type filtering (see getAvailableTaskTypesForTarget()
        // near the top of this file) now that a lazily-fetched subject
        // summary has landed -- until now we didn't know which task types were
        // actually present, so buttons/dropdown options were left showing.
        if (typeof updateWidgetButtonsAvailability === "function") updateWidgetButtonsAvailability();
    };

    // Measures the natural width a widget of the given kind would have,
    // by rendering it hidden off to the side and reading its offsetWidth.
    // Used so DDK can be placed flush against Sustained's right edge even
    // when no Sustained widget currently exists on the board.
    function measureWidgetWidth(widgetTitle, valueType) {
        return measureWidgetSize(widgetTitle, valueType).w;
    }

    function measureWidgetSize(widgetTitle, valueType) {
        const probe = document.createElement("div");
        probe.className = "pinboard-widget";
        probe.style.position = "absolute";
        probe.style.width = "max-content";
        probe.style.height = "max-content";
        probe.style.visibility = "hidden";
        probe.innerHTML = buildWidgetMarkup(widgetTitle, valueType);
        canvas.appendChild(probe);
        const boardRect = board.getBoundingClientRect();
        const isMetricType = widgetTitle === "Values" || widgetTitle === "Quality";
        const naturalW = probe.offsetWidth + (isMetricType ? METRIC_WIDTH_BUFFER : 0);
        const w = clamp(naturalW, MIN_W, boardRect.width);
        const h = clamp(probe.offsetHeight, MIN_H, boardRect.height);
        probe.remove();
        return { w, h };
    }

    function createWidget(title, valueType) {
        widgetCount += 1;
        const widgetTitle = title || `Widget ${widgetCount}`;
        const isMetricType = widgetTitle === "Values" || widgetTitle === "Quality";

        const widget = document.createElement("div");
        widget.className = "pinboard-widget";
        if (isMetricType) {
            widget.dataset.widgetKind = widgetTitle.toLowerCase();
            widget.dataset.valueType = valueType || "";
        } else {
            // Graph widgets aren't tagged with data-widget-kind (that's
            // reserved for Values/Quality), but we still stash the title
            // so the "already on the pinboard" check can name it later.
            widget.dataset.graphTitle = widgetTitle;
        }
        widget.innerHTML = buildWidgetMarkup(widgetTitle, valueType);

        // Size the widget to just fit its content (header + body) rather than
        // a fixed footprint, by measuring its natural (max-content) size once
        // it's in the DOM, then locking that in as an explicit px size.
        const boardRect = board.getBoundingClientRect();

        widget.style.position = "absolute";
        widget.style.width = "max-content";
        widget.style.height = "max-content";
        widget.style.visibility = "hidden";
        widget.style.zIndex = ++zCounter;
        canvas.appendChild(widget);

        // Ambient/Spectral is forced to match RMS/Noise/Clipping's natural
        // width, rather than sizing to its own (shorter) content, so the
        // two Quality widgets always default to the same width.
        const isAmbientQuality = widgetTitle === "Quality" && valueType === "Ambient/Spectral";
        // Overall is likewise forced to match SNR/Signal's natural width.
        const isOverallQuality = widgetTitle === "Quality" && valueType === "Overall";
        // Graph widgets (the plain "Widget N" placeholders from "Add Graph")
        // default to a fixed 30vw instead of sizing to their placeholder text.
        // Widgets with a registered renderer (see GRAPH_RENDERERS) use that
        // renderer's own default width/height instead.
        const graphRenderer = GRAPH_RENDERERS[widgetTitle];
        const isGraphWidget = !isMetricType;
        let naturalW = widget.offsetWidth;
        let naturalH = widget.offsetHeight;
        if (isAmbientQuality) {
            naturalW = measureWidgetWidth("Quality", "RMS/Noise/Clipping");
        } else if (isOverallQuality) {
            naturalW = measureWidgetWidth("Quality", "SNR/Signal");
        } else if (graphRenderer) {
            naturalW = graphRenderer.width;
            naturalH = graphRenderer.height;
        } else if (isGraphWidget) {
            naturalW = window.innerWidth * 0.30;
        } else if (isMetricType) {
            naturalW += METRIC_WIDTH_BUFFER;
        }

        const widgetW = clamp(naturalW, MIN_W, boardRect.width);
        const widgetH = clamp(naturalH, MIN_H, boardRect.height);

        const maxLeft = Math.max(0, boardRect.width - widgetW);
        const maxTop = Math.max(0, boardRect.height - widgetH);

        // Fixed spawn points — no memory of previous widgets, no shifting
        // to avoid overlap. Every widget of a given kind always lands in
        // the same spot; the user repositions it manually if they want.
        const isSustainedValues = widgetTitle === "Values" && valueType === "Sustained";
        const isDdkValues = widgetTitle === "Values" && valueType === "DDK";
        const isRmsQuality = widgetTitle === "Quality" && valueType === "RMS/Noise/Clipping";
        const isSnrQuality = widgetTitle === "Quality" && valueType === "SNR/Signal";
        const isAmbientPlacement = widgetTitle === "Quality" && valueType === "Ambient/Spectral";
        const isOverallPlacement = widgetTitle === "Quality" && valueType === "Overall";

        let desiredLeft;
        let desiredTop;
        if (isSustainedValues) {
            desiredLeft = 0; // touch the left edge
            desiredTop = 0; // touch the top edge
        } else if (isDdkValues) {
            // A directly-selected DDK recording has no Sustained widget to
            // sit beside (there's only ever one task type per recording),
            // so it goes in the top-left corner instead, flush against
            // both the left and top edges of the board.
            if (getDirectRecordingValueType() === "DDK") {
                desiredLeft = 0; // touch the left edge
                desiredTop = 0; // touch the top edge
            } else {
                const sustainedWidth = measureWidgetWidth("Values", "Sustained");
                desiredLeft = clamp(sustainedWidth, 0, maxLeft); // touch Sustained's right edge
                desiredTop = 0; // touch the top edge
            }
        } else if (isRmsQuality) {
            desiredLeft = maxLeft; // touch the right edge
            desiredTop = 0; // touch the top edge
        } else if (isSnrQuality) {
            const rmsWidth = measureWidgetWidth("Quality", "RMS/Noise/Clipping");
            const rmsLeft = Math.max(0, boardRect.width - rmsWidth); // RMS's left edge
            desiredLeft = clamp(rmsLeft - widgetW, 0, maxLeft); // touch RMS's left edge
            desiredTop = 0; // touch the top edge
        } else if (isAmbientPlacement) {
            const rmsSize = measureWidgetSize("Quality", "RMS/Noise/Clipping");
            const rmsLeft = Math.max(0, boardRect.width - rmsSize.w); // RMS's left edge
            desiredLeft = clamp(rmsLeft, 0, maxLeft); // align under RMS's left edge
            desiredTop = clamp(rmsSize.h, 0, maxTop); // touch RMS's bottom edge
        } else if (isOverallPlacement) {
            const rmsWidth = measureWidgetWidth("Quality", "RMS/Noise/Clipping");
            const snrSize = measureWidgetSize("Quality", "SNR/Signal");
            const rmsLeft = Math.max(0, boardRect.width - rmsWidth); // RMS's left edge
            const snrLeft = rmsLeft - snrSize.w; // SNR's left edge (touches RMS's left edge)
            desiredLeft = clamp(snrLeft, 0, maxLeft); // align under SNR's left edge
            desiredTop = clamp(snrSize.h, 0, maxTop); // touch SNR's bottom edge
        } else {
            desiredLeft = clamp(SPAWN_LEFT, 0, maxLeft);
            desiredTop = clamp(SPAWN_TOP, 0, maxTop);
        }

        widget.style.width = widgetW + "px";
        widget.style.height = widgetH + "px";
        widget.style.left = desiredLeft + "px";
        widget.style.top = desiredTop + "px";
        widget.style.visibility = "";

        // Graph widgets with a registered renderer (currently just
        // Spectrogram) draw their content now that the widget has its real
        // on-board size — canvas-based renderers measure their wrapper's
        // clientWidth/clientHeight, which isn't reliable until this point.
        if (graphRenderer) {
            const content = widget.querySelector(".pinboard-widget-graph-content");
            if (content) graphRenderer.render(content);
        }

        // Lock in this natural size as the 1x baseline for text/icon scaling.
        widget.dataset.baseW = widgetW;
        widget.dataset.baseH = widgetH;
        updateWidgetScale(widget);

        bringToFront(widget);
        wireWidget(widget);
        updatePinboardEmptyState();
    }

    function bringToFront(widget) {
        widget.style.zIndex = ++zCounter;
    }

    // Scales the widget's text/icons/padding to match its current footprint.
    // baseW/baseH (stored on the widget when it's created) are the widget's
    // "natural" content-fit size — i.e. the size at which text should render
    // at 1x. Growing/shrinking the widget from there scales everything
    // proportionally instead of just changing how much empty space there is.
    const MIN_SCALE = 0.75;
    const MAX_SCALE = 2.25;

    function updateWidgetScale(widget) {
        const baseW = parseFloat(widget.dataset.baseW) || widget.offsetWidth;
        const baseH = parseFloat(widget.dataset.baseH) || widget.offsetHeight;
        if (!baseW || !baseH) return;
        const scale = clamp(
            Math.min(widget.offsetWidth / baseW, widget.offsetHeight / baseH),
            MIN_SCALE,
            MAX_SCALE
        );
        widget.style.setProperty("--w-scale", scale.toFixed(3));
    }

    // Maps each graph toolbar button's title to its button id -- used to
    // mirror pinboard widget open/close state onto the corresponding
    // toolbar button's border (.is-open, see theme.css / addGraphWidget /
    // wireWidget's close handler below).
    const GRAPH_BUTTON_IDS = {
        "Formants": "add-formants-btn",
        "Voice Quality": "add-voice-quality-btn",
        "Spectrogram": "add-spectrogram-btn",
        "Pitch Waveform": "add-pitch-waveform-btn",
        "DDK Waveform": "add-ddk-waveform-btn",
    };

    function syncGraphToolbarButtonOpenState(title) {
        const stillOpen = !!board.querySelector(`.pinboard-widget[data-graph-title="${title}"]`);

        // Legacy toolbar button ids -- harmless no-op now that those
        // buttons have been removed from index.html, kept in case they
        // ever come back.
        const btnId = GRAPH_BUTTON_IDS[title];
        if (btnId) {
            const btn = container.querySelector("#" + btnId);
            if (btn) btn.classList.toggle("is-open", stillOpen);
        }

        // Sidebar graph buttons are rebuilt from scratch on every
        // renderSidebarContent() call (no stable id to hang onto), so
        // look them up by their data-graph attribute instead.
        container.querySelectorAll(`.sidebar-graph-btn[data-graph="${title}"]`).forEach((btn) => {
            btn.classList.toggle("is-open", stillOpen);
        });
    }

    // Fallback height (in px) of the drag-initiation strip for headerless
    // graph widgets whose content hasn't rendered a description yet (e.g.
    // still showing a "Loading…" placeholder) — see wireWidget() below.
    const GRAPH_WIDGET_DRAG_STRIP_FALLBACK_HEIGHT = 80;

    function wireWidget(widget) {
        const header = widget.querySelector(".pinboard-widget-header");
        const pinBtn = widget.querySelector(".pinboard-pin-btn");
        const closeBtn = widget.querySelector(".pinboard-close-btn, .pinboard-widget-close-btn");
        const resizeHandle = widget.querySelector(".pinboard-widget-resize-handle");
        // Graph placeholder widgets have no header (see buildWidgetMarkup) —
        // they're dragged from anywhere on the widget body instead, and have
        // no pin control (only the hover-revealed close button) to wire up.
        const dragSurface = header || widget;

        widget.addEventListener("mousedown", () => bringToFront(widget));

        // ---- Drag (from the header, unless pinned) ----
        dragSurface.addEventListener("mousedown", (e) => {
            if (e.target.closest(".pinboard-widget-btn")) return;
            if (e.target.closest(".pinboard-widget-close-btn")) return;
            if (e.target.closest(".pinboard-widget-graph-pin-btn")) return;
            if (e.target.closest(".pinboard-widget-resize-handle")) return;
            // Generic escape hatch for any interactive control inside a
            // header-less graph widget (e.g. Pitch Waveform's play button
            // and seek area) — .card-content's whole-widget drag surface
            // would otherwise swallow clicks meant for the control.
            if (e.target.closest(".graph-interactive")) return;
            // Graph widgets have no header bar, so dragSurface is the whole
            // widget — but the graph itself (waveforms, seek areas, etc.)
            // needs ordinary clicks/drags to reach it undisturbed. Only
            // treat a mousedown as a drag-start if it lands above the
            // top edge of the widget's own description text (e.g.
            // .area-sub / .spectro-sub — "Voice energy across time and
            // frequency" and the like), mirroring how headered widgets
            // only drag from their header. Falls back to a fixed height
            // if that element isn't there yet (still loading).
            if (!header) {
                const descEl = widget.querySelector(".area-sub, .spectro-sub");
                const dragBoundary = descEl
                    ? descEl.getBoundingClientRect().top
                    : widget.getBoundingClientRect().top + GRAPH_WIDGET_DRAG_STRIP_FALLBACK_HEIGHT;
                if (e.clientY > dragBoundary) return;
            }
            if (widget.classList.contains("pinned")) return;
            e.preventDefault();

            const boardRect = board.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = widget.offsetLeft;
            const startTop = widget.offsetTop;

            widget.classList.add("dragging");

            function onMove(ev) {
                // The board can be zoomed in/out (see the pan/zoom camera
                // further down), so a given on-screen mouse movement no
                // longer always equals that many canvas pixels — divide
                // by the live scale to keep the widget glued to the cursor.
                const camScale = (typeof getPinboardScaleFn === "function") ? getPinboardScaleFn() : 1;
                const dx = (ev.clientX - startX) / camScale;
                const dy = (ev.clientY - startY) / camScale;
                // Clamp against the canvas's current *accessible* bounds
                // (the initial default view, grown to include whatever
                // area zooming/panning has revealed since) rather than the
                // fixed on-screen viewport size — otherwise widgets could
                // never be moved past the original default-view edges no
                // matter how far the user had zoomed out. See the pinboard
                // pan/zoom camera IIFE further down for how these bounds
                // grow and persist.
                // Exclude this widget itself from the bounds calculation —
                // otherwise its own (mid-drag) position would always be
                // part of the union and the clamp could never bind.
                const bounds = (typeof getPinboardAccessibleBoundsFn === "function")
                    ? getPinboardAccessibleBoundsFn(widget)
                    : { left: 0, top: 0, right: boardRect.width, bottom: boardRect.height };
                const minLeft = bounds.left;
                const minTop = bounds.top;
                const maxLeft = Math.max(minLeft, bounds.right - widget.offsetWidth);
                const maxTop = Math.max(minTop, bounds.bottom - widget.offsetHeight);
                widget.style.left = clamp(startLeft + dx, minLeft, maxLeft) + "px";
                widget.style.top = clamp(startTop + dy, minTop, maxTop) + "px";
            }

            function onUp() {
                widget.classList.remove("dragging");
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            }

            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });

        // ---- Resize (from the bottom-right corner, unless pinned) ----
        resizeHandle.addEventListener("mousedown", (e) => {
            if (widget.classList.contains("pinned")) return;
            e.preventDefault();
            e.stopPropagation();
            bringToFront(widget);

            const boardRect = board.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            const startW = widget.offsetWidth;
            const startH = widget.offsetHeight;

            function onMove(ev) {
                // Same scale correction as widget dragging above.
                const camScale = (typeof getPinboardScaleFn === "function") ? getPinboardScaleFn() : 1;
                const dx = (ev.clientX - startX) / camScale;
                const dy = (ev.clientY - startY) / camScale;
                // Same accessible-bounds clamp as dragging above, so a
                // widget can be grown into newly revealed canvas space
                // instead of being capped at the original viewport edge.
                // Same self-exclusion as dragging above — a resize should
                // never be limited by the widget's own footprint.
                const bounds = (typeof getPinboardAccessibleBoundsFn === "function")
                    ? getPinboardAccessibleBoundsFn(widget)
                    : { left: 0, top: 0, right: boardRect.width, bottom: boardRect.height };
                const maxW = bounds.right - widget.offsetLeft;
                const maxH = bounds.bottom - widget.offsetTop;

                const newW = clamp(startW + dx, MIN_W, Math.max(MIN_W, maxW));
                let newH = clamp(startH + dy, MIN_H, Math.max(MIN_H, maxH));

                widget.style.width = newW + "px";
                widget.style.height = newH + "px";
                updateWidgetScale(widget);

                // Don't let the widget shrink vertically past what its content
                // (at the current text scale) actually needs — otherwise the
                // body would need to scroll. Grow back to fit instead.
                const body = widget.querySelector(".pinboard-widget-body");
                if (body && body.scrollHeight > body.clientHeight + 1) {
                    const header = widget.querySelector(".pinboard-widget-header");
                    const needed = (header ? header.offsetHeight : 0) + body.scrollHeight;
                    newH = clamp(Math.max(newH, needed), MIN_H, Math.max(MIN_H, maxH));
                    widget.style.height = newH + "px";
                    updateWidgetScale(widget);
                }
            }

            function onUp() {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            }

            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });

        // ---- Pin toggle ----
        if (pinBtn) {
            pinBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const pinned = widget.classList.toggle("pinned");
                pinBtn.classList.toggle("active", pinned);
                pinBtn.title = pinned ? "Unpin" : "Pin in place";
            });
        }

        // ---- Remove ----
        if (closeBtn) {
            closeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const graphTitle = widget.dataset.graphTitle;
                widget.remove();
                if (graphTitle) syncGraphToolbarButtonOpenState(graphTitle);
                updatePinboardEmptyState();
            });
        }
    }

    // ---- Formants / Voice Quality / Spectrogram / Pitch Waveform / DDK Waveform buttons ----
    // Same behavior as the Graphs button (plain graph-placeholder widgets),
    // just pre-labeled instead of falling back to "Widget N".
    const addFormantsBtn = container.querySelector("#add-formants-btn");
    const addVoiceQualityBtn = container.querySelector("#add-voice-quality-btn");
    const addSpectrogramBtn = container.querySelector("#add-spectrogram-btn");
    const addPitchWaveformBtn = container.querySelector("#add-pitch-waveform-btn");
    const addDdkWaveformBtn = container.querySelector("#add-ddk-waveform-btn");

    // Only one widget of each graph type (Formants / Voice Quality /
    // Spectrogram / DDK Waveform / Pitch Waveform) is allowed on the pinboard at a
    // time — different graph types can still coexist. Graph widgets
    // are tagged with data-graph-title (data-widget-kind is reserved
    // for the Values/Quality metric widgets). If one of this type is
    // already up there, focus/highlight it and let the user know
    // instead of adding a duplicate.
    function addGraphWidget(title) {
        const existing = board.querySelector(`.pinboard-widget[data-graph-title="${title}"]`);
        if (existing) {
            bringToFront(existing);
            existing.classList.remove("pinboard-widget-highlight");
            void existing.offsetWidth;
            existing.classList.add("pinboard-widget-highlight");
            showToast(`A ${title} widget is already on the pinboard.`);
            return;
        }
        createWidget(title);
        syncGraphToolbarButtonOpenState(title);
    }

    if (addFormantsBtn) addFormantsBtn.addEventListener("click", () => addGraphWidget("Formants"));
    if (addVoiceQualityBtn) addVoiceQualityBtn.addEventListener("click", () => addGraphWidget("Voice Quality"));
    if (addSpectrogramBtn) addSpectrogramBtn.addEventListener("click", () => addGraphWidget("Spectrogram"));
    if (addPitchWaveformBtn) addPitchWaveformBtn.addEventListener("click", () => addGraphWidget("Pitch Waveform"));
    if (addDdkWaveformBtn) addDdkWaveformBtn.addEventListener("click", () => addGraphWidget("DDK Waveform"));

    // The toolbar no longer has its own Formants/Voice Quality/Spectrogram/
    // Pitch Waveform/DDK Waveform buttons -- the sidebar (built by
    // renderSidebarContent() in the top-level scope, outside this IIFE) is
    // now the only place these graphs get added from. Expose addGraphWidget
    // so those sidebar buttons can call the same add/focus-existing logic.
    addGraphWidgetFn = addGraphWidget;

    // ---- Widget type dropdowns (Values: Sustained vowel / DDK — Quality: Overall / SNR / RMS / Ambient) ----
    const typeDropdowns = [];

    function closeAllTypeDropdowns() {
        typeDropdowns.forEach(dd => dd.classList.remove("open"));
    }
    // Exposed so the recording-select dropdown (wired up elsewhere) can
    // close these when it opens, and vice versa.
    closeAllTypeDropdownsFn = closeAllTypeDropdowns;

    function addOrFocusWidget(widgetTitle, valueType, label) {
        const existing = board.querySelector(
            `.pinboard-widget[data-widget-kind="${widgetTitle.toLowerCase()}"][data-value-type="${valueType}"]`
        );

        if (existing) {
            bringToFront(existing);
            existing.classList.remove("pinboard-widget-highlight");
            // Force reflow so the highlight animation can replay.
            void existing.offsetWidth;
            existing.classList.add("pinboard-widget-highlight");
            showToast(`A ${label} widget is already on the pinboard.`);
        } else {
            createWidget(widgetTitle, valueType);
        }
    }

    function wireTypeDropdown(triggerId, wrapId, dropdownId, widgetTitle) {
        const trigger = container.querySelector("#" + triggerId);
        const wrap = container.querySelector("#" + wrapId);
        const dropdown = container.querySelector("#" + dropdownId);
        if (!trigger || !wrap || !dropdown) return;

        typeDropdowns.push(dropdown);

        trigger.addEventListener("click", (e) => {
            e.stopPropagation();

            if (typeof closeRecordingSelectDropdownFn === "function") {
                closeRecordingSelectDropdownFn();
            }

            if (widgetTitle === "Values") {
                const directType = getDirectRecordingValueType();
                if (directType) {
                    closeAllTypeDropdowns();
                    addOrFocusWidget(widgetTitle, directType, directType === "Sustained" ? "Sustained vowel" : "DDK");
                    return;
                }
            }

            const willOpen = !dropdown.classList.contains("open");
            closeAllTypeDropdowns();
            if (willOpen) dropdown.classList.add("open");
        });

        dropdown.addEventListener("click", (e) => e.stopPropagation());

        dropdown.querySelectorAll(".menubar-dropdown-item").forEach(item => {
            item.addEventListener("click", () => {
                const valueType = item.dataset.valueType;
                addOrFocusWidget(widgetTitle, valueType, item.textContent);
                closeAllTypeDropdowns();
            });
        });
    }

    wireTypeDropdown("add-values-btn", "values-type-wrap", "values-type-dropdown", "Values");
    wireTypeDropdown("add-quality-btn", "quality-type-wrap", "quality-type-dropdown", "Quality");

    addDocListener("click", (e) => {
        if (!isTabActive()) return;
        if (isInsideOpenModal(e.target)) return;
        closeAllTypeDropdowns();
    });
    addDocListener("keydown", (e) => {
        if (!isTabActive()) return;
        if (e.key === "Escape") closeAllTypeDropdowns();
    });
})();

// ================= Pinboard: infinite pan & zoom camera =================
// The board (#nav-strip) is a fixed-size viewport; #pinboard-canvas is a
// much larger layer, positioned behind it, that holds every widget. This
// IIFE lets the user grab and drag that layer around and zoom it in/out,
// which makes the pinboard feel like an unbounded surface even though the
// widgets themselves still live in the same coordinate space they always
// have. A small round button toggles the mode on/off; a second button,
// which only appears while the mode is active, snaps the camera straight
// back to its starting position and zoom level.
(function () {
    const board = container.querySelector("#nav-strip");
    const canvas = container.querySelector("#pinboard-canvas");
    const toggleBtn = container.querySelector("#pinboard-pan-toggle-btn");
    const recenterBtn = container.querySelector("#pinboard-recenter-btn");
    if (!board || !canvas || !toggleBtn || !recenterBtn) return;

    const MIN_SCALE = 0.4;
    const MAX_SCALE = 2.5;

    let panX = 0;
    let panY = 0;
    let scale = 1;
    let panModeActive = false;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartPanX = 0;
    let dragStartPanY = 0;

    // ---- Accessible canvas bounds ----
    // The default view on load (in canvas-local coordinates, the same
    // space widget left/top live in) is the baseline boundary that widget
    // drag/resize (see wireWidget()) clamps against, via
    // getPinboardAccessibleBoundsFn(), instead of the fixed
    // on-screen viewport size.
    //
    // This is recomputed live on every call rather than accumulated as a
    // permanent high-water-mark, and is the union of three things:
    //   1) the default (initial) viewport — the normal, everyday bounds.
    //   2) the canvas-local rectangle currently visible through the
    //      viewport, given the live pan offset and zoom scale — so
    //      zooming/panning out lets you drag a widget into newly
    //      revealed empty space right away.
    //   3) the bounding box of every widget currently on the board — so
    //      a widget that was previously dragged out past the default
    //      view (while zoomed out) stays reachable/draggable later, even
    //      after the camera has returned to the default view.
    // Because (3) is measured from live widget positions rather than a
    // remembered high-water-mark, dragging an out-of-bounds widget back
    // inside the default view removes the one thing that was propping
    // the bounds open — so once it (and everything else) is back inside,
    // and the camera is back at the default view, the accessible bounds
    // collapse back to exactly the default viewport on their own instead
    // of staying permanently stuck at wherever that widget had reached.
    const initialBoardRect = board.getBoundingClientRect();
    const defaultBounds = {
        left: 0,
        top: 0,
        right: initialBoardRect.width || 0,
        bottom: initialBoardRect.height || 0
    };

    // excludeWidget: the widget currently being dragged/resized, if any —
    // its own (mid-gesture) position must not count toward the bounds
    // that its own drag/resize is being clamped against, or the clamp
    // could never bind.
    function computeAccessibleBounds(excludeWidget) {
        const bounds = { ...defaultBounds };

        const boardRect = board.getBoundingClientRect();
        if (boardRect.width && boardRect.height) {
            const visLeft = -panX / scale;
            const visTop = -panY / scale;
            bounds.left = Math.min(bounds.left, visLeft);
            bounds.top = Math.min(bounds.top, visTop);
            bounds.right = Math.max(bounds.right, visLeft + boardRect.width / scale);
            bounds.bottom = Math.max(bounds.bottom, visTop + boardRect.height / scale);
        }

        canvas.querySelectorAll(".pinboard-widget").forEach((w) => {
            if (w === excludeWidget) return;
            bounds.left = Math.min(bounds.left, w.offsetLeft);
            bounds.top = Math.min(bounds.top, w.offsetTop);
            bounds.right = Math.max(bounds.right, w.offsetLeft + w.offsetWidth);
            bounds.bottom = Math.max(bounds.bottom, w.offsetTop + w.offsetHeight);
        });

        return bounds;
    }

    // Lets widget drag/resize (defined earlier in this file) read the
    // current accessible bounds without this IIFE needing to run first.
    getPinboardAccessibleBoundsFn = (excludeWidget) => computeAccessibleBounds(excludeWidget);

    // True only once the user has actually grabbed and dragged the board.
    // The math above is correct for zoom-only movement too, but a ring
    // showing a direction after nothing but a scroll still reads as
    // "why is this pointing anywhere, I didn't drag" — so the ring stays
    // hidden until a real drag happens, and goes quiet again on recenter.
    let hasManualPan = false;

    // Continuous (unwrapped) angle driving the recenter button's compass
    // ring, in degrees. Kept unbounded (rather than clamped to -180..180)
    // so the CSS transition always rotates the short way around instead
    // of occasionally spinning a full circle when crossing that boundary.
    let compassAngle = 0;

    function updateCompassAngle() {
        if (!hasManualPan) {
            recenterBtn.classList.add("pinboard-recenter-no-direction");
            return;
        }
        recenterBtn.classList.remove("pinboard-recenter-no-direction");

        // "Home" means the specific piece of canvas content that would be
        // centered in the viewport once reset — the canvas-local point
        // that currently sits at the viewport's own center, back when
        // panX/panY/scale were all at their default values. Point toward
        // wherever THAT content is sitting on screen right now.
        //
        // At scale 1, that reduces to the plain pan offset (panX, panY).
        // But zooming shifts what's centered too — and since the wheel
        // handler anchors zoom on the cursor rather than the viewport
        // center, panX/panY alone stop being enough once scale != 1. The
        // extra (viewport-half)*(scale-1) term corrects for that: it's
        // zero exactly when zoom was centered (nothing to correct for),
        // and grows as the zoom's anchor drifts from center.
        const boardRect = board.getBoundingClientRect();
        const dx = panX + (boardRect.width / 2) * (scale - 1);
        const dy = panY + (boardRect.height / 2) * (scale - 1);
        // Dead-center: no meaningful direction, so just leave the ring
        // wherever it last pointed rather than snapping it somewhere.
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

        const target = Math.atan2(dx, -dy) * (180 / Math.PI); // 0deg = up, clockwise
        let delta = target - (compassAngle % 360);
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        compassAngle += delta;
        recenterBtn.style.setProperty("--compass-angle", `${compassAngle}deg`);
    }

    function applyTransform() {
        canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        updateCompassAngle();
        // Accessible bounds are computed live from the current pan/zoom
        // and widget positions on demand (see computeAccessibleBounds
        // above) — nothing needs to be recorded here on every move.
    }

    // easeOutExpo — matches the CSS linear()/anime.js "outExpo" curve: a
    // fast initial burst that eases into the landing spot instead of
    // stopping abruptly. 1 - 2^(-10t), with t=1 handled explicitly since
    // the formula only approaches (never exactly hits) 1 on its own.
    // Softened a bit (t*0.85 exponent scaling) and given more time to
    // play out — the raw curve reaches ~97% of the distance in the first
    // 200ms, which read as a snap rather than a glide.
    function easeOutExpo(t) {
        return t === 1 ? 1 : 1 - Math.pow(2, -8 * t);
    }

    let resetAnimFrame = null;
    // destroy() lives outside this IIFE and can't reach resetAnimFrame
    // directly (same reason the other bridges exist) -- this cancels
    // the in-flight camera-reset animation, if any, on tab close.
    pinboardCameraCleanupFn = function () {
        if (resetAnimFrame) {
            cancelAnimationFrame(resetAnimFrame);
            resetAnimFrame = null;
        }
    };

    function resetView() {
        // A second click mid-flight should retarget smoothly from wherever
        // the camera currently is, not restart from the old start point.
        if (resetAnimFrame) {
            cancelAnimationFrame(resetAnimFrame);
            resetAnimFrame = null;
        }

        // Heading home — the ring has nothing left to point at until the
        // next real drag.
        hasManualPan = false;

        const startX = panX;
        const startY = panY;
        const startScale = scale;
        const duration = 1100; // ms
        const startTime = performance.now();

        function step(now) {
            const t = Math.min(1, (now - startTime) / duration);
            const eased = easeOutExpo(t);

            panX = startX + (0 - startX) * eased;
            panY = startY + (0 - startY) * eased;
            scale = startScale + (1 - startScale) * eased;
            applyTransform();

            if (t < 1) {
                resetAnimFrame = requestAnimationFrame(step);
            } else {
                resetAnimFrame = null;
            }
        }

        resetAnimFrame = requestAnimationFrame(step);
    }

    function setPanMode(active) {
        panModeActive = active;
        document.body.classList.toggle("pinboard-pan-mode", active);
        toggleBtn.classList.toggle("active", active);
        toggleBtn.setAttribute("aria-pressed", active ? "true" : "false");
        toggleBtn.title = active ? "Exit move & zoom mode" : "Move & zoom board";
        // Turning the mode off no longer snaps the camera back to its
        // starting position/zoom — the whole point of panning around is
        // to land somewhere, so leaving the mode should leave the board
        // exactly where the user put it. Widget dragging/resizing reads
        // the live scale (see getPinboardScaleFn below) so it stays
        // pixel-accurate at any zoom level, not just scale === 1. The
        // recenter button (visible only while the mode is active) is
        // still there for anyone who explicitly wants to go back home.
    }

    // Lets other code (widget drag/resize) convert on-screen mouse deltas
    // into canvas-local deltas, since the canvas can now stay zoomed in
    // or out even after the user exits move/zoom mode.
    getPinboardScaleFn = () => scale;

    toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setPanMode(!panModeActive);
    });

    recenterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        resetView();
        // Getting back to the default view via this button should feel
        // like "I'm done" — drop out of move/zoom mode too instead of
        // leaving the toggle on and requiring a second click.
        if (panModeActive) setPanMode(false);
    });

    // ---- Drag to pan ----
    board.addEventListener("mousedown", (e) => {
        if (!panModeActive) return;
        if (e.target.closest(".pinboard-pan-toggle-btn, .pinboard-recenter-btn")) return;
        e.preventDefault();

        // Grabbing the board mid-recenter-animation should hand control
        // straight back to the user instead of the animation continuing
        // to fight their drag.
        if (resetAnimFrame) {
            cancelAnimationFrame(resetAnimFrame);
            resetAnimFrame = null;
        }

        isDragging = true;
        hasManualPan = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartPanX = panX;
        dragStartPanY = panY;
        board.classList.add("pinboard-panning");

        function onMove(ev) {
            panX = dragStartPanX + (ev.clientX - dragStartX);
            panY = dragStartPanY + (ev.clientY - dragStartY);
            applyTransform();
        }

        function onUp() {
            isDragging = false;
            board.classList.remove("pinboard-panning");
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        }

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    });

    // ---- Scroll/wheel to zoom, centered on the cursor ----
    board.addEventListener("wheel", (e) => {
        if (!panModeActive) return;
        e.preventDefault();

        if (resetAnimFrame) {
            cancelAnimationFrame(resetAnimFrame);
            resetAnimFrame = null;
        }

        const boardRect = board.getBoundingClientRect();
        const mouseX = e.clientX - boardRect.left;
        const mouseY = e.clientY - boardRect.top;

        const zoomFactor = Math.exp(-e.deltaY * 0.001);
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * zoomFactor));
        if (newScale === scale) return;

        // Keep whatever point is under the cursor fixed on screen while
        // the scale changes, so zooming feels anchored to the cursor
        // instead of always zooming toward the top-left corner.
        panX = mouseX - ((mouseX - panX) / scale) * newScale;
        panY = mouseY - ((mouseY - panY) / scale) * newScale;
        scale = newScale;
        applyTransform();
    }, { passive: false });

    applyTransform();
})();

// ================= Back to Home =================
// Same bubbling-event pattern as "arc-tab-title" below -- this factory has
// no reference to the tab manager, so it can't switch its own tab back to
// Home directly. It just announces the intent on `container`; tabs.js
// listens for it (event delegation on #tab-pages) and does the actual
// swap, same division of responsibility as switchTabToProject.
const backToHomeBtn = container.querySelector("#back-to-home-btn");
if (backToHomeBtn) {
    backToHomeBtn.addEventListener("click", () => {
        container.dispatchEvent(new CustomEvent("arc-go-home", { bubbles: true }));
    });
}

// ================= Project-deleted overlay =================
// Home dispatches "arc-project-deleted" (document-level, detail:
// { projectId }) after a successful delete -- see deleteProject in
// home.js. If THIS tab happens to be showing the project that just got
// deleted (from a Home tab, possibly a different one), the underlying
// files are already gone, so rather than let every subsequent action in
// this tab just fail with confusing errors, lock it behind a message and
// the same Back-to-Home path as the button above. No Cancel/Escape
// dismissal for this one -- see the overlay markup's own comment for why.
const projectDeletedOverlay = container.querySelector("#projectDeletedOverlay");
const projectDeletedHomeBtn = container.querySelector("#projectDeletedHomeBtn");
if (projectDeletedHomeBtn) {
    projectDeletedHomeBtn.addEventListener("click", () => {
        container.dispatchEvent(new CustomEvent("arc-go-home", { bubbles: true }));
    });
}
addDocListener("arc-project-deleted", (e) => {
    if (projectDeletedOverlay && e.detail && e.detail.projectId === projectId) {
        projectDeletedOverlay.classList.add("visible");
    }
});

// Initial render
updateSortLabel();
renderLevelChrome();
loadSubjects();   // fetches this project's /subjects and renders once loaded
renderRecordings();

// Reflect which project this tab's instance is showing, via a bubbling
// custom event on `container` -- NOT `document.title`. This factory can
// run as one of several tabs sharing a single page now (see tabs.js), so
// there's no longer one "the" document title for a single instance to
// own; tabs.js listens for this event (event delegation on #tab-pages)
// to update just this tab's own label in the tab strip.
if (projectId) {
    apiFetch(`/api/projects/${encodeURIComponent(projectId)}`)
        .then((project) => {
            if (project && project.name) {
                container.dispatchEvent(new CustomEvent("arc-tab-title", {
                    detail: { title: project.name },
                    bubbles: true,
                }));
            }
        })
        .catch(() => { /* project may have been deleted from another tab -- leave the default title */ });
}

// ================= destroy() =================
// Called by whatever eventually manages tabs when this instance's tab is
// closed. Covers everything that's reachable from this factory's own
// scope:
//   - all 14 document-level Escape/click-outside listeners, via the
//     addDocListener bookkeeping above (the highest-value fix here --
//     without it, every tab ever opened in a session leaves a full set
//     of listeners on `document` forever, per the task doc's "#2
//     subtlety")
//   - the pending toast-hide, done-overlay, and countdown timeouts, and
//     the live recording rAF loop, all of which are plain top-level
//     closure state
//   - the two pinboard IIFEs' own cleanup, via the bridge functions they
//     each assign (pinboardWidgetsCleanupFn disconnects every
//     spectrogram ResizeObserver; pinboardCameraCleanupFn cancels an
//     in-flight camera-reset animation)
//
// Known gap, not covered: the per-widget audio-waveform playback rAF
// loops (wireRealAudioPlayback / wirePitchWaveformPlayback /
// wireDDKWaveformPlayback, inside the widgets IIFE) each keep their own
// local `rafId`, created fresh per rendered widget rather than tracked
// anywhere this function can reach. They already stop themselves on
// pause/ended in the normal case, so the risk is bounded to "a widget
// that's actively mid-playback when the tab closes" rather than an
// indefinite leak like the listeners/observers above -- but it's a real
// gap, not a false one, so flagging it rather than claiming full
// coverage. Closing it properly would mean giving each of those three
// functions the same kind of registry the ResizeObservers just got.
function destroy() {
    docListeners.forEach(({ type, handler, options }) => {
        document.removeEventListener(type, handler, options);
    });
    docListeners.length = 0;

    clearTimeout(doneOverlayTimeoutId);
    clearTimeout(countdownTimeoutId);
    if (recordingRafId) {
        cancelAnimationFrame(recordingRafId);
        recordingRafId = null;
    }

    if (typeof pinboardWidgetsCleanupFn === "function") pinboardWidgetsCleanupFn();
    if (typeof pinboardCameraCleanupFn === "function") pinboardCameraCleanupFn();
}

return { destroy };

} // end createProjectView

// createProjectView is a plain top-level function declaration, so loading
// this file (via <script src="js/project.js">) is all a caller needs to do
// before calling it -- see UI/js/tabs.js, which calls it once per project
// tab with that tab's own container element and project id. There is no
// auto-running bootstrap call in this file anymore: the single-instance
// self-test call that used to live here (reading the project id off
// window.location.search and mounting into document.body) was removed once
// this factory was wired into the real multi-tab shell, which is what now
// decides which container gets which project.
