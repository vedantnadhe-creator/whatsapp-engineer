import { spawn } from 'child_process';
const proc = spawn('/home/ubuntu/.npm-global/bin/claude', ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', 'hello']);
proc.stdout.on('data', d => console.log('OUT:', d.toString()));
proc.stderr.on('data', d => console.log('ERR:', d.toString()));
