// ============================================================
// project_doc.js — the on-disk context doc for a project.
//
// Every project owns one markdown file, `project_<slug>.md`, that acts as its
// reference point. It has three parts:
//   - the header + `## Context`, owned by whoever writes it (human or agent);
//   - `## Sessions`, a roster regenerated from the DB, so it is never stale;
//   - `## Updates`, an append-only log of what happened (deploys, PRDs, bugs…).
// Only markdown/file concerns live here; project_events.js decides what to log.
// ============================================================

import fs from 'fs';
import path from 'path';
import config from './config.js';

const SESSIONS_HEADING = '## Sessions';
const UPDATES_HEADING = '## Updates';

// A slug both names the file on disk and is the only user-supplied part of that
// path, so it is reduced to a safe, traversal-free token here.
export function slugify(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    return slug || 'project';
}

export function projectDocPath(slug) {
    return path.join(config.PROJECTS_DIR, `project_${slugify(slug)}.md`);
}

function oneLine(text, max = 140) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sessionLine(session) {
    const label = oneLine(session?.name || session?.task || 'Untitled');
    const status = session?.status ? ` _(${session.status})_` : '';
    return `- \`${session.id}\` — ${label}${status}`;
}

// IST, matching how the team reads every other timestamp in this product.
function stamp() {
    return new Date().toLocaleString('en-GB', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(',', '');
}

export function writeProjectDoc(project, { rootSession = null, creatorName = '', sessions = null } = {}) {
    const docPath = projectDocPath(project.slug);
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    const roster = sessions ?? (rootSession ? [rootSession] : []);
    const lines = [
        `# Project: ${project.name}`,
        '',
        project.description ? project.description : '_No description yet._',
        '',
        '## Context',
        '',
        `- **Project id:** \`${project.id}\``,
        `- **Created by:** ${creatorName || project.creator_name || 'unknown'}`,
        `- **Created:** ${stamp()}`,
    ];
    if (rootSession) {
        lines.push(`- **Root session:** \`${rootSession.id}\` — ${oneLine(rootSession.task, 200)}`);
        lines.push(`- **Working dir:** ${rootSession.working_dir || config.DEFAULT_WORKING_DIR}`);
    }
    lines.push(
        '',
        'This file is the shared reference point for the project. Read it before continuing',
        'the work, and keep it current — edit the sections above freely. The Sessions roster',
        'is maintained automatically; Updates below is an append-only log.',
        '',
        SESSIONS_HEADING,
        '',
        ...roster.map(sessionLine),
        '',
        UPDATES_HEADING,
        '',
    );
    fs.writeFileSync(docPath, lines.join('\n') + '\n', 'utf8');
    return docPath;
}

function ensureDoc(project) {
    const docPath = project.doc_path || projectDocPath(project.slug);
    if (!fs.existsSync(docPath)) writeProjectDoc(project, { creatorName: project.creator_name || '' });
    return docPath;
}

// Rewrites the `## Sessions` block from the DB so the roster (and each session's
// status) can never drift from reality. Everything else in the file is untouched.
export function syncProjectSessions(project, sessions = []) {
    const docPath = ensureDoc(project);
    const body = fs.readFileSync(docPath, 'utf8');
    const roster = sessions.length ? sessions.map(sessionLine).join('\n') : '_No sessions yet._';
    const block = `${SESSIONS_HEADING}\n\n${roster}\n`;

    const start = body.indexOf(SESSIONS_HEADING);
    if (start === -1) {
        // An older or hand-edited doc without the section — put it before Updates.
        const updatesAt = body.indexOf(UPDATES_HEADING);
        const next = updatesAt === -1 ? `${body.trimEnd()}\n\n${block}\n${UPDATES_HEADING}\n\n` : `${body.slice(0, updatesAt)}${block}\n${body.slice(updatesAt)}`;
        fs.writeFileSync(docPath, next, 'utf8');
        return docPath;
    }
    // The section runs until the next `## ` heading, or to the end of the file.
    const after = body.indexOf('\n## ', start + SESSIONS_HEADING.length);
    const tail = after === -1 ? '' : body.slice(after + 1);
    fs.writeFileSync(docPath, `${body.slice(0, start)}${block}${tail ? `\n${tail}` : ''}`, 'utf8');
    return docPath;
}

// Appends one dated line to `## Updates`, which is always the last section.
// Returns false when the same line is already the most recent entry — the same
// marker can reach us from more than one event, and the log should not stutter.
export function appendProjectUpdate(project, text) {
    const docPath = ensureDoc(project);
    const line = `- **${stamp()}** — ${oneLine(text, 400)}`;
    const body = fs.readFileSync(docPath, 'utf8');
    const lastEntry = body.trimEnd().split('\n').filter(l => l.startsWith('- **')).pop();
    if (lastEntry && lastEntry.slice(lastEntry.indexOf('** — ')) === line.slice(line.indexOf('** — '))) return false;
    const separator = body.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(docPath, `${separator}${line}\n`, 'utf8');
    return true;
}

export function readProjectDoc(project) {
    const docPath = project.doc_path || projectDocPath(project.slug);
    if (!fs.existsSync(docPath)) return { path: docPath, content: '' };
    return { path: docPath, content: fs.readFileSync(docPath, 'utf8') };
}

// The banner prepended to a session that belongs to one or more projects, so the
// agent knows which project it is in, where the context lives, and how to record
// anything the dashboard cannot observe by itself.
export function projectContextBanner(projects = []) {
    if (!projects.length) return '';
    const lines = ['# Project context'];
    for (const project of projects) {
        lines.push(`- **${project.name}** — context doc: \`${project.doc_path || projectDocPath(project.slug)}\``);
    }
    lines.push('');
    lines.push('This session belongs to the project(s) above. Read the context doc before starting.');
    lines.push('Deploys, PRDs, sprint moves and bugs are logged into it automatically. For anything');
    lines.push('else worth knowing later — a decision, a migration, a gotcha — print a line like');
    lines.push('`[[PROJECT: applied the quota migration to DEV]]` and it is appended to the doc.');
    lines.push('You may also edit the doc directly to correct or expand the context sections.');
    return lines.join('\n');
}
