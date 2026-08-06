// ============================================================
// sprint_mailer.js — Daily/manual sprint status email to stakeholders
// ============================================================
// Reuses the same SMTP transporter setup as auth.js (welcome emails).
// Recipients + last-sent timestamps are stored as settings via store,
// so the list can be edited from Settings without a code change.

import nodemailer from 'nodemailer';
import config from './config.js';

let _transporter = null;
function getTransporter() {
    if (_transporter) return _transporter;
    _transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
    return _transporter;
}

const FROM = `"OliBot Sprint Status" <${config.SMTP_USER}>`;

const DEV_STATUS = {
    todo: { label: 'To Do', color: '#94a3b8' },
    in_progress: { label: 'In Progress', color: '#f59e0b' },
    dev_completed: { label: 'Dev Completed', color: '#3b82f6' },
    done: { label: 'Done', color: '#22c55e' },
};

// Same lifecycle logic as SessionStore.featureCompletion() / SprintBoard.jsx's featureCompletion —
// keep all three in sync if this changes.
function featureCompletion(issue) {
    const open = issue.open_bugs || 0;
    const qa = String(issue.qa_status || '').toLowerCase();
    if (open > 0) {
        if (issue.dev_status === 'todo') return 0;
        return (issue.critical_bugs || 0) > 0 ? 40 : 50;
    }
    if (qa === 'pass' || qa === 'passed' || qa === 'tested') return 100;
    if (issue.dev_status === 'done') return 100;
    if (issue.dev_status === 'dev_completed') return 70;
    return 0;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function buildSprintStatusEmail(sprint, progress, issues, { trigger = 'scheduled', triggeredBy = null } = {}) {
    const subject = `Sprint Status — ${sprint.name} — ${progress.percent}% complete (${progress.done}/${progress.total} done)`;
    const rows = issues.map(i => {
        const meta = DEV_STATUS[i.dev_status] || DEV_STATUS.todo;
        const pct = featureCompletion(i);
        const bugNote = i.open_bugs ? ` · ${i.open_bugs} open bug${i.open_bugs > 1 ? 's' : ''}${i.critical_bugs ? ` (${i.critical_bugs} critical)` : ''}` : '';
        return `<tr>
            <td style="padding:8px 10px;border-bottom:1px solid #eceef5;font-size:13px;color:#333;">${esc(i.title)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eceef5;font-size:12px;white-space:nowrap;"><span style="color:${meta.color};font-weight:600;">${meta.label}</span></td>
            <td style="padding:8px 10px;border-bottom:1px solid #eceef5;font-size:12px;color:#888;">${esc(i.assignee_name || '—')}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eceef5;font-size:12px;color:#333;text-align:right;">${pct}%${bugNote}</td>
        </tr>`;
    }).join('');

    const footer = trigger === 'manual'
        ? `Sent manually${triggeredBy ? ` by ${esc(triggeredBy)}` : ''} from the OliBot Sprint Board.`
        : `Sent automatically every day at 6:00 AM IST from the OliBot Sprint Board.`;

    const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;background:#f9f9fb;border-radius:12px;">
        <h1 style="color:#3249d7;font-size:20px;margin:0 0 4px;">Sprint Status</h1>
        <p style="color:#555;margin:0 0 24px;font-size:14px;">${esc(sprint.name)}${sprint.end_date ? ` · ends ${esc(String(sprint.end_date).slice(0, 10))}` : ''}</p>

        <div style="background:#fff;border-radius:10px;padding:20px;border:1px solid #e8eaf6;margin-bottom:16px;">
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tr>
                <td style="font-size:28px;font-weight:700;color:#3249d7;">${progress.percent}%</td>
                <td style="font-size:12px;color:#888;text-align:right;">${progress.done} done · ${progress.inProgress} in progress · ${progress.todo} to do · ${progress.total} total</td>
            </tr></table>
            <div style="background:#eceef5;border-radius:6px;height:8px;overflow:hidden;">
                <div style="background:#3249d7;height:8px;width:${progress.percent}%;"></div>
            </div>
            ${(progress.openBugs || progress.criticalBugs) ? `<p style="margin:12px 0 0;font-size:12px;color:#e53935;">${progress.openBugs} open bug${progress.openBugs === 1 ? '' : 's'}${progress.criticalBugs ? ` (${progress.criticalBugs} critical)` : ''}</p>` : ''}
        </div>

        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e8eaf6;">
            <thead>
                <tr style="background:#f0f3ff;">
                    <th style="padding:8px 10px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;">Feature</th>
                    <th style="padding:8px 10px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;">Status</th>
                    <th style="padding:8px 10px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;">Owner</th>
                    <th style="padding:8px 10px;text-align:right;font-size:11px;color:#888;text-transform:uppercase;">Complete</th>
                </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="4" style="padding:16px;text-align:center;font-size:13px;color:#888;">No features in this sprint yet.</td></tr>`}</tbody>
        </table>

        <p style="color:#aaa;font-size:11px;margin:20px 0 0;">${footer}</p>
    </div>`;

    const text = `Sprint Status — ${sprint.name}\n${progress.percent}% complete (${progress.done}/${progress.total} done, ${progress.inProgress} in progress, ${progress.todo} to do)\n` +
        (progress.openBugs ? `${progress.openBugs} open bugs (${progress.criticalBugs} critical)\n` : '') +
        `\n` + issues.map(i => `- ${i.title} [${(DEV_STATUS[i.dev_status] || DEV_STATUS.todo).label}] ${featureCompletion(i)}%`).join('\n') +
        `\n\n${footer}`;

    return { subject, html, text };
}

export async function sendSprintStatusEmail(sprint, progress, issues, recipients, opts = {}) {
    if (!recipients?.length) throw new Error('No recipients configured for sprint status emails');
    const { subject, html, text } = buildSprintStatusEmail(sprint, progress, issues, opts);
    await getTransporter().sendMail({ from: FROM, to: recipients.join(','), subject, html, text });
    return { subject, recipients };
}
