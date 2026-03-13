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

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className="max-w-[80%]">
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
          {isUser ? message.content : <MarkdownContent content={message.content} />}
        </div>
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

export default function Workspace({
  session,
  messages = [],
  onSendMessage,
  onStop,
  onRequestAccess,
  isNewSession = false,
  onStartSession,
  onUploadFile,
  onTranscribe,
  models = [],
  hasAccess = true,
}) {
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(
    () => models.find((m) => m.default)?.id || models[0]?.id || ''
  );
  const [accessNote, setAccessNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
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

  const handleSend = () => {
    const text = inputText.trim();
    if (!text) return;
    if (isNewSession && onStartSession) {
      onStartSession(text, selectedModel);
    } else if (onSendMessage) {
      onSendMessage(text, selectedModel);
    }
    setInputText('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRequestAccess = () => {
    onRequestAccess?.(accessNote);
    setAccessNote('');
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !onUploadFile) return;
    setUploading(true);
    try {
      const result = await onUploadFile(file);
      if (result?.token) {
        setInputText((prev) => prev + (prev ? '\n' : '') + `[file: ${file.name}] ${result.token}`);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
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
            className="p-1.5 rounded-full flex-shrink-0 cursor-pointer hover:opacity-80"
            style={{ backgroundColor: 'var(--c-danger)' }}
            title="Stop session"
          >
            <Square size={16} className="text-white" fill="white" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            className="p-1.5 rounded-full flex-shrink-0 cursor-pointer transition-opacity"
            style={{
              backgroundColor: inputText.trim() ? colors.accent : colors.surface3,
              opacity: inputText.trim() ? 1 : 0.5,
            }}
            title="Send message"
          >
            <ArrowUp
              size={16}
              style={{ color: inputText.trim() ? '#ffffff' : colors.textSecondary }}
            />
          </button>
        )}
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
    </div>
  );
}
