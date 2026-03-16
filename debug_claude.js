// Debug script: runs Claude via PTY and logs ALL output including non-JSON lines
import pty from 'node-pty';

const proc = pty.spawn('/home/ubuntu/.local/bin/claude', [
    '--print',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    'say hello in one sentence'
], {
    name: 'xterm-color',
    cols: 200,
    rows: 50,
    cwd: '/home/ubuntu',
    env: process.env,
});

let allOutput = '';

proc.on('data', (raw) => {
    const text = raw.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    allOutput += text;
    process.stdout.write('[DATA] ' + JSON.stringify(text) + '\n');
});

proc.on('exit', (code) => {
    console.log('\n=== EXIT CODE:', code, '===');
    console.log('=== FULL RAW OUTPUT ===');
    console.log(allOutput);
});

setTimeout(() => {
    proc.kill();
    process.exit(1);
}, 60000);
