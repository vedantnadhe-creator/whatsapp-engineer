import { FileText, X } from 'lucide-react';

const colors = {
  border: 'var(--c-border)',
  surface2: 'var(--c-surface-2)',
  textSecondary: 'var(--c-text-secondary)',
};

// Thumbnails for files staged in a composer, with a hover remove button.
// Shared by the chat input and the fork dialog so both look and behave alike.
export default function AttachmentStrip({ attachments, onRemove, className = 'mb-2' }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className={`flex gap-2 overflow-x-auto pb-1 ${className}`}>
      {attachments.map((att, i) => (
        <div
          key={i}
          className="relative flex-shrink-0 rounded-lg overflow-hidden group"
          style={{ border: `1px solid ${colors.border}`, backgroundColor: colors.surface2 }}
        >
          {att.isImage ? (
            <img src={att.previewUrl} alt={att.name} className="h-16 w-16 object-cover" />
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
            type="button"
            onClick={() => onRemove(i)}
            aria-label={`Remove ${att.name}`}
            className="absolute top-0.5 right-0.5 p-0.5 rounded-full opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
          >
            <X size={10} className="text-white" />
          </button>
        </div>
      ))}
    </div>
  );
}
