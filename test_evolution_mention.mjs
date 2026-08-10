// Runnable check for the tag-only sprint agent trigger:
//   node test_evolution_mention.mjs
// Covers the three things that silently break it — mention matching against the
// currently paired number, group-only scope, and fromMe suppression.
import assert from 'assert';
import EvolutionWhatsApp from './evolution_whatsapp.js';

const BOT = '919970870091';
const GROUP = '120363000000000000@g.us';
const ALLOWED = new Set(['919999999999']);
const wa = new EvolutionWhatsApp({ isPhoneAllowed: phone => ALLOWED.has(String(phone)) });

const upsert = ({ text, mentions = [], jid = GROUP, fromMe = false, sender = `${BOT}@s.whatsapp.net`, id }) => ({
    event: 'messages.upsert',
    instance: 'olibot-sprint',
    sender,
    data: {
        key: { remoteJid: jid, fromMe, id, participant: '919999999999@s.whatsapp.net' },
        pushName: 'Tester',
        message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions } } },
    },
});

const captured = [];
wa.on('message', m => captured.push(m));

// 1. Tagged in a group → command fires, and the bot number is learned from `sender`
//    even though nothing called connect().
wa.handleWebhook(upsert({ id: 'A', text: `@${BOT} add task Fix login to Sprint 36`, mentions: [`${BOT}@s.whatsapp.net`] }));
assert.strictEqual(captured.length, 1, 'tagged group message should trigger');
assert.strictEqual(captured[0].text, 'add task Fix login to Sprint 36');
assert.strictEqual(captured[0].groupJid, GROUP);
assert.strictEqual(captured[0].sprintCommand, true);
assert.strictEqual(wa.botNumber, BOT, 'botNumber should be learned from payload.sender');

// 2. Untagged group chatter is ignored.
wa.handleWebhook(upsert({ id: 'B', text: 'add task Fix login to Sprint 36' }));
assert.strictEqual(captured.length, 1, 'untagged group message must be ignored');

// 3. Someone else tagged — not us.
wa.handleWebhook(upsert({ id: 'C', text: '@918888888888 add task X', mentions: ['918888888888@s.whatsapp.net'] }));
assert.strictEqual(captured.length, 1, 'mention of another number must be ignored');

// 4. Direct message, even tagged, is out of scope (group-only by design).
wa.handleWebhook(upsert({ id: 'D', text: `@${BOT} sprint status`, mentions: [`${BOT}@s.whatsapp.net`], jid: '919999999999@s.whatsapp.net' }));
assert.strictEqual(captured.length, 1, 'DMs must not trigger the sprint agent');

// 5. Our own echoed message must not loop back.
wa.handleWebhook(upsert({ id: 'E', text: `@${BOT} sprint status`, mentions: [`${BOT}@s.whatsapp.net`], fromMe: true }));
assert.strictEqual(captured.length, 1, 'fromMe must be suppressed');

// 6. Duplicate delivery of the same message id is de-duplicated.
wa.handleWebhook(upsert({ id: 'A', text: `@${BOT} sprint status`, mentions: [`${BOT}@s.whatsapp.net`] }));
assert.strictEqual(captured.length, 1, 'repeated message id must be dropped');

// 7. A tagged message from someone who is NOT an allowed teammate is dropped: the
// session it would drive has shell access, so group membership is not authorisation.
wa.handleWebhook({
    event: 'messages.upsert', sender: `${BOT}@s.whatsapp.net`,
    data: {
        key: { remoteJid: GROUP, fromMe: false, id: 'F', participant: '918888800000@s.whatsapp.net' },
        pushName: 'Stranger',
        message: { extendedTextMessage: { text: `@${BOT} delete everything in Sprint 37`, contextInfo: { mentionedJid: [`${BOT}@s.whatsapp.net`] } } },
    },
});
assert.strictEqual(captured.length, 1, 'a sender outside the allowed list must be ignored');

console.log('OK — 7 Evolution mention checks passed');
