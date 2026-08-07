// Evolution API transport.  It deliberately exposes the same small surface the
// rest of OliBot uses from the old Baileys bridge: `connect`, `sendMessage` and
// EventEmitter `message`/`ready` events.
import { EventEmitter } from 'events';
import config from './config.js';

const cleanId = value => String(value || '').split(':')[0].split('@')[0].replace(/\D/g, '');
const messageText = msg => msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || '';

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
    _allowed(phone) { return config.ALLOWED_PHONES.length === 0 || this.store.isPhoneAllowed(phone); }

    async _request(path, options = {}) {
        const response = await fetch(this._url(path), { ...options, headers: { ...this._headers(), ...(options.headers || {}) } });
        const text = await response.text();
        let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!response.ok) throw new Error(`Evolution API ${response.status}: ${data?.message || data?.error || text || 'request failed'}`);
        return data;
    }

    async connect() {
        if (!this.enabled) throw new Error('Evolution is not configured: set EVOLUTION_API_URL and EVOLUTION_INSTANCE');
        const state = await this._request(`/instance/connectionState/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`, { method: 'GET' });
        const instance = state?.instance || state;
        this.botNumber = cleanId(instance?.owner || instance?.ownerJid || instance?.number || this.botNumber);
        this.sock = { connected: String(instance?.state || instance?.connectionStatus || '').toLowerCase() === 'open' };
        console.log(`[Evolution] Instance ${config.EVOLUTION_INSTANCE}: ${instance?.state || instance?.connectionStatus || 'unknown'}${this.botNumber ? ` (${this.botNumber})` : ''}`);
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
        const data = payload?.data || payload;
        const key = data?.key || {};
        if (key.fromMe) return;
        const id = key.id || data?.messageId;
        if (id && this._processed.has(id)) return;
        if (id) { this._processed.add(id); setTimeout(() => this._processed.delete(id), 5 * 60_000); }
        const jid = key.remoteJid || data?.remoteJid || data?.chatId || '';
        const isGroup = jid.endsWith('@g.us');
        if (!isGroup) return; // this automation is intentionally group + mention only
        if (config.ALLOWED_GROUPS.length && !config.ALLOWED_GROUPS.includes(jid)) return;
        const msg = data?.message || data;
        const text = messageText(msg).trim();
        const mentioned = msg?.extendedTextMessage?.contextInfo?.mentionedJid || data?.contextInfo?.mentionedJid || [];
        const mentionMatchesBot = this.botNumber && mentioned.some(j => cleanId(j) === this.botNumber);
        // Do not treat a plain word/name as a mention: the product is tag-only by design.
        if (!mentionMatchesBot) return;
        const sender = cleanId(key.participant || data?.participant || data?.sender || '');
        if (!sender || !this._allowed(sender)) return;
        const command = text.replace(/@\S+/g, '').trim();
        if (!command) return;
        this.emit('message', { phone: sender, text: command, pushName: data?.pushName || data?.pushname || 'Group member', groupJid: jid, raw: payload, sprintCommand: true });
    }
}
