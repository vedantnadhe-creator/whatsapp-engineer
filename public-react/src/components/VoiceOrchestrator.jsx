import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, Square, X, Loader2, Send, Sparkles, RotateCcw, Volume2 } from 'lucide-react';
import { orchestratorMyWork, orchestratorChat, orchestratorVoice, orchestratorReset } from '../hooks/useApi';

// Personal voice orchestrator — push-to-talk assistant that knows the user's
// sprint work and can act on it. Audio is captured in the browser, transcribed +
// reasoned + spoken server-side (Deepgram + Gemini); the reply autoplays so it
// works hands-free with headphones.
export default function VoiceOrchestrator() {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]); // [{ role, text }]
  const [work, setWork] = useState('');
  const [draft, setDraft] = useState('');

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    orchestratorMyWork().then(r => setWork(r?.work || '')).catch(() => {});
  }, [open]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);

  const playAudio = useCallback((b64) => {
    if (!b64) return;
    try {
      const src = `data:audio/mp3;base64,${b64}`;
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = src;
      audioRef.current.play().catch(() => {});
    } catch (_) {}
  }, []);

  const handleResult = (r) => {
    if (r?.transcript) setMessages(m => [...m, { role: 'user', text: r.transcript }]);
    if (r?.reply) setMessages(m => [...m, { role: 'assistant', text: r.reply, actions: r.actions }]);
    playAudio(r?.audioBase64);
  };

  const sendText = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setMessages(m => [...m, { role: 'user', text }]);
    setBusy(true);
    try { const r = await orchestratorChat(text); if (r?.reply) { setMessages(m => [...m, { role: 'assistant', text: r.reply, actions: r.actions }]); playAudio(r.audioBase64); } }
    catch (e) { setMessages(m => [...m, { role: 'assistant', text: 'Something went wrong: ' + (e.message || e) }]); }
    finally { setBusy(false); }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size === 0) return;
        setBusy(true);
        try { handleResult(await orchestratorVoice(blob)); }
        catch (e) { setMessages(m => [...m, { role: 'assistant', text: 'Voice failed: ' + (e.message || e) }]); }
        finally { setBusy(false); }
      };
      rec.start();
      setRecording(true);
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', text: 'Mic access denied. Allow microphone to use voice.' }]);
    }
  };

  const toggleMic = () => { if (recording) recorderRef.current?.stop(); else startRecording(); };

  const reset = async () => { setMessages([]); try { await orchestratorReset(); } catch (_) {} };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="Voice orchestrator"
        className="fixed z-50 bottom-5 right-5 flex items-center justify-center rounded-full shadow-lg cursor-pointer transition-transform hover:scale-105"
        style={{ width: 52, height: 52, backgroundColor: 'var(--c-accent)', color: '#fff' }}>
        <Sparkles size={22} />
      </button>
    );
  }

  return (
    <div className="fixed z-50 bottom-5 right-5 flex flex-col rounded-xl shadow-2xl"
      style={{ width: 360, maxWidth: 'calc(100vw - 24px)', height: 520, maxHeight: 'calc(100vh - 40px)', backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <Sparkles size={16} style={{ color: 'var(--c-accent)' }} />
        <span className="text-sm font-semibold flex-1" style={{ color: 'var(--c-text)' }}>Orchestrator</span>
        <button onClick={reset} title="Clear conversation" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><RotateCcw size={14} /></button>
        <button onClick={() => setOpen(false)} title="Close" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={16} /></button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2.5">
        {messages.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            <p className="mb-2">Tap the mic and speak, or type. I know your sprint work and can start sessions, update statuses, log bugs and more.</p>
            {work && (
              <div className="rounded-lg p-2 mt-1" style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)' }}>
                <div className="font-semibold mb-1" style={{ color: 'var(--c-text-secondary)' }}>Your work</div>
                <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed" style={{ color: 'var(--c-text-muted)' }}>{work}</pre>
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className="rounded-2xl px-3 py-1.5 text-sm max-w-[85%]"
              style={{ backgroundColor: m.role === 'user' ? 'var(--c-accent)' : 'var(--c-bg)', color: m.role === 'user' ? '#fff' : 'var(--c-text)', border: m.role === 'user' ? 'none' : '1px solid var(--c-border)' }}>
              {m.role === 'assistant' && <Volume2 size={11} className="inline mr-1 align-middle" style={{ color: 'var(--c-text-muted)' }} />}
              {m.text}
              {Array.isArray(m.actions) && m.actions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.actions.map((a, j) => (
                    <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: a.result?.ok ? '#22c55e22' : '#ef444422', color: a.result?.ok ? '#22c55e' : '#ef4444' }}>{a.tool}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="rounded-2xl px-3 py-1.5" style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)' }}><Loader2 size={14} className="animate-spin" style={{ color: 'var(--c-text-muted)' }} /></div></div>}
      </div>

      {/* Mic + input */}
      <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderTop: '1px solid var(--c-border)' }}>
        <button onClick={toggleMic} disabled={busy} title={recording ? 'Stop & send' : 'Tap to talk'}
          className="flex items-center justify-center rounded-full cursor-pointer shrink-0 disabled:opacity-50 transition-colors"
          style={{ width: 40, height: 40, backgroundColor: recording ? '#ef4444' : 'var(--c-accent)', color: '#fff' }}>
          {recording ? <Square size={16} /> : <Mic size={18} />}
        </button>
        <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendText()}
          placeholder={recording ? 'Listening…' : 'Type or tap the mic…'} disabled={recording}
          className="flex-1 text-sm rounded-full px-3 py-2 outline-none"
          style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
        <button onClick={sendText} disabled={busy || !draft.trim()} className="p-2 rounded-full cursor-pointer disabled:opacity-40 shrink-0" style={{ color: 'var(--c-accent)' }}><Send size={16} /></button>
      </div>
    </div>
  );
}
