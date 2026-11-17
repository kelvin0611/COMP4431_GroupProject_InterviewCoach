import { useState } from 'react';
import { Copy, Sparkles } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import type { Language, PolishedAnswer } from '../lib/types';

interface PolishPanelProps {
  sessionId: string;
  turnId: string;
}

/** Rewrites one saved answer as a STAR answer, in English or Cantonese, without new facts. */
export function PolishPanel({ sessionId, turnId }: PolishPanelProps) {
  const [target, setTarget] = useState<Language>('en-HK');
  const [result, setResult] = useState<PolishedAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const selectId = `polish-language-${turnId}`;

  async function rewrite() {
    setLoading(true);
    setError('');
    setCopied(false);
    try {
      setResult(await api.polish(sessionId, turnId, target));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.parts.map((part) => part.text).join(' '));
      setCopied(true);
    } catch {
      setError('Copying is not available in this browser. Select the text instead.');
    }
  }

  return (
    <div className="polish">
      <div className="polish-controls">
        <label htmlFor={selectId}>Rewrite in</label>
        <select
          id={selectId}
          value={target}
          disabled={loading}
          onChange={(event) => setTarget(event.target.value as Language)}
        >
          <option value="en-HK">English</option>
          <option value="zh-HK">廣東話</option>
        </select>
        <button
          type="button"
          className="button small secondary"
          disabled={loading}
          onClick={() => void rewrite()}
        >
          <Sparkles size={15} /> {loading ? 'Rewriting…' : 'Show a stronger version'}
        </button>
      </div>
      {error && (
        <p className="polish-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <section className="polish-result" aria-label="Stronger version">
          <ol>
            {result.parts.map((part) => (
              <li key={part.element} className={`star-${part.element.toLowerCase()}`}>
                <span className="polish-element">{part.element}</span>
                <span
                  className={part.placeholder ? 'placeholder' : undefined}
                  lang={result.target_language === 'zh-HK' ? 'zh-HK' : 'en'}
                >
                  {part.text}
                </span>
              </li>
            ))}
          </ol>
          <div className="polish-footer">
            <p>
              {result.provider === 'demo'
                ? 'Demo provider: your own sentences are quoted, not rewritten.'
                : 'Uses only what you said. Fill in the bracketed parts yourself.'}
            </p>
            <button type="button" className="text-button" onClick={() => void copy()}>
              <Copy size={14} /> {copied ? 'Copied' : 'Copy text'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
