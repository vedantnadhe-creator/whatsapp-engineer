fetch('http://localhost:18790/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '919970870091', text: 'hello from script' })
}).then(res => res.json()).then(console.log).catch(console.error);
