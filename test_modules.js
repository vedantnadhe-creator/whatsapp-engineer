// Quick smoke test — verifies all modules load without errors
try {
    console.log('Testing config...');
    const { default: config } = await import('./config.js');
    console.log('  Claude:', config.CLAUDE_BIN);
    console.log('  Model:', config.GEMINI_MODEL);

    console.log('Testing session_store...');
    const { default: SessionStore } = await import('./session_store.js');
    const store = new SessionStore();
    console.log('  SQLite OK');

    console.log('Testing orchestrator...');
    const { default: Orchestrator } = await import('./orchestrator.js');
    console.log('  Loaded OK');

    console.log('Testing whatsapp...');
    const { default: WhatsApp } = await import('./whatsapp.js');
    console.log('  Loaded OK');

    console.log('Testing claude_manager...');
    const { default: Claude } = await import('./claude_manager.js');
    console.log('  Loaded OK');

    console.log('\n✅ ALL MODULES OK');
    process.exit(0);
} catch (e) {
    console.error('❌ ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
}
