// WhatsApp media → S3 attachment descriptors.
//
// A bug filed from WhatsApp is usually a screenshot or a screen recording, so the
// media has to reach the board, not just the chat. Evolution stores the encrypted
// blob and hands it back base64 on request; the dashboard already knows how to put
// a file in the bug-attachments bucket. This is the join between the two.
//
// The upload happens BEFORE the agent's turn, not as a tool it chooses to call:
// the media is the evidence, and an agent that forgets to fetch it files a bug with
// a description of a screenshot nobody can see.
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from './config.js';

// WhatsApp's own caps; anything larger never arrives in the first place. The
// dashboard's raw body parser stops at 50mb, so keep under it.
const MAX_BYTES = 45 * 1024 * 1024;

// The blob is also dropped on local disk so the agent can actually LOOK at it.
// Storing it only in S3 makes the media available to the board but invisible to the
// session — which is how "pick the first bug from the image" turns into "I can't view
// image contents". `_prepareFile` copies from here into the session's working dir.
const SCRATCH = path.join(os.tmpdir(), 'oli-media');
const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;

function scratchWrite(name, buffer) {
    fs.mkdirSync(SCRATCH, { recursive: true });
    // Prune on write rather than on a timer: this is the only thing that creates them,
    // so there is no state to keep and nothing runs when nobody sends media.
    const now = Date.now();
    for (const f of fs.readdirSync(SCRATCH)) {
        const full = path.join(SCRATCH, f);
        try { if (now - fs.statSync(full).mtimeMs > SCRATCH_TTL_MS) fs.unlinkSync(full); } catch (_) { /* raced */ }
    }
    const dest = path.join(SCRATCH, `${now.toString(36)}-${name}`);
    fs.writeFileSync(dest, buffer);
    return dest;
}

const KINDS = {
    imageMessage: { ext: 'jpg', label: 'image' },
    videoMessage: { ext: 'mp4', label: 'video' },
    documentMessage: { ext: 'bin', label: 'document' },
    documentWithCaptionMessage: { ext: 'bin', label: 'document' },
    audioMessage: { ext: 'ogg', label: 'audio' },
    stickerMessage: { ext: 'webp', label: 'sticker' },
};

/**
 * Media attached to a message, or to the message it quotes.
 *
 * Quoting matters: "@oli file this as a bug" is very often a reply to the screenshot
 * someone posted earlier rather than a fresh upload with a caption. `contextInfo`
 * carries the quoted message's own id in `stanzaId`, which is what Evolution needs
 * to hand the blob back.
 */
export function findMedia(data) {
    const msg = data?.message || {};
    const key = data?.key || {};
    const ctx = msg?.extendedTextMessage?.contextInfo || msg?.imageMessage?.contextInfo || data?.contextInfo || {};
    const direct = Object.keys(KINDS).find(k => msg[k]);
    if (direct) return { messageId: key.id, kind: direct, node: msg[direct], quoted: false };
    const quoted = ctx?.quotedMessage;
    const quotedKind = quoted && Object.keys(KINDS).find(k => quoted[k]);
    if (quotedKind && ctx.stanzaId) return { messageId: ctx.stanzaId, kind: quotedKind, node: quoted[quotedKind], quoted: true };
    return null;
}

function fileNameFor({ kind, node, messageId }) {
    const named = node?.fileName || node?.title;
    if (named) return String(named).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const ext = (node?.mimetype || '').split('/')[1]?.split(';')[0] || KINDS[kind]?.ext || 'bin';
    return `whatsapp-${KINDS[kind]?.label || 'file'}-${String(messageId || '').slice(-8) || 'file'}.${ext}`;
}

/**
 * Fetch one message's media from Evolution and put it in the bug-attachments bucket.
 * Returns the descriptor the board stores on a bug, or null when there is nothing to
 * fetch. Never throws: a failed screenshot must not cost the user their bug report,
 * so the caller degrades to a text-only bug and says so.
 *
 * @returns {Promise<{name:string,key:string,contentType:string,kind:string,quoted:boolean,localPath:string,viewable:boolean}|null>}
 */
export async function fetchAndUpload(found, { apiBase, token }) {
    if (!found?.messageId) return null;
    try {
        const res = await fetch(
            `${config.EVOLUTION_API_URL.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: config.EVOLUTION_API_KEY },
                body: JSON.stringify({ message: { key: { id: found.messageId } }, convertToMp4: false }),
            },
        );
        if (!res.ok) throw new Error(`Evolution ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const payload = await res.json();
        const b64 = payload?.base64 || payload?.data?.base64;
        if (!b64) throw new Error('Evolution returned no base64 for that message');
        const buffer = Buffer.from(b64, 'base64');
        if (!buffer.length) throw new Error('Evolution returned an empty file');
        if (buffer.length > MAX_BYTES) throw new Error(`File is ${(buffer.length / 1048576).toFixed(1)}MB, over the ${MAX_BYTES / 1048576}MB limit`);

        const name = fileNameFor(found);
        const contentType = payload?.mimetype || found.node?.mimetype || 'application/octet-stream';
        const up = await fetch(`${apiBase}/api/attachments`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': contentType,
                'x-file-name': encodeURIComponent(name),
                'x-mime-type': contentType,
            },
            body: buffer,
        });
        if (!up.ok) throw new Error(`Attachment upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
        const descriptor = await up.json();
        // Local copy for the agent's own eyes. A failure here must not lose the upload
        // that already succeeded — the bug still gets its attachment either way.
        let localPath = null;
        try { localPath = scratchWrite(name, buffer); }
        catch (err) { console.error(`[OliMedia] Could not stage ${name} locally: ${err.message}`); }
        console.log(`[OliMedia] Stored ${name} (${(buffer.length / 1024).toFixed(0)}KB) as ${descriptor.key}${localPath ? ' + local copy' : ''}`);
        return {
            ...descriptor,
            kind: KINDS[found.kind]?.label || 'file',
            quoted: found.quoted,
            localPath,
            // Only images are worth handing to the model directly; a 40MB mp4 is not
            // something it can watch, and the attachment link is the useful artefact.
            viewable: Boolean(localPath) && String(contentType).startsWith('image/'),
        };
    } catch (err) {
        console.error(`[OliMedia] ${err.message}`);
        return null;
    }
}
