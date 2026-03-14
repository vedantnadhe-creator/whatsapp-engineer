import { useState, useRef, useEffect, useCallback } from 'react';
import {
  ArrowUp,
  Square,
  Paperclip,
  Mic,
  Lock,
  ChevronDown,
  Bot,
  User,
  Copy,
  Check,
  X,
  FileText,
  GitBranch,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const colors = {
  bg: 'var(--c-bg)',
  surface: 'var(--c-surface)',
  surface2: 'var(--c-surface-2)',
  surface3: 'var(--c-surface-3)',
  border: 'var(--c-border)',
  text: 'var(--c-text)',
  textSecondary: 'var(--c-text-secondary)',
  accent: 'var(--c-accent)',
};

function StatusDot({ status }) {
  const color = status === 'running' ? 'var(--c-status-running)' : status === 'completed' ? 'var(--c-status-completed)' : status === 'error' ? 'var(--c-status-failed)' : 'var(--c-text-secondary)';
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-2 rounded-lg overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ backgroundColor: colors.surface3 }}>
        <span className="font-mono text-[10px] uppercase" style={{ color: colors.textSecondary }}>
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:opacity-80 cursor-pointer"
          title="Copy code"
        >
          {copied
            ? <Check size={12} style={{ color: 'var(--c-status-running)' }} />
            : <Copy size={12} style={{ color: colors.textSecondary }} />
          }
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '12px',
          fontSize: '13px',
          background: colors.surface,
          borderRadius: 0,
        }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

const markdownComponents = {
  code({ inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    if (!inline && (match || String(children).includes('\n'))) {
      return <CodeBlock language={match?.[1]}>{children}</CodeBlock>;
    }
    return (
      <code
        className="px-1.5 py-0.5 rounded font-mono text-sm"
        style={{ backgroundColor: colors.surface3 }}
        {...props}
      >
        {children}
      </code>
    );
  },
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>;
  },
  li({ children }) {
    return <li>{children}</li>;
  },
  h1({ children }) {
    return <h1 className="text-lg font-bold mb-2 mt-3 font-mono">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-base font-bold mb-2 mt-3 font-mono">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-sm font-bold mb-1 mt-2 font-mono">{children}</h3>;
  },
  blockquote({ children }) {
    return (
      <blockquote
        className="pl-3 my-2 italic"
        style={{ borderLeft: `2px solid ${colors.accent}`, color: colors.textSecondary }}
      >
        {children}
      </blockquote>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
        style={{ color: colors.accent }}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="text-left px-3 py-1.5 font-medium font-mono text-xs" style={{ borderBottom: `1px solid ${colors.border}`, color: colors.textSecondary }}>
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-3 py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
        {children}
      </td>
    );
  },
  hr() {
    return <hr className="my-3" style={{ borderColor: colors.border }} />;
  },
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
};

