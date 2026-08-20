import { useCallback, useRef, useState } from 'react';

// Attachment state for one composer surface (the chat input, the fork dialog, …).
// Each surface calls this separately: sharing a single list would let a file
// staged in the fork dialog ride along on the next chat message, and vice versa.
export function useAttachments(onUploadFile) {
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);

  const add = useCallback((file) => {
    const isImage = file.type.startsWith('image/');
    const previewUrl = isImage ? URL.createObjectURL(file) : null;
    setAttachments((prev) => [...prev, { file, previewUrl, name: file.name, isImage, uploading: false, token: null }]);
  }, []);

  const remove = useCallback((index) => {
    setAttachments((prev) => {
      const item = prev[index];
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((att) => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
      return [];
    });
  }, []);

  // Uploads everything staged and returns { token, url, name, isImage } per file.
  // Tokens go to the agent, urls are embedded in the message so the attachment
  // stays visible in the transcript afterwards.
  const uploadAll = useCallback(async () => {
    if (!onUploadFile || attachments.length === 0) return [];
    const results = await Promise.allSettled(
      attachments.map(async (att) => {
        if (att.token) return { token: att.token, url: att.url, name: att.name, isImage: att.isImage };
        const result = await onUploadFile(att.file);
        return result?.token ? { token: result.token, url: result.url, name: att.name, isImage: att.isImage } : null;
      })
    );
    return results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  }, [attachments, onUploadFile]);

  // Paste handler — a screenshot on the clipboard arrives as a file item.
  const onPaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) add(file);
      }
    }
  }, [add]);

  const onFileSelect = useCallback((e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of files) add(file);
    e.target.value = '';
  }, [add]);

  const openPicker = useCallback(() => fileInputRef.current?.click(), []);

  return { attachments, add, remove, clear, uploadAll, onPaste, onFileSelect, openPicker, fileInputRef };
}

// Turns uploaded files into the markdown appended to the message, so images keep
// rendering in the chat after the upload tokens are consumed.
export function attachmentMarkdown(uploaded) {
  return uploaded
    .filter((u) => u.url)
    .map((u) => (u.isImage ? `![${u.name || 'image'}](${u.url})` : `[📎 ${u.name || 'file'}](${u.url})`))
    .join('\n');
}
