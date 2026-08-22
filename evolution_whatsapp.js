// Evolution API transport.  It deliberately exposes the same small surface the
// rest of OliBot uses from the old Baileys bridge: `connect`, `sendMessage` and
// EventEmitter `message`/`ready` events.
import { EventEmitter } from 'events';
import config from './config.js';
import { findMedia } from './oli_media.js';

const cleanId = value => String(value || '').split(':')[0].split('@')[0].replace(/\D/g, '');
// Every JID tagged anywhere in a message. WhatsApp hangs `contextInfo` off whichever
// node carries the content (text, image, video, document...), so look at all of them
// rather than guessing which one this message happens to be.
const mentionedJids = node => (node && typeof node === 'object')
    ? Object.values(node).flatMap(v => (v && typeof v === 'object')
        ? (Array.isArray(v?.contextInfo?.mentionedJid) ? v.contextInfo.mentionedJid : []).concat(mentionedJids(v))
        : [])
        .concat(Array.isArray(node?.contextInfo?.mentionedJid) ? node.contextInfo.mentionedJid : [])
    : [];
const messageText = msg => msg?.conversation
    || msg?.extendedTextMessage?.text
    || msg?.imageMessage?.caption
    || msg?.videoMessage?.caption
    || msg?.documentMessage?.caption
    || msg?.documentWithCaptionMessage?.message?.documentMessage?.caption
    || '';

export default class EvolutionWhatsApp extends EventEmitter {
    constructor(store) {
        super();
        this.store = store;
        this.sock = null; // compatibility with existing dashboard/session delivery guards
        this.botNumber = cleanId(config.EVOLUTION_BOT_NUMBER);
        this._processed = new Set();
    }

    get enabled() { return Boolean(config.EVOLUTION_API_URL && config.EVOLUTION_INSTANCE); }
    _url(path) { return `${config.EVOLUTION_API_URL.replace(/\/$/, '')}${path}`; }
    _headers() { return { 'Content-Type': 'application/json', apikey: config.EVOLUTION_API_KEY }; }
    // A known teammate: full write access to the board. Numbers are managed in
    // Settings → allowed phones, seeded from ALLOWED_PHONES.
    // Groups still fail CLOSED on this — a tagged group message drives a Claude Code
    // session, and the sender must be a known teammate, not merely a member of some
    // group this number happens to be in. (The old `ALLOWED_PHONES.length === 0 ||`
    // short-circuit let anyone in — harmless for the previous five-verb regex agent,
    // not for a shell-capable session.) A DM from an unknown number is handled as a
    // guest instead of dropped when SPRINT_AGENT_OPEN_DMS is on; see handleWebhook.
    _allowed(phone) { return this.store.isPhoneAllowed(phone); }

