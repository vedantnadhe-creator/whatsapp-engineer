// ============================================================
// whatsapp.js — Baileys WhatsApp Multi-Device connection
// ============================================================

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { EventEmitter } from 'events';
import config from './config.js';
import fs from 'fs';
import path from 'path';

class WhatsAppBridge extends EventEmitter {
    constructor(store = null) {
        super();
        this.sock = null;
        this.logger = pino({ level: 'error' });
        // Map LID → phone for reply routing
        this.lidToPhone = new Map();
        this.phoneToJid = new Map();  // phone → full JID for replies
        this.botNumber = null;        // bot's phone number
        this.botLid = null;           // bot's LID (multi-device identifier)
        this.store = store;           // SessionStore for DB-backed allowlist
        // Dedup: track processed message IDs to avoid double-processing
        this._processedMsgIds = new Set();
    }

    _isAllowed(phone) {
        if (this.store) return this.store.isPhoneAllowed(phone);
        return config.ALLOWED_PHONES.length === 0 || config.ALLOWED_PHONES.includes(phone);
    }

    async connect() {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsApp] Using WA version: ${version.join('.')} (latest: ${isLatest})`);

        const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

        // Wrap saveCreds to ensure atomic writes — prevents empty creds.json on crash
        const credsPath = path.join(config.AUTH_DIR, 'creds.json');
        const saveCreds = async () => {
            await _saveCreds();
            // Verify creds.json wasn't written empty
            try {
                const stat = fs.statSync(credsPath);
                if (stat.size === 0) {
                    console.error('[WhatsApp] WARNING: creds.json written as empty! Skipping.');
                }
            } catch (e) { /* ignore stat errors */ }
        };

        this.sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, this.logger),
            },
            printQRInTerminal: false,
            logger: this.logger,
            browser: ['WhatsApp Engineer', 'Chrome', '22.0'],
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\nScan this QR code with WhatsApp:\n');
                qrcode.generate(qr, { small: true });
                console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n');
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                console.log(`[WhatsApp] Connection closed. Reason: ${reason}. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => this.connect(), 3000);
                } else {
                    console.log('[WhatsApp] Logged out. Delete auth_info/ and restart.');
                }
            }

            if (connection === 'open') {
                console.log('[WhatsApp] Connected successfully!');
                const me = state.creds?.me;
                if (me) {
                    this.botNumber = (me.id || '').split(':')[0].split('@')[0];
                    if (me.lid) {
                        this.botLid = (me.lid || '').split(':')[0].split('@')[0];
                    }
                    console.log(`[WhatsApp] Bot number: ${this.botNumber}, LID: ${this.botLid || 'unknown'}`);
                }
                this.emit('ready');
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (msg.key.fromMe) continue;

                const msgId = msg.key.id;
                if (this._processedMsgIds.has(msgId)) {
                    console.log(`[WhatsApp] Skipping duplicate message: ${msgId}`);
                    continue;
                }
                this._processedMsgIds.add(msgId);
                setTimeout(() => this._processedMsgIds.delete(msgId), 5 * 60 * 1000);

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');

                if (isGroup) {
                    console.log(`[WhatsApp] Group message | JID: ${jid} | participant: ${msg.key.participant || 'none'}`);

                    if (config.ALLOWED_GROUPS.length > 0 && !config.ALLOWED_GROUPS.includes(jid)) {
                        console.log(`[WhatsApp] Group ${jid} not in ALLOWED_GROUPS — ignoring`);
                        continue;
                    }

                    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const rawText = msg.message?.extendedTextMessage?.text || msg.message?.conversation || '';

                    const botMentionedByJid = mentionedJids.some(m => {
                        const num = m.split(':')[0].split('@')[0];
                        return (this.botNumber && num === this.botNumber) || (this.botLid && num === this.botLid);
                    });

                    const aliasPattern = new RegExp(
                        '@(' + config.BOT_ALIASES.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i'
                    );
                    const mentionedByAlias = aliasPattern.test(rawText);

                    if (!this.botLid && mentionedByAlias && mentionedJids.length > 0) {
                        const lidJid = mentionedJids.find(m => m.endsWith('@lid'));
                        if (lidJid) {
                            this.botLid = lidJid.split(':')[0].split('@')[0];
                            console.log(`[WhatsApp] Auto-discovered bot LID: ${this.botLid}`);
                        }
                    }

                    if (!botMentionedByJid && !mentionedByAlias) continue;

                    const participantJid = msg.key.participant || '';
                    const senderPhone = participantJid.split('@')[0].split(':')[0];
                    const groupIsAllowed = config.ALLOWED_GROUPS.includes(jid);
                    if (!groupIsAllowed && !this._isAllowed(senderPhone)) continue;

                    let text = rawText.replace(aliasPattern, '').trim();
                    if (botMentionedByJid) text = text.replace(/@\S+/g, '').trim();
                    if (!text) continue;

                    this.phoneToJid.set(senderPhone, jid);
                    this.emit('message', { phone: senderPhone, text, raw: msg, pushName: msg.pushName, groupJid: jid });
                    continue;
                }

                const idPart = jid.split('@')[0];
                const jidType = jid.split('@')[1];

                let phone;
                if (jidType === 's.whatsapp.net') {
                    phone = idPart;
                } else if (jidType === 'lid') {
                    phone = this.lidToPhone.get(idPart) || idPart;
                } else {
                    phone = idPart;
                }

                this.phoneToJid.set(phone, jid);

                {
                    const resolvedPhone = (jidType === 's.whatsapp.net') ? phone : (this.lidToPhone.get(idPart) || phone);
                    const isAllowed = this._isAllowed(resolvedPhone) ||
                        [...this.lidToPhone.entries()].some(([lid, p]) => this._isAllowed(p) && lid === idPart);
                    if (!isAllowed) {
                        if (jidType !== 'lid') { console.log(`[WhatsApp] Blocked: ${phone}`); continue; }
                    }
                }

                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || '';

                let imagePath = null;
                const imgMsg = msg.message?.imageMessage;
                const docMsg = msg.message?.documentMessage;

                if (imgMsg) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const ext = imgMsg.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'jpg';
                        imagePath = `/tmp/wa-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
                        fs.writeFileSync(imagePath, buffer);
                    } catch (err) { console.error(`[WhatsApp] Failed to download image: ${err.message}`); }
                } else if (docMsg) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const origName = docMsg.fileName || `document.${docMsg.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'bin'}`;
                        const safeExt = path.extname(origName) || '.bin';
                        imagePath = `/tmp/wa-doc-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`;
                        fs.writeFileSync(imagePath, buffer);
                    } catch (err) { console.error(`[WhatsApp] Failed to download document: ${err.message}`); }
                }

                if (!text.trim() && !imagePath) continue;
                this.emit('message', { phone, text, raw: msg, pushName: msg.pushName, imagePath });
            }
        });
    }

    mapLidToPhone(lid, phone) {
        this.lidToPhone.set(lid, phone);
    }

    async sendMessage(phone, text) {
        if (!this.sock) throw new Error('WhatsApp not connected');
        let jid = phone;
        if (!jid.includes('@')) jid = this.phoneToJid.get(phone) || `${phone}@s.whatsapp.net`;
        const chunks = this._chunkText(text, config.MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
            await this._sendWithRetry(jid, { text: chunks[i] });
            if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1500));
        }
    }

    async _sendWithRetry(jid, content, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await this.sock.sendMessage(jid, content);
                return;
            } catch (err) {
                const isTimeout = err?.output?.statusCode === 408 || err?.message?.includes('Timed Out');
                if (isTimeout && attempt < retries) {
                    console.warn(`[WhatsApp] Send timed out (attempt ${attempt + 1}/${retries + 1}), retrying in ${2 + attempt}s...`);
                    await new Promise(r => setTimeout(r, (2 + attempt) * 1000));
                } else {
                    console.error(`[WhatsApp] Send failed after ${attempt + 1} attempts:`, err.message);
                    throw err;
                }
            }
        }
    }

    _chunkText(text, maxLen) {
        if (text.length <= maxLen) return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= maxLen) { chunks.push(remaining); break; }
            let breakAt = remaining.lastIndexOf('\n', maxLen);
            if (breakAt < maxLen / 2) breakAt = maxLen;
            chunks.push(remaining.slice(0, breakAt));
            remaining = remaining.slice(breakAt);
        }
        return chunks;
    }
}

export default WhatsAppBridge;
