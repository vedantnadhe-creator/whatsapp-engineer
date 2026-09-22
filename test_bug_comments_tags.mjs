// Bug comment thread + tag catalogue on the sprint board's store.
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-bugc-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const { default: SessionStore } = await import('./session_store.js');
const store = new SessionStore();

const a = store.createIssue({ title: 'A', labels: ['hotfix', 'ui'] });
const b = store.createIssue({ title: 'B', labels: ['UI'] });
store.createIssue({ title: 'C' });
assert.deepEqual(store.getIssueLabels(), ['hotfix', 'ui', 'UI'], 'catalogue = distinct tags across issues, case-insensitive order');
store.updateIssue(a.id, { labels: ['backend'] });
assert.deepEqual(store.getIssueLabels(), ['backend', 'UI'], 'a tag with no rows left leaves the catalogue');

const bug = store.createBug({ issueId: b.id, title: 'broken' });
assert.equal(store.getBugsByIssue(b.id)[0].comment_count, 0);
const c1 = store.addBugComment({ bugId: bug.id, body: 'cannot reproduce on UAT' });
const c2 = store.addBugComment({ bugId: bug.id, body: 'fixed in abc123' });
assert.deepEqual(store.getBugComments(bug.id).map(c => c.body), ['cannot reproduce on UAT', 'fixed in abc123'], 'oldest first');
assert.equal(store.getBugsByIssue(b.id)[0].comment_count, 2);
store.deleteBugComment(c1.id);
assert.deepEqual(store.getBugComments(bug.id).map(c => c.id), [c2.id]);
assert.equal(store.getBugsByIssue(b.id)[0].comment_count, 1);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Bug comments + tags tests passed');
