import config from './config.js';
import crypto from 'crypto';

export const CODE_REVIEWER_MODEL = 'codex:gpt-5.6-sol';
export const CODE_REVIEWER_NAME = 'Rivet';

export function hasSuccessfulUatDeploy(content) {
    return typeof content === 'string' && content.includes('[[UAT_DEPLOYED]]');
}

export function buildUatReviewTask(parentSessionId) {
    return `You are ${CODE_REVIEWER_NAME}, PluginLive's code reviewer. A successful UAT deployment was just reported by session ${parentSessionId}.

Review only the code that this parent session pushed to UAT. Use the inherited conversation to identify every affected repository, branch and commit, then inspect the actual git diff. If the deployment spans multiple repositories, review each one.

This is a READ-ONLY review. Do not edit files, commit, push, deploy, or run destructive commands.

Look specifically for:
- correctness bugs, regressions and missed edge cases
- security issues, authorization gaps, injection, secret or sensitive-data exposure
- unsafe database or deployment behavior
- API/frontend contract mismatches and backward-compatibility problems
- missing tests for risky behavior

Run safe, relevant checks when they materially improve confidence. Report findings ordered by severity, with file and line references, why each issue matters, and a concrete fix. Do not pad the review with style-only comments. If no actionable findings remain, say that clearly and list any residual test gaps or risks.`;
}

export class UatCodeReviewer {
    constructor({ store, engine, broadcast, logger = console }) {
        this.store = store;
        this.engine = engine;
        this.broadcast = broadcast;
        this.logger = logger;
        this.startedFor = new Set();
    }

    async start(parentSessionId, content) {
        if (!hasSuccessfulUatDeploy(content)) return null;
        const parent = this.store.getSession(parentSessionId);
        if (!parent || parent.mode === 'code_reviewer') return null;

        // One completed turn is normally emitted once, but provider recovery can
        // replay it. Deduplicate that replay while still reviewing a later UAT push
        // made from the same long-lived development session.
        const triggerId = `${parentSessionId}:${crypto.createHash('sha256').update(content).digest('hex')}`;
        if (this.startedFor.has(triggerId)) return null;
        this.startedFor.add(triggerId);
        try {
            const result = await this.engine.forkSession(
                parentSessionId,
                buildUatReviewTask(parentSessionId),
                String(parent.user_phone || parent.owner_id || 'uat-code-review'),
                parent.owner_id || null,
                CODE_REVIEWER_MODEL,
                { mode: 'code_reviewer', editAccess: false },
            );
            if (!result?.sessionId) throw new Error('reviewer did not return a session id');

            const name = `${CODE_REVIEWER_NAME} review: ${parent.name || parent.task || parentSessionId}`.slice(0, 120);
            this.store.updateSession(result.sessionId, {
                name,
                mode: 'code_reviewer',
                edit_access: 0,
                parent_session_id: parentSessionId,
                sprint_id: parent.sprint_id || null,
                type: 'review',
                labels: ['code-review', 'uat', CODE_REVIEWER_NAME.toLowerCase()],
            });
            this._notifyParent(parentSessionId, `🔎 **${CODE_REVIEWER_NAME}** started a GPT-5.6 Sol review of the UAT deployment. [Open review](${this._link(result.sessionId)})`);
            return result.sessionId;
        } catch (error) {
            this.startedFor.delete(triggerId);
            this.logger.error(`[${CODE_REVIEWER_NAME}] Failed to start UAT review for ${parentSessionId}:`, error);
            this._notifyParent(parentSessionId, `⚠️ **${CODE_REVIEWER_NAME}** could not start the UAT code review: ${error.message}`);
            return null;
        }
    }

    finished(sessionId, status) {
        const review = this.store.getSession(sessionId);
        if (review?.mode !== 'code_reviewer' || !review.parent_session_id) return;
        if (this.engine.isRunning?.(sessionId)) return;
        const outcome = status === 'failed' ? 'stopped with an error' : 'finished';
        this._notifyParent(review.parent_session_id, `🔎 **${CODE_REVIEWER_NAME}** ${outcome}. [Open review](${this._link(sessionId)})`);
    }

    _link(sessionId) {
        return `${config.PUBLIC_URL}${config.BASE_PATH}/s/${sessionId}`;
    }

    _notifyParent(sessionId, text) {
        this.store.addMessage(sessionId, 'system', text);
        this.broadcast('assistant_message', { sessionId, content: text });
    }
}
