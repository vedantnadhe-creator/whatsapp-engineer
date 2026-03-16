import pty from 'node-pty';
try {
  const proc = pty.spawn('echo', ['1'], { cols: 1000000, rows: 30 });
  console.log('SUCCESS');
  proc.kill();
} catch (e) {
  console.log('ERROR', e.message);
}
