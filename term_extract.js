// ---------------------------------------------------------------------------
// term_extract.js — headless terminal emulator + conversation extractor
//
// THE "interpret layer" for V2. Claude Code's interactive output is a stream of
// ANSI/VT escape sequences (a full-screen Ink TUI), NOT clean text. We can't
// regex it: Claude moves the cursor and OVERWRITES regions, so the rendered
// transcript is the *result* of replaying those ops onto a grid, not a substring
// of the byte stream.
//
// So we run a SERVER-SIDE @xterm/headless terminal — the exact VT engine the UI
// xterm uses, minus rendering. We feed it the same PTY bytes; it maintains the
// 2D screen buffer for us. We then read the buffer back as plain text and
// classify the committed scrollback lines into conversation messages.
//
// Claude Code is unusually friendly to this: its interactive UI renders to the
// MAIN screen (not the alternate buffer), so finished messages commit to
// scrollback as readable text. Only the bottom "live region" (the bordered
// input box + status hints + spinner) is redrawn in place. We drop that live
// region and parse what's above it.
//
// This layer is intentionally heuristic and isolated. The glyph set Claude Code
// uses can change between versions — tune the constants below, not the callers.
// `extract()` always returns a clean `text` (de-ANSI'd transcript) so the UI has
// something correct to show even if structured parsing drifts.
// ---------------------------------------------------------------------------

import pkg from '@xterm/headless';
const { Terminal } = pkg;

// --- Tunable glyph / pattern table (Claude Code TUI, verified v2.1.177) -----
// Committed turns render with leading glyphs in the scrollback:
//   ❯ <text>   user message        ● <text>   assistant message
//   ⎿  <text>  tool result branch
// (Older builds used `>` for user and `⏺` for the assistant bullet — both kept.)
const USER_GLYPHS = ['❯', '>'];        // ❯ U+276F
const ASSISTANT_GLYPHS = ['●', '⏺'];   // ● U+25CF (v2.1.x) · ⏺ U+23FA (older)
const TOOL_BRANCH = '⎿';               // ⎿ U+23BF

// Box-drawing + horizontal rules used for the input frame / chrome.
const BOX_RE = /[─-╿]/;                 // ─ │ ╭ ╮ ╰ ╯ ┌ …
const BOX_TOP_RE = /[╭┌╔]/;                       // framed-box top-left (older builds)
const HRULE_RE = /^\s*[─━—―-]{12,}\s*$/; // ──────  full-width rule (v2.1.x input frame)
// Block-element glyphs: the splash logo and the inline progress bar (██░░).
const BLOCK_RE = /[▀-▟]/;
// Spinner / "thinking" status glyphs that head a transient live line.
const SPINNER_RE = /^\s*[✳✴✵✶✷✸✹✺✻✼✽✢✨·․∙∗*⁂○◯]/u;
// Pure chrome / hint / status text we never want in the transcript.
const HINT_RE = /(esc to interrupt|\? for shortcuts|ctrl\+|tokens?\b.*(left|used)|\baccept edits\b|press up to|\bbypass permissions\b|for agents|setup issues?|cooked for|\bthinking\b|claude code v\d|·\s*claude (max|pro)|^\s*⬆|^\s*←|^\s*⚠)/i;

function isBlank(s) { return !s || !s.trim(); }
function isHrule(s) { return HRULE_RE.test(s); }
// A line that's pure banner/chrome noise (splash logo, progress bar, warnings).
function isNoise(s) {
    const t = s.replace(/^\s+/, '');
    if (!t) return false;
    if (BLOCK_RE.test(t)) return true;                 // logo / progress-bar block glyphs
    if (HINT_RE.test(t)) return true;                  // version / status / hint text
    if (SPINNER_RE.test(t) && t.length < 60) return true; // ✻ Cooked for 1s, spinners
    return false;
}

// Strip a leading glyph (and one following space) for clean text.
function stripGlyph(s, glyph) {
    const t = s.replace(/^\s+/, '');
    return t.slice(glyph.length).replace(/^\s/, '');
}
const startsWithAny = (s, glyphs) => { const t = s.replace(/^\s+/, ''); return glyphs.find((g) => t.startsWith(g)); };

// Common-indent dedent for a group of continuation lines.
function dedent(lines) {
    const nonEmpty = lines.filter((l) => l.trim());
    if (!nonEmpty.length) return lines;
    const min = Math.min(...nonEmpty.map((l) => l.length - l.replace(/^\s+/, '').length));
    return lines.map((l) => l.slice(min));
}

