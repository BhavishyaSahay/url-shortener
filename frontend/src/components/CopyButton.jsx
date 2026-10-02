import { useState } from 'react';

export default function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    // The Clipboard API only exists on HTTPS (or localhost). The production site
    // is plain HTTP for now, so fall back to a prompt the user can copy from.
    if (!navigator.clipboard) {
      window.prompt('Copy this link:', text);
      return;
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button className="secondary small" onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