    async _request(path, options = {}) {
        const response = await fetch(this._url(path), { ...options, headers: { ...this._headers(), ...(options.headers || {}) } });
        const text = await response.text();
        let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!response.ok) throw new Error(`Evolution API ${response.status}: ${data?.message || data?.error || text || 'request failed'}`);
        return data;
    }

    async connect() {
        if (!this.enabled) throw new Error('Evolution is not configured: set EVOLUTION_API_URL and EVOLUTION_INSTANCE');
        let state;
        try {
            state = await this._request(`/instance/connectionState/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`, { method: 'GET' });
        } catch (err) {
            // First boot: create the named Baileys instance so the admin QR button
            // works without a separate Evolution dashboard setup step.
            if (!String(err.message).includes('Evolution API 404')) throw err;
            await this._request('/instance/create', {
                method: 'POST',
                body: JSON.stringify({ instanceName: config.EVOLUTION_INSTANCE, number: this.botNumber || undefined, qrcode: true, integration: 'WHATSAPP-BAILEYS', groupsIgnore: false }),
            });
            state = await this._request(`/instance/connectionState/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`, { method: 'GET' });
        }
        const instance = state?.instance || state;
        this.botNumber = cleanId(instance?.owner || instance?.ownerJid || instance?.number || this.botNumber);
        this.sock = { connected: String(instance?.state || instance?.connectionStatus || '').toLowerCase() === 'open' };
        console.log(`[Evolution] Instance ${config.EVOLUTION_INSTANCE}: ${instance?.state || instance?.connectionStatus || 'unknown'}${this.botNumber ? ` (${this.botNumber})` : ''}`);
        if (config.EVOLUTION_WEBHOOK_URL) {
            // Evolution v2 wants the settings nested under `webhook` (a flat body is a 400),
            // and `byEvents` must stay false: it would append `/messages-upsert` to the URL,
            // landing after our `?secret=` query string and failing the secret check.
            await this._request(`/webhook/set/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`, {
                method: 'POST',
                body: JSON.stringify({ webhook: { enabled: true, url: config.EVOLUTION_WEBHOOK_URL, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] } }),
            });
            console.log('[Evolution] MESSAGES_UPSERT webhook registered.');
        }
        if (this.sock.connected) this.emit('ready');
        return state;
    }

    // Evolution returns a base64 data URL (or raw QR string depending on version).
    async getQr() {
        if (!this.enabled) throw new Error('Evolution is not configured');
        const data = await this._request(`/instance/connect/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`, { method: 'GET' });
        return {
            qr: data?.base64 || data?.qrcode?.base64 || data?.code || data?.qrcode || null,
            pairingCode: data?.pairingCode || data?.code?.pairingCode || null,
        };
    }

    async sendMessage(destination, text) {
        if (!this.enabled) throw new Error('Evolution is not configured');
        // A group JID must remain intact; direct recipients are normalised to digits.
        const number = String(destination || '').endsWith('@g.us') ? String(destination) : cleanId(destination);
        if (!number) throw new Error('No WhatsApp destination');
        return this._request(`/message/sendText/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`, {
            method: 'POST', body: JSON.stringify({ number, text: String(text || '') }),
        });
    }

    handleWebhook(payload) {
        const event = String(payload?.event || payload?.type || '').toLowerCase();
        if (event && !event.includes('message')) return;
        // Evolution stamps every event with `sender` = the instance's own JID. Trust it
        // over the boot-time snapshot so re-pairing to a different number takes effect
        // without a restart (and mention matching never silently breaks).
        const owner = cleanId(payload?.sender);
        if (owner) this.botNumber = owner;
        const data = payload?.data || payload;
        const key = data?.key || {};
        if (key.fromMe) return;
        const id = key.id || data?.messageId;
        if (id && this._processed.has(id)) return;
        if (id) { this._processed.add(id); setTimeout(() => this._processed.delete(id), 5 * 60_000); }
        const jid = key.remoteJid || data?.remoteJid || data?.chatId || '';
        const isGroup = jid.endsWith('@g.us');
        // Personal chat is the product: a DM from a known teammate IS the request, no tag.
        // Groups stay off unless SPRINT_AGENT_GROUPS is on, and there a tag is still required
        // so the bot never answers ordinary group chatter.
        if (isGroup && !config.SPRINT_AGENT_GROUPS) return;
        if (isGroup && config.ALLOWED_GROUPS.length && !config.ALLOWED_GROUPS.includes(jid)) return;
        const msg = data?.message || data;
        const text = messageText(msg).trim();
        if (isGroup) {
            // The tag can ride on any message node, not just a text one: "@oli file this as
            // a bug" attached to a screenshot puts `mentionedJid` under `imageMessage`, so
            // reading only `extendedTextMessage` silently ignored every tagged screenshot —
            // which is the main way a bug gets reported in a group.
            const mentioned = mentionedJids(msg).concat(mentionedJids(data));
            // Do not treat a plain word/name as a mention: groups are tag-only by design.
            if (!(this.botNumber && mentioned.some(j => cleanId(j) === this.botNumber))) return;
        }
        // WhatsApp now addresses most chats by `@lid` — a linked-identity id that is NOT a
        // phone number — and carries the real number alongside in `*Alt`/`*Pn`. Read those
        // first: a bare `@lid` fails the allowed-phones gate for every teammate, and is not
        // a number we could reply to either. In a DM the chat itself is the sender
        // (`payload.sender` is our own number, never theirs).
        const senderJid = isGroup
            ? (key.participantAlt || key.participantPn || key.participant || data?.participant || '')
            : (key.remoteJidAlt || key.senderPn || jid);
        const sender = cleanId(senderJid);
        if (!sender || senderJid.endsWith('@lid')) {
            if (senderJid) console.warn(`[Evolution] Ignored sprint message from ${senderJid} — no phone number in the payload.`);
            return;
        }
        // A teammate drives the board; anyone else is a guest who may only read it.
        // Guests exist only in personal chats and only when open DMs are switched on —
        // groups stay allow-list only. Log the drop either way: "the bot ignored me" is
        // otherwise indistinguishable from a broken webhook.
        // An explicitly allow-listed group is itself the trust boundary: its members are
        // the team, and requiring every one of them to also be in allowed_phones would
        // mean "@oli file this bug" silently doing nothing for most of the group. With
        // ALLOWED_GROUPS empty, any group Oli happens to be added to would qualify, so
        // there the sender must still be a known number.
        const trusted = this._allowed(sender) || (isGroup && config.ALLOWED_GROUPS.includes(jid));
        if (!trusted && (isGroup || !config.SPRINT_AGENT_OPEN_DMS)) {
            console.warn(`[Evolution] Ignored sprint message from ${sender} — not in the allowed phones list${isGroup ? ' (group)' : ' (open DMs are off)'}.`);
            return;
        }
        // A screenshot or screen recording, either attached here or on the message this
        // one replies to. Only the reference travels — the bytes are fetched and stored
        // later, where the board token lives.
        const media = findMedia(data);
        const command = (isGroup ? text.replace(/@\S+/g, '') : text).trim();
        // A bare image with no caption is not a request. In a group the tag is the
        // request, so "@oli" plus a screenshot is allowed through with empty text.
        if (!command && !(media && isGroup)) return;
        this.emit('message', {
            phone: sender, text: command || '(no text — see the attached media)',
            pushName: data?.pushName || data?.pushname || (isGroup ? 'Group member' : 'Teammate'),
            // Reply to the group JID, or to the teammate's *number* — never the `@lid`.
            groupJid: isGroup ? jid : null, chatJid: isGroup ? jid : sender, raw: payload, sprintCommand: true,
            trusted, media,
        });
    }
}
