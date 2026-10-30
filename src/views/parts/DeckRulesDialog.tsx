import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { DECK_PROMPT } from '../../io/deckPrompt';

/** Shows the rules for a good deck as a prompt to copy into an AI chat. */
export function DeckRulesDialog({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(DECK_PROMPT);
      setCopied(true);
    } catch {
      // The browser blocked the clipboard, so select the text for copying by hand.
      promptRef.current?.select();
    }
  }

  return (
    <Modal title="rules for deck creation" onClose={onClose}>
      <div className="window-body">
        <ol className="steps">
          <li>Copy the prompt.</li>
          <li>Paste it into an AI chat and fill in the topic at the end.</li>
          <li>Import the file it gives you.</li>
        </ol>
        <textarea
          ref={promptRef}
          className="prompt-box"
          readOnly
          value={DECK_PROMPT}
          aria-label="Prompt for the AI"
        />
        <p className="window-note">
          AIs get facts wrong sometimes, so check a few answers. If the import fails, paste the error back into the
          same chat.
        </p>
      </div>
      <div className="window-actions">
        <button type="button" className="btn" onClick={onClose}>
          close
        </button>
        <button type="button" className="btn btn-primary" onClick={copy} data-autofocus>
          {copied ? 'copied' : 'copy prompt'}
        </button>
      </div>
    </Modal>
  );
}
