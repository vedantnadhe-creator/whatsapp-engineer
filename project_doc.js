// ============================================================
// project_doc.js — the on-disk context doc for a project.
//
// Every project owns one markdown file, `project_<slug>.md`, that acts as its
// reference point: what the project is, which session started it, and a running
// log of every session filed into it (including forks, which join automatically).
// Sessions in the project are told where this file is, so an agent can read it for
// context and keep it current.
// ============================================================

import fs from 'fs';
import path from 'path';
import config from './config.js';

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

function sessionLine(session) {
    const label = session?.name || session?.task || 'Untitled';
    const oneLine = String(label).replace(/\s+/g, ' ').trim().slice(0, 140);
    return `- \`${session.id}\` — ${oneLine}`;
}

// Creates the doc. `## Sessions` is deliberately the last section so new sessions
// can be appended without re-parsing the file (agents are free to edit the rest).
export function writeProjectDoc(project, { rootSession = null, creatorName = '' } = {}) {
    const docPath = projectDocPath(project.slug);
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    const lines = [
        `# Project: ${project.name}`,
        '',
        project.description ? project.description : '_No description yet._',
        '',
        '## Context',
        '',
        `- **Project id:** \`${project.id}\``,
        `- **Created by:** ${creatorName || 'unknown'}`,
        `- **Created:** ${new Date().toISOString().slice(0, 10)}`,
    ];
    if (rootSession) {
        lines.push(`- **Root session:** \`${rootSession.id}\` — ${String(rootSession.task || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        lines.push(`- **Working dir:** ${rootSession.working_dir || config.DEFAULT_WORKING_DIR}`);
    }
    lines.push(
        '',
        'This file is the shared reference point for the project. Every session below is',
        'part of it — read this file for context before continuing the work, and update it',
        'when something changes that the next session would need to know.',
        '',
        '## Sessions',
        '',
    );
    if (rootSession) lines.push(sessionLine(rootSession));
    fs.writeFileSync(docPath, lines.join('\n') + '\n', 'utf8');
    return docPath;
}

// Appends one session to the doc's session log. Recreates the doc first if it was
// deleted or was never written (a project should never lose its reference point).
export function appendProjectSession(project, session) {
    const docPath = project.doc_path || projectDocPath(project.slug);
    if (!fs.existsSync(docPath)) writeProjectDoc(project, { creatorName: project.creator_name || '' });
    fs.appendFileSync(docPath, `${sessionLine(session)}\n`, 'utf8');
    return docPath;
}

export function readProjectDoc(project) {
    const docPath = project.doc_path || projectDocPath(project.slug);
    if (!fs.existsSync(docPath)) return { path: docPath, content: '' };
    return { path: docPath, content: fs.readFileSync(docPath, 'utf8') };
}

// The banner prepended to a session that belongs to one or more projects, so the
// agent knows which project it is working inside and where the context lives.
export function projectContextBanner(projects = []) {
    if (!projects.length) return '';
    const lines = ['# Project context'];
    for (const project of projects) {
        lines.push(`- **${project.name}** — context doc: \`${project.doc_path || projectDocPath(project.slug)}\``);
    }
    lines.push('');
    lines.push('This session belongs to the project(s) above. Read the context doc before starting,');
    lines.push('and append anything the next session in the project would need to know.');
    return lines.join('\n');
}