function MarkdownContent({ content }) {
  if (!content) return null;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

// SQLite CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' without timezone.
// Append 'Z' so the browser treats it as UTC, then toLocale* converts to local.
function parseUTC(ts) {
  if (!ts) return null;
  const s = String(ts);
  return new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = parseUTC(timestamp);
  if (!d || isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseThinking(content) {
  if (!content) return { thinking: null, body: content };
  const match = content.match(/<!--thinking-->\n?([\s\S]*?)\n?<!--\/thinking-->\n?\n?([\s\S]*)/);
  if (!match) return { thinking: null, body: content };
  const thinking = match[1].trim();
  const body = match[2].trim();
  return { thinking: thinking || null, body: body || null };
}

function ThinkingBlock({ content }) {
  const [open, setOpen] = useState(false);
  if (!content) return null;
  const lines = content.split('\n').filter(Boolean);

  return (
    <div
      className="mb-2 rounded-lg overflow-hidden text-xs"
      style={{ backgroundColor: 'var(--c-surface-3)', border: `1px solid var(--c-border)` }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer"
        style={{ color: 'var(--c-text-secondary)' }}
      >
        <ChevronDown
          size={12}
          className="transition-transform"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
        <span className="font-medium">{open ? 'Hide' : 'Show'} thinking process</span>
        <span className="font-mono opacity-60 ml-auto">{lines.length} step{lines.length !== 1 ? 's' : ''}</span>
      </button>
      {open && (
        <div
          className="px-3 pb-2 space-y-1 font-mono"
          style={{ color: 'var(--c-text-secondary)' }}
        >
          {lines.map((line, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="opacity-40 flex-shrink-0 select-none">&gt;</span>
              <span className="break-all">{line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemMessage({ message }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex justify-center mb-4">
      <div
        className="max-w-[90%] w-full rounded-lg overflow-hidden text-xs"
        style={{ backgroundColor: 'var(--c-surface-2)', border: `1px solid var(--c-border)` }}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-4 py-2.5 cursor-pointer"
          style={{ color: 'var(--c-text-secondary)' }}
        >
          <GitBranch size={12} style={{ color: 'var(--c-accent)' }} />
          <span className="font-medium" style={{ color: 'var(--c-text)' }}>
            Forked from previous session
          </span>
          <ChevronDown
            size={12}
            className="ml-auto transition-transform"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
        </button>
        {expanded && (
          <div
            className="px-4 pb-3 text-sm leading-relaxed"
            style={{ color: 'var(--c-text-secondary)', borderTop: `1px solid var(--c-border)` }}
          >
            <div className="pt-3">
              <MarkdownContent content={message.content} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  if (message.role === 'system') return <SystemMessage message={message} />;

  const isUser = message.role === 'user';
  const { thinking, body } = isUser ? { thinking: null, body: message.content } : parseThinking(message.content);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className="max-w-[80%]">
        {!isUser && thinking && <ThinkingBlock content={thinking} />}
        {(body || isUser) && (
          <div
            className={`px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
              isUser
                ? 'rounded-xl rounded-br-sm text-white'
                : 'rounded-xl rounded-bl-sm'
            }`}
            style={{
              backgroundColor: isUser ? colors.accent : colors.surface2,
              color: isUser ? '#ffffff' : colors.text,
            }}
          >
            {isUser ? message.content : <MarkdownContent content={body} />}
          </div>
        )}
        {message.timestamp && (
          <div
            className={`text-[10px] font-mono mt-1 ${isUser ? 'text-right' : 'text-left'}`}
            style={{ color: 'var(--c-text-muted)' }}
          >
            {formatTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
}

function ModelSelector({ models, selectedModel, onChange, className = '', compact = false }) {
  if (!models || models.length === 0) return null;

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <select
        value={selectedModel}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none cursor-pointer outline-none font-mono uppercase ${
          compact
            ? 'text-xs bg-transparent pr-5 pl-1 py-1'
            : 'text-xs px-3 py-2 pr-7 rounded-lg'
        }`}
        style={{
          backgroundColor: compact ? 'transparent' : colors.surface2,
          borderColor: colors.border,
          borderWidth: compact ? 0 : 1,
          color: colors.textSecondary,
        }}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id} style={{ backgroundColor: colors.surface2 }}>
            {m.name}
          </option>
        ))}
      </select>
      <ChevronDown
        size={compact ? 12 : 14}
        className="absolute right-1 pointer-events-none"
        style={{ color: colors.textSecondary }}
      />
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start mb-3">
      <div
        className="px-3.5 py-2.5 rounded-xl rounded-bl-sm flex items-center gap-1"
        style={{ backgroundColor: 'var(--c-surface-2)' }}
      >
        <span className="typing-dot w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--c-text-secondary)', animation: 'typing 1.4s infinite both', animationDelay: '0s' }} />
        <span className="typing-dot w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--c-text-secondary)', animation: 'typing 1.4s infinite both', animationDelay: '0.2s' }} />
        <span className="typing-dot w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--c-text-secondary)', animation: 'typing 1.4s infinite both', animationDelay: '0.4s' }} />
        <style>{`
          @keyframes typing {
            0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
            30% { opacity: 1; transform: translateY(-4px); }
          }
        `}</style>
      </div>
    </div>
  );
}

export default function Workspace({
  session,
  messages = [],
  onSendMessage,
  onStop,
  onRequestAccess,
  isNewSession = false,
  onStartSession,
  onForkSession,
  onUploadFile,
  onTranscribe,
  models = [],
  hasAccess = true,
  busy = false,
  typing = false,
  wsConnected = false,
}) {
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(
    () => models.find((m) => m.default)?.id || models[0]?.id || ''
  );
  const [accessNote, setAccessNote] = useState('');
  const [showFork, setShowFork] = useState(false);
  const [forkText, setForkText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const userScrolledUpRef = useRef(false);

  const isRunning = session?.status === 'running';

  // Track if user has scrolled up
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 100;
  }, []);

  // Auto-scroll only when new messages arrive AND user hasn't scrolled up
  useEffect(() => {
    const newCount = messages?.length || 0;
    const hadNewMessages = newCount > prevMessageCountRef.current;
    prevMessageCountRef.current = newCount;

    if (hadNewMessages && !userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Update selected model when models prop changes
  useEffect(() => {
    if (models.length > 0 && !models.find((m) => m.id === selectedModel)) {
      setSelectedModel(models.find((m) => m.default)?.id || models[0]?.id);
    }
  }, [models]);

  // Auto-grow textarea
  const adjustTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, []);

  useEffect(() => {
    adjustTextarea();
  }, [inputText, adjustTextarea]);

  const addAttachment = useCallback((file) => {
    const isImage = file.type.startsWith('image/');
    const previewUrl = isImage ? URL.createObjectURL(file) : null;
    setAttachments((prev) => [...prev, { file, previewUrl, name: file.name, isImage, uploading: false, token: null }]);
  }, []);

  const removeAttachment = useCallback((index) => {
    setAttachments((prev) => {
      const item = prev[index];
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const uploadAttachments = useCallback(async () => {
    if (!onUploadFile || attachments.length === 0) return [];
    const results = await Promise.allSettled(
      attachments.map(async (att) => {
        if (att.token) return att.token;
        const result = await onUploadFile(att.file);
        return result?.token || null;
      })
    );
    return results.map((r) => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  }, [attachments, onUploadFile]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text && attachments.length === 0) return;
    // Upload any pending attachments — get tokens for backend to resolve file paths
    let imageTokens = [];
    if (attachments.length > 0) {
      imageTokens = await uploadAttachments();
    }
    if (!text && imageTokens.length === 0) return;
    const finalText = text || (imageTokens.length > 0 ? '[image attached]' : '');
    if (isNewSession && onStartSession) {
      onStartSession(finalText, selectedModel, imageTokens);
    } else if (onSendMessage) {
      onSendMessage(finalText, selectedModel, imageTokens);
    }
    // Clean up previews
    attachments.forEach((att) => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
    setAttachments([]);
    setInputText('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addAttachment(file);
      }
    }
  }, [addAttachment]);

  const handleRequestAccess = () => {
    onRequestAccess?.(accessNote);
    setAccessNote('');
  };

  const handleFileSelect = (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of files) {
      addAttachment(file);
    }
    e.target.value = '';
  };

  const handleMicToggle = async () => {
    if (recording) {
      // Stop recording
      mediaRecorderRef.current?.stop();
      return;
    }
    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const result = await onTranscribe(blob);
          if (result?.transcript) {
            setInputText((prev) => prev + (prev ? ' ' : '') + result.transcript);
          }
        } catch (err) {
          console.error('Transcription failed:', err);
        } finally {
          setTranscribing(false);
        }
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  };

  // --- Header ---
  const header = session ? (
    <div
      className="h-14 flex items-center justify-between px-4 sticky top-0 z-10 flex-shrink-0"
      style={{
        backgroundColor: colors.bg,
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div className="flex-1 min-w-0 mr-4">
        <span
          className="text-sm font-medium truncate block"
          style={{ color: colors.text }}
        >
          {session.task || 'Untitled session'}
        </span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {(session.owner_name || session.owner_email) && (
          <span
            className="text-[10px] px-2 py-0.5 rounded truncate max-w-[100px]"
            style={{ backgroundColor: colors.surface2, color: colors.textSecondary }}
            title={session.owner_name || session.owner_email}
          >
            {session.owner_name || session.owner_email}
          </span>
        )}
        <span
          className="font-mono text-xs"
          style={{ color: colors.textSecondary }}
        >
          {session.id}
        </span>
        {session.model && (
          <span
            className="uppercase text-[10px] font-mono px-2 py-0.5 rounded"
            style={{
              backgroundColor: colors.surface2,
              color: colors.textSecondary,
            }}
          >
            {session.model}
          </span>
        )}
        <StatusDot status={session.status} />
        {onForkSession && session.status !== 'running' && (
          <button
            onClick={() => setShowFork(true)}
            className="p-1 rounded cursor-pointer hover:opacity-80 transition-opacity"
            title="Fork session — start new session with same context"
          >
            <GitBranch size={14} style={{ color: colors.textSecondary }} />
          </button>
        )}
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: wsConnected ? 'var(--c-status-running)' : 'var(--c-text-secondary)' }}
          title={wsConnected ? 'Live connection' : 'Reconnecting...'}
        />
      </div>
    </div>
  ) : null;

  // --- New Session View ---
  const newSessionView = (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="text-center max-w-md w-full">
        <h1
          className="text-2xl font-bold mb-2"
          style={{ color: colors.text }}
        >
          What do you want to build?
        </h1>
        <p
          className="text-sm mb-6"
          style={{ color: colors.textSecondary }}
        >
          Start a new session to begin working with OliBot.
        </p>
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onChange={setSelectedModel}
          className="mb-4"
        />
      </div>
    </div>
  );

  // --- Messages View ---
  const messagesView = (
    <div
      ref={messagesContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4"
      style={{ backgroundColor: colors.bg }}
    >
      {messages.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm" style={{ color: colors.textSecondary }}>
            No messages yet.
          </p>
        </div>
      ) : (
        messages.map((msg, i) => <MessageBubble key={i} message={msg} />)
      )}
      {typing && <TypingIndicator />}
      <div ref={messagesEndRef} />
    </div>
  );

  // --- No Access Footer ---
  const noAccessFooter = (
    <div
      className="sticky bottom-0 flex-shrink-0 p-4"
      style={{
        backgroundColor: colors.bg,
        borderTop: `1px solid ${colors.border}`,
      }}
    >
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={accessNote}
          onChange={(e) => setAccessNote(e.target.value)}
          placeholder="Add a note (optional)"
          className="flex-1 text-sm px-3 py-2 rounded-lg outline-none"
          style={{
            backgroundColor: colors.surface2,
            border: `1px solid ${colors.border}`,
            color: colors.text,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRequestAccess();
          }}
        />
        <button
          onClick={handleRequestAccess}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white cursor-pointer"
          style={{ backgroundColor: colors.accent }}
        >
          <Lock size={14} />
          Request Access
        </button>
      </div>
    </div>
  );

  // --- Input Area ---
  const inputArea = (
    <div
      className="sticky bottom-0 flex-shrink-0 p-3"
      style={{
        backgroundColor: colors.bg,
        borderTop: `1px solid ${colors.border}`,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onChange={setSelectedModel}
          compact
        />
      </div>
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
          {attachments.map((att, i) => (
            <div
              key={i}
              className="relative flex-shrink-0 rounded-lg overflow-hidden group"
              style={{
                border: `1px solid ${colors.border}`,
                backgroundColor: colors.surface2,
              }}
            >
              {att.isImage ? (
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="h-16 w-16 object-cover"
                />
              ) : (
                <div className="h-16 w-16 flex flex-col items-center justify-center p-1">
                  <FileText size={20} style={{ color: colors.textSecondary }} />
                  <span
                    className="text-[9px] mt-1 truncate max-w-full text-center px-0.5"
                    style={{ color: colors.textSecondary }}
                  >
                    {att.name.length > 12 ? att.name.slice(0, 10) + '...' : att.name}
                  </span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(i)}
                className="absolute top-0.5 right-0.5 p-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
              >
                <X size={10} className="text-white" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className="flex items-end gap-2 rounded-xl p-2"
        style={{
          backgroundColor: colors.surface2,
          border: `1px solid ${colors.border}`,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="p-1.5 rounded-lg hover:opacity-80 flex-shrink-0 cursor-pointer disabled:opacity-50"
          title={uploading ? 'Uploading...' : 'Attach file'}
        >
          <Paperclip size={18} style={{ color: colors.textSecondary }} />
        </button>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            isRunning
              ? 'Session is currently running...'
              : 'Type a message...'
          }
          disabled={isRunning}
          rows={1}
          className="flex-1 bg-transparent outline-none text-sm resize-none leading-relaxed py-1"
          style={{
            color: colors.text,
            maxHeight: 200,
          }}
        />
        <button
          onClick={handleMicToggle}
          disabled={transcribing}
          className="p-1.5 rounded-lg hover:opacity-80 flex-shrink-0 cursor-pointer disabled:opacity-50"
          title={recording ? 'Stop recording' : transcribing ? 'Transcribing...' : 'Voice record'}
        >
          <Mic size={18} style={{ color: recording ? 'var(--c-danger, #ef4444)' : colors.textSecondary }} />
        </button>
        {isRunning ? (
          <button
            onClick={onStop}
            disabled={busy}
            className="p-1.5 rounded-full flex-shrink-0 cursor-pointer hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--c-danger)' }}
            title="Stop session"
          >
            <Square size={16} className="text-white" fill="white" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={(!inputText.trim() && attachments.length === 0) || busy}
            className="p-1.5 rounded-full flex-shrink-0 cursor-pointer transition-opacity disabled:cursor-not-allowed"
            style={{
              backgroundColor: (inputText.trim() || attachments.length > 0) && !busy ? colors.accent : colors.surface3,
              opacity: (inputText.trim() || attachments.length > 0) && !busy ? 1 : 0.5,
            }}
            title="Send message"
          >
            <ArrowUp
              size={16}
              style={{ color: (inputText.trim() || attachments.length > 0) && !busy ? '#ffffff' : colors.textSecondary }}
            />
          </button>
        )}
      </div>
    </div>
  );

  const forkDialog = showFork && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={() => setShowFork(false)}
    >
      <div
        className="w-full max-w-md mx-4 rounded-xl p-5"
        style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <GitBranch size={16} style={{ color: colors.accent }} />
          <h3 className="text-sm font-semibold" style={{ color: colors.text }}>
            Fork Session
          </h3>
        </div>
        <p className="text-xs mb-3" style={{ color: colors.textSecondary }}>
          Create a new session that shares the same Claude context as <span className="font-mono">{session?.id}</span>. The original session stays intact.
        </p>
        <textarea
          value={forkText}
          onChange={(e) => setForkText(e.target.value)}
          placeholder="What should the new session work on?"
          rows={3}
          className="w-full text-sm bg-transparent outline-none resize-none rounded-lg p-3 mb-3"
          style={{ color: colors.text, border: `1px solid ${colors.border}`, backgroundColor: colors.surface2 }}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && forkText.trim()) {
              e.preventDefault();
              onForkSession(forkText.trim(), selectedModel);
              setForkText('');
              setShowFork(false);
            }
          }}
        />
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={() => setShowFork(false)}
            className="text-xs px-3 py-1.5 rounded-md cursor-pointer"
            style={{ color: colors.textSecondary }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (!forkText.trim()) return;
              onForkSession(forkText.trim(), selectedModel);
              setForkText('');
              setShowFork(false);
            }}
            disabled={!forkText.trim() || busy}
            className="text-xs px-3 py-1.5 rounded-md font-medium text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: colors.accent }}
          >
            Fork & Start
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="flex flex-col h-full"
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {header}
      {isNewSession ? newSessionView : messagesView}
      {hasAccess ? inputArea : noAccessFooter}
      {forkDialog}
    </div>
  );
}