export function createExtractor({ cols = 80, rows = 24 } = {}) {
    const term = new Terminal({
        cols: Math.max(20, cols | 0),
        rows: Math.max(5, rows | 0),
        scrollback: 20000,
        allowProposedApi: true,
    });

    const feed = (data) => { try { term.write(data); } catch (_) {} };
    const resize = (c, r) => { try { term.resize(Math.max(20, c | 0), Math.max(5, r | 0)); } catch (_) {} };
    const dispose = () => { try { term.dispose(); } catch (_) {} };

    // Read the full buffer (scrollback + viewport) as trimmed plain-text lines.
    const readLines = () => {
        const b = term.buffer.active;
        const out = [];
        for (let i = 0; i < b.length; i++) {
            const line = b.getLine(i);
            out.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
        }
        return out;
    };

    // Drop the bottom "live region": the input frame and everything below it.
    // v2.1.x frames the prompt with two full-width ──── rules; older builds use a
    // ╭───╮ box. Cut from the TOP edge of that bottom frame downward, then trim
    // any trailing hint/blank lines left above the cut.
    const stripLiveRegion = (lines) => {
        let end = lines.length;
        while (end > 0 && isBlank(lines[end - 1])) end--;

        // Collect rule / box-top indices within the tail window.
        const win = Math.max(0, end - 14);
        let cut = -1;
        const rules = [];
        for (let i = end - 1; i >= win; i--) {
            if (isHrule(lines[i])) rules.push(i);
            else if (BOX_TOP_RE.test(lines[i]) && BOX_RE.test(lines[i])) { cut = i; break; }
        }
        if (cut < 0 && rules.length) {
            // rules are bottom-up; the input frame's TOP rule is the highest index pair.
            // Use the 2nd rule from the bottom if present (top of the box), else the last.
            cut = rules.length >= 2 ? rules[1] : rules[0];
        }
        if (cut >= 0) end = cut;

        while (end > 0) {
            const l = lines[end - 1];
            if (isBlank(l) || isHrule(l) || isNoise(l) || (BOX_RE.test(l) && !l.replace(/[─-╿\s]/g, ''))) end--;
            else break;
        }
        return lines.slice(0, end);
    };

    // Classify transcript lines into {role, content} messages.
    const parse = (lines) => {
        const messages = [];
        let cur = null;
        const flush = () => {
            if (!cur) return;
            const content = dedent(cur.buf).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
            if (content.trim()) messages.push({ role: cur.role, content, tool: cur.tool || false });
            cur = null;
        };

        for (const raw of lines) {
            const line = raw.replace(/\s+$/, '');
            const trimmed = line.replace(/^\s+/, '');

            // Drop splash banner / progress / spinner / hint / rule noise outright.
            if (isHrule(line) || isNoise(line)) continue;
            if (trimmed && BOX_RE.test(trimmed) && !trimmed.replace(/[─-╿\s]/g, '')) continue;

            const uG = startsWithAny(line, USER_GLYPHS);
            if (uG) {
                const body = stripGlyph(line, uG);
                if (!body.trim()) continue; // a bare prompt glyph that leaked through
                flush();
                cur = { role: 'user', buf: [body], tool: false };
                continue;
            }
            const aG = startsWithAny(line, ASSISTANT_GLYPHS);
            if (aG) {
                flush();
                const body = stripGlyph(line, aG);
                // A `Name(args)` shape right after the bullet → tool invocation.
                const isTool = /^[A-Z][\w]*\s*\(/.test(body) || (/^[A-Z][\w ]*…?$/.test(body) && body.length < 40);
                cur = { role: 'assistant', buf: [body], tool: isTool };
                continue;
            }
            if (trimmed.startsWith(TOOL_BRANCH)) {
                const body = stripGlyph(line, TOOL_BRANCH);
                if (cur) { cur.tool = true; cur.buf.push(body); }
                else cur = { role: 'assistant', buf: [body], tool: true };
                continue;
            }
            // Continuation line (indented body of the current message).
            if (cur) cur.buf.push(line);
            else if (!isBlank(line)) cur = { role: 'assistant', buf: [line], tool: false };
        }
        flush();
        return messages;
    };

    const extract = () => {
        const all = readLines();
        // Detect whether Claude is mid-turn (drives the live "thinking" box). The
        // active spinner — a gerund + ellipsis like "✽ Zesting…" / "Baking… (2s ·
        // … · thinking)" — renders in the LIVE region at the bottom of the screen,
        // just above the input frame. We scan ONLY the screen tail: scanning the
        // whole scrollback would let an old "Verb…"/"(2s" line in history pin
        // "working" on forever (the bug where a concluded turn stayed "Working…").
        // We also never key on a bare token counter — the footer shows a persistent
        // context-usage count in long sessions.
        const tail = all.filter((l) => l.trim()).slice(-14); // last few non-empty (live) lines
        const MSG_GLYPH = /^[●⏺⎿❯>]/; // committed user/assistant/tool lines — never the spinner
        const working = tail.some((l) => {
            const t = l.trim();
            if (MSG_GLYPH.test(t)) return false;                                            // committed line, never the spinner
            if (/esc to interrupt/i.test(t)) return true;                                  // some builds
            if (/·\s*thinking\b/i.test(t)) return true;                                     // live "· thinking"
            // A spinner-glyph line that carries a LIVE-action marker: an ellipsis
            // ("Zesting…", "Working…") or a "running … hook" note. This catches the
            // post-answer Stop hook — "✽ Zesting… (running stop hook · 21s · ↓ 595
            // tokens)" — which the parenthetical/$-anchored rules below miss.
            // CRITICAL: do NOT key on a bare elapsed "Ns" timer here. When a turn
            // FINISHES, Claude leaves a past-tense idle line "✻ Crunched for 2s"
            // (spinner glyph + "2s", but NO ellipsis, NO "esc to interrupt") — keying
            // on "Ns" matched that done-line and latched `working` true forever, so the
            // session status never flipped to 'stopped' (the "stuck in running" bug).
            if (SPINNER_RE.test(l) && /(…|running\s+.*\bhook\b)/.test(t)) return true;
            if (/…\s*\(\s*\d+\s*s\b/.test(t)) return true;                                  // spinner "Verb… (2s …"
            if (/^\S\s+[A-Z][a-z]+…$/.test(t)) return true;                                 // bare "✽ Zesting…"
            return false;
        });
        const transcript = stripLiveRegion(all);
        // Clean plaintext fallback: drop banner / rule / hint noise too.
        const text = transcript
            .filter((l) => !isHrule(l) && !isNoise(l))
            .join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
        const messages = parse(transcript);
        return { messages, text, working };
    };

    return { feed, resize, dispose, extract, readLines };
}
