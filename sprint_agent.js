// A narrow, auditable natural-language interface for Sprint Board mutations.
// It never executes generated SQL or filesystem commands from WhatsApp.
const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = value => String(value || '').trim().replace(/^['"`]|['"`]$/g, '').trim();

export default class SprintAgent {
    constructor(store, broadcast = null) { this.store = store; this.broadcast = broadcast; }
    _findOne(rows, query, fields) {
        const q = norm(query); if (!q) return null;
        const exact = rows.filter(r => fields.some(f => norm(r[f]) === q));
        if (exact.length === 1) return exact[0];
        const matched = rows.filter(r => fields.some(f => norm(r[f]).includes(q) || q.includes(norm(r[f]))));
        return matched.length === 1 ? matched[0] : null;
    }
    _sprint(name) { return this._findOne(this.store.getAllSprints(), name, ['name', 'id']); }
    _user(name) { return this._findOne(this.store.getAllUsers(), name, ['display_name', 'email', 'phone']); }
    _issue(title) { return this._findOne(this.store.getAllIssues(), title, ['title', 'id']); }
    _context() {
        const sprints = this.store.getAllSprints().filter(s => s.status !== 'completed');
        return sprints.map(s => `• ${s.name} — ${s.issue_count || 0} tasks (${s.status})`).join('\n') || 'No active or planning sprints.';
    }
    _help(prefix = '') { return `${prefix}*Sprint agent*\n${this._context()}\n\nTry:\n• add task Fix login to Sprint 36 and assign to Ravi\n• move Fix login to Sprint 37\n• assign Fix login to Ravi\n• mark Fix login done\n• sprint status`; }
    async handle({ text, phone, pushName }) {
        const raw = clean(text); const lower = raw.toLowerCase();
        if (!raw || /^(help|commands|sprints?|sprint status|status)$/i.test(raw)) return this._help();
        const actor = this.store.getUserByPhone(phone);
        const by = actor?.id || null;
        const add = raw.match(/^(?:add|create)\s+(?:(feature|epic|task|bug)\s+)?(.+?)\s+(?:to|in)\s+(?:the\s+)?sprint\s+(.+?)(?:\s+(?:and\s+)?assign(?:\s+to)?\s+(.+))?$/i);
        if (add) {
            const [, type = 'task', titleRaw, sprintRaw, assigneeRaw] = add;
            const sprint = this._sprint(sprintRaw); if (!sprint) return this._help(`I couldn't uniquely find sprint “${clean(sprintRaw)}”.\n\n`);
            const assignee = assigneeRaw ? this._user(assigneeRaw) : null;
            if (assigneeRaw && !assignee) return `I found ${sprint.name}, but couldn't uniquely find teammate “${clean(assigneeRaw)}”. Nothing was created.`;
            const issue = this.store.createIssue({ title: clean(titleRaw), sprintId: sprint.id, assignedTo: assignee?.id || null, type: type.toLowerCase(), createdBy: by });
            this.broadcast?.('issue_created', { issue });
            return `✅ Added *${issue.title}* to *${sprint.name}* as ${issue.type || 'task'}${assignee ? ` and assigned it to *${assignee.display_name}*` : ''}.\nID: ${issue.id}`;
        }
        const move = raw.match(/^move\s+(.+?)\s+(?:to|in)\s+(?:the\s+)?sprint\s+(.+)$/i);
        if (move) {
            const issue = this._issue(move[1]); const sprint = this._sprint(move[2]);
            if (!issue || !sprint) return this._help(`I couldn't uniquely find ${!issue ? `task “${clean(move[1])}”` : `sprint “${clean(move[2])}”`}.\n\n`);
            this.store.moveIssuesToSprint([issue.id], sprint.id); this.broadcast?.('issues_moved', { sprintId: sprint.id, issueIds: [issue.id] });
            return `✅ Moved *${issue.title}* to *${sprint.name}*.`;
        }
        const assign = raw.match(/^assign\s+(.+?)\s+(?:to)\s+(.+)$/i);
        if (assign) {
            const issue = this._issue(assign[1]); const user = this._user(assign[2]);
            if (!issue || !user) return this._help(`I couldn't uniquely find ${!issue ? `task “${clean(assign[1])}”` : `teammate “${clean(assign[2])}”`}.\n\n`);
            const updated = this.store.updateIssue(issue.id, { assigned_to: user.id }); this.broadcast?.('issue_updated', { issue: updated });
            return `✅ Assigned *${issue.title}* to *${user.display_name}*.`;
        }
        const status = raw.match(/^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(todo|to do|in progress|done|completed)$/i);
        if (status) {
            const issue = this._issue(status[1]); if (!issue) return this._help(`I couldn't uniquely find task “${clean(status[1])}”.\n\n`);
            const value = norm(status[2]); const done = value === 'done' || value === 'completed';
            const updated = this.store.updateIssue(issue.id, { status: done ? 'completed' : value === 'in progress' ? 'in_progress' : 'todo', dev_status: done ? 'done' : value === 'in progress' ? 'in_progress' : 'todo', ...(done ? { completed_at: new Date().toISOString(), dev_percent: 100 } : {}) });
            this.broadcast?.('issue_updated', { issue: updated }); return `✅ Marked *${issue.title}* ${done ? 'done' : value}.`;
        }
        return this._help(`I understood this as a sprint request, but it isn't an action I can safely apply yet.\n\n`);
    }
}
