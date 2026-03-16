import pty from 'node-pty';
const proc = pty.spawn('/home/ubuntu/.local/bin/claude', ['-p', 'Say hello', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], {
    name: 'xterm-color',
    cols: 200,
    rows: 50
});
let lastLine = '';
proc.on('data', (data) => {
    const text = data.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    lastLine += text;
    const lines = lastLine.split('\n');
    lastLine = lines.pop(); // keep last incomplete line
    for (const l of lines) {
        if (!l.trim()) continue;
        try {
            const j = JSON.parse(l.trim());
            if (j.type === 'result' || j.usage) {
                console.log(JSON.stringify(j, null, 2));
            }
        } catch(e) {}
    }
});
proc.on('exit', () => { setTimeout(()=>process.exit(0), 100); });
