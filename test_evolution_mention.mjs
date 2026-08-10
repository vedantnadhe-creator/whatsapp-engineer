// Runnable check for the sprint agent trigger:
//   node test_evolution_mention.mjs
// Covers the things that silently break it — personal-chat scope, who the sender is
// in a DM vs a group, the allowed-phones gate, groups being off, and fromMe echoes.
import assert from 'assert';
import config from './config.js';
import EvolutionWhatsApp from './evolution_whatsapp.js';

const BOT = '919970870091';
const GROUP = '120363000000000000@g.us';
const MATE = '919999999999';
const ALLOWED = new Set([MATE]);
const wa = new EvolutionWhatsApp({ isPhoneAllowed: phone => ALLOWED.has(String(phone)) });

const upsert = ({ text, mentions = [], jid = `${MATE}@s.whatsapp.net`, fromMe = false, sender = `${BOT}@s.whatsapp.net`, participant = `${MATE}@s.whatsapp.net`, id }) => ({
    event: 'messages.upsert',
    instance: 'olibot-sprint',
    sender,
    data: {
        key: { remoteJid: jid, fromMe, id, participant },
        pushName: 'Tester',
        message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions } } },
    },
});

const captured = [];
wa.on('message', m => captured.push(m));

// 1. A personal chat from a known teammate is a sprint request as-is — no tag needed —
//    and the bot number is still learned from `sender` without calling connect().
wa.handleWebhook(upsert({ id: 'A', text: 'what are all the bugs in sprint 37' }));
assert.strictEqual(captured.length, 1, 'a DM from an allowed teammate should trigger');
assert.strictEqual(captured[0].text, 'what are all the bugs in sprint 37');
assert.strictEqual(captured[0].phone, MATE, 'in a DM the chat JID is the sender');
assert.strictEqual(captured[0].groupJid, null);
assert.strictEqual(captured[0].chatJid, MATE, 'the reply must go back to that chat');
assert.strictEqual(wa.botNumber, BOT, 'botNumber should be learned from payload.sender');

// 2. A DM from a stranger is dropped: the session it would drive has shell access, so
//    having the number is not authorisation.
wa.handleWebhook(upsert({ id: 'B', text: 'delete everything in sprint 37', jid: '918888800000@s.whatsapp.net' }));
assert.strictEqual(captured.length, 1, 'a sender outside the allowed list must be ignored');

// 3. Groups are off by default — even a correct @mention from an allowed teammate.
assert.strictEqual(config.SPRINT_AGENT_GROUPS, false, 'groups must stay off unless SPRINT_AGENT_GROUPS is set');
wa.handleWebhook(upsert({ id: 'C', text: `@${BOT} sprint status`, mentions: [`${BOT}@s.whatsapp.net`], jid: GROUP }));
assert.strictEqual(captured.length, 1, 'group mentions must be ignored while groups are off');

// 4. Our own echoed message must not loop back.
wa.handleWebhook(upsert({ id: 'D', text: 'sprint status', fromMe: true }));
assert.strictEqual(captured.length, 1, 'fromMe must be suppressed');

// 5. Duplicate delivery of the same message id is de-duplicated.
wa.handleWebhook(upsert({ id: 'A', text: 'sprint status' }));
assert.strictEqual(captured.length, 1, 'repeated message id must be dropped');

// 6. An empty body (a sticker, or a bare tag) is not a request.
wa.handleWebhook(upsert({ id: 'E', text: '   ' }));
assert.strictEqual(captured.length, 1, 'empty text must not start a turn');

// 7. Real WhatsApp traffic is `@lid`-addressed: the chat/participant id is a linked
//    identity, and the phone only appears in remoteJidAlt/participantAlt. Reading the
//    `@lid` instead would fail the allowed-phones gate for every teammate.
wa.handleWebhook({
    event: 'messages.upsert', sender: `${BOT}@s.whatsapp.net`,
    data: {
        key: { remoteJid: '141356097925155@lid', fromMe: false, id: 'H', participant: '', remoteJidAlt: `${MATE}@s.whatsapp.net`, addressingMode: 'lid' },
        pushName: 'Tester', message: { conversation: 'sprint status' },
    },
});
assert.strictEqual(captured.length, 2, 'a lid-addressed DM should resolve to the real number');
assert.strictEqual(captured[1].phone, MATE);
assert.strictEqual(captured[1].chatJid, MATE, 'replies must go to the number, not the @lid');

// 8. A lid with no phone alongside is dropped rather than treated as a phone number.
wa.handleWebhook({
    event: 'messages.upsert', sender: `${BOT}@s.whatsapp.net`,
    data: {
        key: { remoteJid: '141356097925155@lid', fromMe: false, id: 'I', addressingMode: 'lid' },
        pushName: 'Tester', message: { conversation: 'sprint status' },
    },
});
assert.strictEqual(captured.length, 2, 'an unresolvable @lid must not be treated as a phone');

// 9. With groups switched on, a tag is still required and the sender is the participant,
//    never the group JID.
config.SPRINT_AGENT_GROUPS = true;
wa.handleWebhook(upsert({ id: 'F', text: 'sprint status', jid: GROUP }));
assert.strictEqual(captured.length, 2, 'untagged group chatter must stay ignored');
wa.handleWebhook({
    event: 'messages.upsert', sender: `${BOT}@s.whatsapp.net`,
    data: {
        key: { remoteJid: GROUP, fromMe: false, id: 'J', participant: '161924713029855@lid', participantAlt: `${MATE}@s.whatsapp.net`, addressingMode: 'lid' },
        pushName: 'Tester',
        message: { extendedTextMessage: { text: `@${BOT} sprint status`, contextInfo: { mentionedJid: [`${BOT}@s.whatsapp.net`] } } },
    },
});
assert.strictEqual(captured.length, 3, 'a tagged group message should trigger once groups are on');
assert.strictEqual(captured[2].text, 'sprint status', 'the tag is stripped from the command');
assert.strictEqual(captured[2].phone, MATE, 'the group sender resolves through participantAlt');
assert.strictEqual(captured[2].chatJid, GROUP, 'the group reply goes to the group');
config.SPRINT_AGENT_GROUPS = false;

console.log('OK — 9 Evolution sprint-trigger checks passed');
process.exit(0);
