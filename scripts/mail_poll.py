#!/usr/bin/env python3
"""mail_poll.py — read-only Gmail IMAP fetch for project_handler.js.

Prints one JSON object on stdout. The password comes from the env var named by
--pass-env, never from argv (argv is visible in `ps`).

  --since-uid N         messages in INBOX with UID >= N (omit → just report uidnext)
  --thread THRID        every message of one Gmail thread (All Mail), oldest first
  --from-domain D       only senders at D (repeatable)
  --attach-dir DIR      save attachments under DIR/<message uid>/
"""
import argparse, email, imaplib, json, os, re, sys
from email.header import decode_header, make_header
from email.utils import getaddresses, parseaddr

MAX_TEXT = 8000
# Where the quoted history starts: Outlook "From:/Sent:" (often *bold*), Gmail "On … wrote:"
# (wrapped onto two lines when the address is long), or a separator line.
QUOTE_RE = re.compile(r'\n(?:\*?From:\*? .+\n\*?(?:Sent|Date):|On [^\n]{5,200}(?:\n[^\n]{0,200})?wrote:|-----Original Message-----|_{20,})', re.I)


def hdr(v):
    return str(make_header(decode_header(v))) if v else ''


def body_text(msg):
    plain, html = None, None
    for p in msg.walk():
        if p.get_content_maintype() == 'multipart' or p.get_filename():
            continue
        ct = p.get_content_type()
        data = p.get_payload(decode=True) or b''
        text = data.decode(p.get_content_charset() or 'utf-8', errors='replace')
        if ct == 'text/plain' and plain is None:
            plain = text
        elif ct == 'text/html' and html is None:
            html = re.sub(r'<[^>]+>', ' ', re.sub(r'(?is)<(style|script).*?</\1>', '', text))
    text = (plain or html or '').replace('\r\n', '\n')
    latest = QUOTE_RE.split(text, 1)[0]  # this message only; the thread is fetched separately
    return re.sub(r'\n{3,}', '\n\n', latest).strip()[:MAX_TEXT]


def save_attachments(msg, folder):
    paths = []
    for i, p in enumerate(msg.walk()):
        name = p.get_filename()
        if not name or not folder:
            continue
        safe = re.sub(r'[^\w.\- ]', '_', hdr(name))[:120] or 'attachment'
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f'{i:02d}_{safe}')  # same names repeat inside forwarded mails
        with open(path, 'wb') as f:
            f.write(p.get_payload(decode=True) or b'')
        paths.append(path)
    return paths


def fetch(m, uids, domains, attach_dir):
    out = []
    for uid in uids:
        typ, data = m.uid('fetch', uid, '(X-GM-THRID BODY.PEEK[])')
        if typ != 'OK' or not data or not isinstance(data[0], tuple):
            continue
        meta = data[0][0].decode()
        thrid = re.search(r'X-GM-THRID (\d+)', meta)
        msg = email.message_from_bytes(data[0][1])
        sender = parseaddr(hdr(msg['From']))[1].lower()
        if domains and not any(sender.endswith('@' + d) for d in domains):
            continue
        out.append({
            'uid': int(uid),
            'thread_id': thrid.group(1) if thrid else None,
            'message_id': (msg['Message-ID'] or '').strip(),
            'from': hdr(msg['From']),
            'from_email': sender,
            'to': [a for _, a in getaddresses([hdr(msg['To'])])],
            'cc': [a for _, a in getaddresses([hdr(msg['Cc'])])],
            'date': msg['Date'],
            'subject': ' '.join(hdr(msg['Subject']).split()),
            'text': body_text(msg),
            'attachments': save_attachments(msg, os.path.join(attach_dir, uid.decode() if isinstance(uid, bytes) else str(uid)) if attach_dir else None),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', required=True)
    ap.add_argument('--pass-env', required=True)
    ap.add_argument('--host', default='imap.gmail.com')
    ap.add_argument('--since-uid', type=int)
    ap.add_argument('--thread')
    ap.add_argument('--from-domain', action='append', default=[])
    ap.add_argument('--attach-dir')
    a = ap.parse_args()
    password = os.environ.get(a.pass_env, '').replace(' ', '')
    if not password:
        sys.exit(f'{a.pass_env} is not set')

    m = imaplib.IMAP4_SSL(a.host, timeout=60)
    m.login(a.user, password)
    try:
        if a.thread:
            if not a.thread.isdigit():
                sys.exit('--thread must be a Gmail thread id')
            m.select('"[Gmail]/All Mail"', readonly=True)
            typ, data = m.uid('search', None, 'X-GM-THRID', a.thread)
            msgs = fetch(m, data[0].split(), [], None)  # whole thread: our own replies are context too
            print(json.dumps({'messages': msgs}))
            return
        typ, data = m.select('INBOX', readonly=True)
        typ, st = m.status('INBOX', '(UIDNEXT)')
        uidnext = int(re.search(rb'UIDNEXT (\d+)', st[0]).group(1))
        msgs = []
        if a.since_uid is not None and a.since_uid < uidnext:
            # Filter on the server so only candidate mails are downloaded; fetch() re-checks
            # the exact sender domain (IMAP FROM is a substring match).
            froms = [['FROM', '@' + d] for d in a.from_domain]
            crit = ['UID', f'{a.since_uid}:*'] + ['OR'] * max(len(froms) - 1, 0) + [x for f in froms for x in f]
            typ, data = m.uid('search', None, *crit)
            uids = [u for u in data[0].split() if int(u) >= a.since_uid]  # n:* always returns the last message
            msgs = fetch(m, uids, [d.lower() for d in a.from_domain], a.attach_dir)
        print(json.dumps({'uidnext': uidnext, 'messages': msgs}))
    finally:
        m.logout()


if __name__ == '__main__':
    main()
