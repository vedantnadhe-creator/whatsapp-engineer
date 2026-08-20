// Guards multi-file attachments: a composer (chat input or fork dialog) can stage
// several images, and every one has to reach the agent — Claude via the file notes
// in the prompt, Codex via one --image flag each.
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-attach-'));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const shot1 = path.join(tmp, 'shot1.png');
const shot2 = path.join(tmp, 'shot2.png');
const notes = path.join(tmp, 'notes.pdf');
[shot1, shot2, notes].forEach((f) => fs.writeFileSync(f, 'x'));

const { default: ClaudeManager } = await import('./claude_manager.js');
const { buildCodexArgs } = await import('./codex_models.js');

let failed = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const mgr = new ClaudeManager({});
const prep = (files) => mgr._prepareFile(files, work);

check('no attachment → no file block', prep(null), null);
check('a single path still works (unchanged callers)', prep(shot1).split('\n').length, 1);

const many = prep([shot1, shot2, notes]);
check('every attachment gets its own note', many.split('\n').length, 3);
check('images are announced as images', (many.match(/Image attached/g) || []).length, 2);
check('non-images are announced as files', (many.match(/File attached \(notes\.pdf\)/g) || []).length, 1);
// The agent reads the copies, so a second file must not overwrite the first.
const copied = fs.readdirSync(work).filter((f) => f.startsWith('context-file-'));
check('each attachment is copied under a distinct name', copied.length, 4);

check('a missing path is skipped, not fatal', prep([shot1, '/nope/gone.png']).split('\n').length, 1);
check('only missing paths → no file block', prep(['/nope/gone.png']), null);

// `--image <FILE>...` is variadic: `--image a b` would swallow the prompt, so the
// flag has to repeat.
const args = buildCodexArgs({ model: 'gpt-5', prompt: 'do the thing', workingDir: work, imagePath: [shot1, shot2] });
check('one --image flag per attachment', args.filter((a) => a === '--image').length, 2);
check('the prompt stays the last positional', args[args.length - 1], 'do the thing');
check('no attachment → no --image', buildCodexArgs({ model: 'gpt-5', prompt: 'p', workingDir: work }).includes('--image'), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
