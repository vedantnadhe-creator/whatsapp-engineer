// ============================================================
// project_events.js — keeps a project's context doc current.
//
// One funnel: something happened to a session → find the project(s) that session
// belongs to → append a line to their docs and refresh their session roster.
// Callers (dashboard routes, the execution engine) never touch the markdown.
//
// Logging must never break the thing that triggered it, so every entry point is
// failure-tolerant: a bad path or an unwritable disk is reported and swallowed.
// ============================================================

import { syncProjectSessions, appendProjectUpdate } from './project_doc.js';

// Free-form note an agent can print to record something the dashboard cannot see
// (a DEV deploy, a decision, a migration). Kept deliberately small: one flexible
// marker plus the UAT one that already exists in CLAUDE.md.
const NOTE_MARKER = /\[\[PROJECT:\s*([^\]]+)\]\]/g;
const UAT_MARKER = '[[UAT_DEPLOYED]]';

function projectsForSession(store, sessionId) {
    if (!sessionId) return [];
    try { return store.getSessionProjects(sessionId); }
    catch { return []; }
}

// Regenerates the `## Sessions` roster of one project from the DB.
export function syncProjectRoster(store, project) {
    try {
        const full = store.getProject(project.id);
        if (!full) return;
        const sessions = full.session_ids.map(id => store.getSession(id)).filter(Boolean);
        syncProjectSessions(full, sessions);
    } catch (err) {
        console.error(`[Projects] Could not refresh the roster of ${project.id}:`, err.message);
    }
}

// Appends `text` to every project the session belongs to. `opts.roster` also
// refreshes the session list (membership or session state changed).
export function logSessionEvent(store, sessionId, text, { roster = false } = {}) {
    const projects = projectsForSession(store, sessionId);
    for (const project of projects) {
        try {
            if (roster) syncProjectRoster(store, project);
            appendProjectUpdate(project, text);
        } catch (err) {
            console.error(`[Projects] Could not log "${text}" in ${project.id}:`, err.message);
        }
    }
    return projects;
}

export function logProjectEvent(store, projectId, text, { roster = false } = {}) {
    try {
        const project = store.getProject(projectId);
        if (!project) return false;
        if (roster) syncProjectRoster(store, project);
        return appendProjectUpdate(project, text);
    } catch (err) {
        console.error(`[Projects] Could not log "${text}" in ${projectId}:`, err.message);
        return false;
    }
}

// Scans one assistant message for project markers. Returns the lines to log, so
// the caller can stay ignorant of the marker vocabulary.
export function extractMarkerUpdates(content) {
    if (!content || typeof content !== 'string') return [];
    const updates = [];
    if (content.includes(UAT_MARKER)) updates.push('🚀 Deployed to UAT');
    for (const match of content.matchAll(NOTE_MARKER)) {
        const note = match[1].trim();
        if (note) updates.push(note);
    }
    return updates;
}

// A session printed something worth recording. Deduped inside appendProjectUpdate,
// because the same content arrives on both the assistant_message and result events.
export function logMarkersFromOutput(store, sessionId, content) {
    const updates = extractMarkerUpdates(content);
    if (!updates.length) return;
    // Resolve membership once — a long project can have many sessions.
    const projects = projectsForSession(store, sessionId);
    if (!projects.length) return;
    for (const project of projects) {
        for (const text of updates) {
            try { appendProjectUpdate(project, `${text} _(${sessionId})_`); }
            catch (err) { console.error(`[Projects] Could not log a marker in ${project.id}:`, err.message); }
        }
    }
}

// Sprint board / QA events reach a project through the session attached to the
// feature, so they all resolve the same way.
export function sessionIdsOfIssue(issue) {
    if (!issue) return [];
    return [issue.session_id, issue.dev_session_id, issue.design_session_id, issue.qa_session_id, issue.fork_session_id]
        .filter(Boolean);
}

// Logs an issue-driven event into whichever project holds one of the issue's
// sessions, without repeating the line when several of them share a project.
export function logIssueEvent(store, issue, text) {
    const seen = new Set();
    for (const sessionId of sessionIdsOfIssue(issue)) {
        for (const project of projectsForSession(store, sessionId)) {
            if (seen.has(project.id)) continue;
            seen.add(project.id);
            try { appendProjectUpdate(project, text); }
            catch (err) { console.error(`[Projects] Could not log "${text}" in ${project.id}:`, err.message); }
        }
    }
    return seen.size;
}
