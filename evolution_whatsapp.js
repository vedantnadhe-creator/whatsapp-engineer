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
const mentionedJids = node => [...new Set(collectMentions(node))];
const collectMentions = node => (node && typeof node === 'object')
    ? Object.values(node).flatMap(v => (v && typeof v === 'object')
        ? (Array.isArray(v?.contextInfo?.mentionedJid) ? v.contextInfo.mentionedJid : []).concat(collectMentions(v))
        : [])
        .concat(Array.isArray(node?.contextInfo?.mentionedJid) ? node.contextInfo.mentionedJid : [])
    : [];
// Learned bot lids survive restarts here — a group Oli has spoken in once keeps working.
const LID_SETTING = 'evolution_bot_lids';
const escapeRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        // Configured lids plus any this instance has already learned about itself.
        this._botLids = new Set(config.EVOLUTION_BOT_LIDS);
        try { JSON.parse(this.store.getSetting(LID_SETTING) || '[]').forEach(l => this._botLids.add(l)); }
        catch (_) { /* corrupt setting is not worth failing a boot over */ }
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

    /**
     * Is this group message addressed to Oli? Groups stay tag-only, but "tagged" has to
     * mean more than one field: WhatsApp puts a tag in `mentionedJid`, and in @lid-addressed
     * groups that array can carry linked-identity ids rather than the bot's number, so the
     * bot would never recognise its own tag. Also accept the tag as it appears in the text —
     * `@<number>`, or `@` plus a configured alias, which is what people actually type.
     * Still a tag: a bare mention of the name in a sentence does not count.
     */
    _tagged(msg, data, text) {
        const mentioned = [...new Set(mentionedJids(msg).concat(mentionedJids(data)).map(cleanId))];
        const ids = new Set([...this._botLids, this.botNumber].filter(Boolean));
        if (mentioned.some(j => ids.has(j))) return true;
        // The tag as it is written in the message body: `@<number>` in a phone-addressed
        // group, `@<lid>` in a linked-identity one.
        if ([...ids].some(id => text.includes(`@${id}`))) return true;
        return config.BOT_ALIASES.some(alias => new RegExp(`(^|\\s)@${escapeRe(alias)}\\b`, 'i').test(text));
    }

    /**
     * Remember a linked identity that belongs to us. Called with the `participant` of a
     * group message we sent ourselves, which is the only place WhatsApp reveals it — the
     * Evolution API has no endpoint for the instance's own lid. Once learned, tags in that
     * group are recognised for good, so a new deployment self-configures after Oli's first
     * reply rather than needing EVOLUTION_BOT_LID set by hand.
     */
    _learnBotLid(lid) {
        const id = cleanId(lid);
        if (!id || this._botLids.has(id)) return;
        this._botLids.add(id);
        try {
            this.store.setSetting(LID_SETTING, JSON.stringify([...this._botLids]));
            console.log(`[Evolution] Learned own linked identity ${id} — group tags using it will now be recognised.`);
        } catch (err) { console.error(`[Evolution] Could not persist bot lid: ${err.message}`); }
    }

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
        if (key.fromMe) {
            // Our own message in a group carries our lid as the participant — the one
            // chance to learn it. Everything else about a fromMe message is ignored.
            if (String(key.remoteJid || '').endsWith('@g.us')) this._learnBotLid(key.participant || key.participantAlt);
            return;
        }
        const id = key.id || data?.messageId;
        if (id && this._processed.has(id)) return;
        if (id) { this._processed.add(id); setTimeout(() => this._processed.delete(id), 5 * 60_000); }
        const jid = key.remoteJid || data?.remoteJid || data?.chatId || '';
        const isGroup = jid.endsWith('@g.us');
        // Personal chat is the product: a DM from a known teammate IS the request, no tag.
        // Groups stay off unless SPRINT_AGENT_GROUPS is on, and there a tag is still required
        // so the bot never answers ordinary group chatter.
        if (isGroup && !config.SPRINT_AGENT_GROUPS) return;
        if (isGroup && config.ALLOWED_GROUPS.length && !config.ALLOWED_GROUPS.includes(jid)) {
            console.warn(`[Evolution] Ignored message from group ${jid} — not in ALLOWED_GROUPS.`);
            return;
        }
        const msg = data?.message || data;
        const text = messageText(msg).trim();
        if (isGroup && !this._tagged(msg, data, text)) {
            // Only log when the message looks like it was meant for us. Logging every
            // untagged line would replay the whole group into the log, but "I tagged it
            // and nothing happened" was previously indistinguishable from a dead webhook.
            if (/(^|\s)@/.test(text)) {
                const seen = [...new Set(mentionedJids(msg).concat(mentionedJids(data)).map(cleanId))];
                console.warn(`[Evolution] Group message tagged someone else — ignoring. mentioned=[${seen.join(', ')}] `
                    + `known=[${[...this._botLids, this.botNumber].filter(Boolean).join(', ')}]. `
                    + `If one of the mentioned ids is Oli, add it to EVOLUTION_BOT_LID.`);
            }
            return;
        }
        // WhatsApp now addresses most chats by `@lid` — a linked-identity id that is NOT a
        // phone number — and carries the real number alongside in `*Alt`/`*Pn`. Read those
        // first: a bare `@lid` fails the allowed-phones gate for every teammate, and is not
        // a number we could reply to either. In a DM the chat itself is the sender
        // (`payload.sender` is our own number, never theirs).
        const senderJid = String(isGroup
            ? (key.participantAlt || key.participantPn || key.participant || data?.participant || '')
            : (key.remoteJidAlt || key.senderPn || jid));
        const isLid = senderJid.endsWith('@lid');
        const sender = isLid ? '' : cleanId(senderJid);
        // An explicitly allow-listed group is the trust boundary, so a member we cannot
        // resolve to a phone number is still legitimate — and we reply to the GROUP, not
        // to them, so their number is not needed to answer. Newer WhatsApp groups address
        // every participant by `@lid`, which would otherwise drop every tagged message in
        // the group. Such a sender travels as an opaque participant id and simply does not
        // resolve to a dashboard user.
        const groupTrusted = isGroup && config.ALLOWED_GROUPS.includes(jid);
        const participant = sender || (isLid && groupTrusted ? `lid:${cleanId(senderJid)}` : '');
        if (!participant) {
            if (senderJid) {
                console.warn(`[Evolution] Ignored message from ${senderJid} — no phone number in the payload`
                    + `${isGroup ? '. Add this group to ALLOWED_GROUPS to accept its @lid members.' : '.'}`);
            }
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
        const trusted = (sender && this._allowed(sender)) || groupTrusted;
        if (!trusted && (isGroup || !config.SPRINT_AGENT_OPEN_DMS)) {
            console.warn(`[Evolution] Ignored sprint message from ${participant} — not in the allowed phones list${isGroup ? ' (group not in ALLOWED_GROUPS)' : ' (open DMs are off)'}.`);
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
            phone: participant, text: command || '(no text — see the attached media)',
            pushName: data?.pushName || data?.pushname || (isGroup ? 'Group member' : 'Teammate'),
            // Reply to the group JID, or to the teammate's *number* — never the `@lid`.
            groupJid: isGroup ? jid : null, chatJid: isGroup ? jid : sender, raw: payload, sprintCommand: true,
            trusted, media,
        });
    }
}
