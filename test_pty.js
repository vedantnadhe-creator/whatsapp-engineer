const pty = require('node-pty');
const config = require('./config.js');
const proc = pty.spawn(config.default.CLAUDE_BIN, ['--print', '--output-format', 'stream-json', '--dangerously-skip-permissions', 'say hello'], {
    name: 'xterm-color',
    cols: 200,
    rows: 30,
    cwd: process.cwd(),
    env: process.env
});
let lastOutput = '';
proc.on('data', d => {
    lastOutput += d.toString();
});
proc.on('exit', () => {
    console.log(lastOutput);
});
