/**
 * In-app Developer Console sheet (`Option+Command+I` / `Ctrl+Alt+I`, or
 * View -> Developer Console).
 *
 * Production builds keep Chromium DevTools disabled (`devTools: false`), so the
 * author still needs a clean, read-only window into renderer console messages
 * (including diagram syntax/render warnings) and main-process structured events
 * (`main.ndjson`). Nothing can be evaluated here: it only inspects, filters, and
 * copies diagnostic output.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  NOTO_WORKSPACE_VERSION,
  type WorkspaceDebugConsoleEntryV1,
  type WorkspaceDebugLogEntryV1,
} from '../shared/workspace/v1/contracts';
import { SheetWidthHint, stepSheetWidth, type SheetWidthControl } from './sheet-width';

interface DebugConsoleProps {
  readonly onClose: () => void;
  readonly sheet?: SheetWidthControl;
}

type FeedTab = 'console' | 'main';
type ConsoleFilter = 'all' | 'issues';

function levelBadge(level: number): { readonly label: string; readonly tone: 'error' | 'warn' | 'info' } {
  if (level >= 3) return { label: 'ERR', tone: 'error' };
  if (level === 2) return { label: 'WARN', tone: 'warn' };
  return { label: 'LOG', tone: 'info' };
}

function shortTime(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/.exec(iso);
  return match ? match[1]! : iso.slice(0, 19);
}

export function DebugConsole({ onClose, sheet }: DebugConsoleProps) {
  const [tab, setTab] = useState<FeedTab>('console');
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [query, setQuery] = useState('');
  const [consoleEntries, setConsoleEntries] = useState<readonly WorkspaceDebugConsoleEntryV1[]>([]);
  const [logEntries, setLogEntries] = useState<readonly WorkspaceDebugLogEntryV1[]>([]);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadFeed = useCallback(async () => {
    const reply = await window.notoWorkspace.debugFeed({
      version: NOTO_WORKSPACE_VERSION,
      requestId: `debug-feed:${crypto.randomUUID()}`,
    });
    if (!reply.ok) return;
    setConsoleEntries(reply.value.consoleEntries);
    setLogEntries(reply.value.logEntries);
  }, []);

  useEffect(() => {
    void loadFeed();
    const timer = window.setInterval(() => { void loadFeed(); }, 2000);
    return () => window.clearInterval(timer);
  }, [loadFeed]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const needle = query.trim().toLowerCase();

  const visibleConsole = useMemo(() => {
    return [...consoleEntries]
      .reverse()
      .filter((entry) => {
        if (entry.noise && filter === 'issues') return false;
        if (filter === 'issues' && entry.level < 2) return false;
        if (!needle) return true;
        return entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle);
      });
  }, [consoleEntries, filter, needle]);

  const visibleLogs = useMemo(() => {
    return [...logEntries]
      .reverse()
      .filter((entry) => {
        if (!needle) return true;
        return entry.event.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle);
      });
  }, [logEntries, needle]);

  const issueCount = useMemo(
    () => consoleEntries.filter((entry) => !entry.noise && entry.level >= 2).length,
    [consoleEntries],
  );

  const copyVisible = () => {
    const text = tab === 'console'
      ? visibleConsole
          .map((e) => `${shortTime(e.timestamp)} [${levelBadge(e.level).label}] ${e.source ? `${e.source}:${e.line} ` : ''}${e.message}`)
          .join('\n')
      : visibleLogs
          .map((e) => `${shortTime(e.timestamp)} ${e.event}${e.summary ? ` ${e.summary}` : ''}`)
          .join('\n');
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div
      className="guide-scrim"
      data-testid="debug-console-scrim"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <section
        className="debug-console"
        data-sheet-width={sheet?.width}
        role="dialog"
        aria-label="Developer Console"
        data-testid="debug-console"
        onKeyDown={(event) => { stepSheetWidth(event, sheet); }}
      >
        <header className="debug-console-head">
          <h2>Developer Console</h2>
          <div className="debug-console-tabs" role="tablist" aria-label="Diagnostic sources">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'console'}
              className={tab === 'console' ? 'is-active' : undefined}
              data-testid="debug-tab-console"
              onClick={() => setTab('console')}
            >
              Renderer &amp; Diagrams ({consoleEntries.length}{issueCount > 0 ? ` · ${issueCount} warn/err` : ''})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'main'}
              className={tab === 'main' ? 'is-active' : undefined}
              data-testid="debug-tab-main"
              onClick={() => setTab('main')}
            >
              Main Events ({logEntries.length})
            </button>
          </div>
          {tab === 'console' && (
            <div className="debug-console-tabs" role="group" aria-label="Severity filter">
              <button
                type="button"
                className={filter === 'all' ? 'is-active' : undefined}
                onClick={() => setFilter('all')}
              >
                All
              </button>
              <button
                type="button"
                className={filter === 'issues' ? 'is-active' : undefined}
                data-testid="debug-filter-issues"
                onClick={() => setFilter('issues')}
              >
                Warn &amp; Error
              </button>
            </div>
          )}
          <input
            ref={searchRef}
            type="search"
            className="shortcuts-search debug-console-search"
            data-testid="debug-console-search"
            placeholder={tab === 'console' ? 'Filter console or [diagram] messages…' : 'Filter event name or payload…'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="pref-close" onClick={() => void loadFeed()}>Refresh</button>
          <button type="button" className="pref-close" data-testid="debug-console-copy" onClick={copyVisible}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="pref-close" data-testid="debug-console-close" onClick={onClose}>Done</button>
        </header>

        <div className="debug-console-body" data-testid="debug-console-body">
          {tab === 'console' ? (
            visibleConsole.length === 0 ? (
              <p className="debug-console-empty">No matching console messages in this session.</p>
            ) : (
              visibleConsole.map((entry, idx) => {
                const badge = levelBadge(entry.level);
                return (
                  <div key={`${entry.timestamp}-${idx}`} className="debug-console-row" data-tone={badge.tone}>
                    <span className="debug-console-meta">
                      <span className="debug-console-time">{shortTime(entry.timestamp)}</span>
                      <span className="debug-console-badge" data-tone={badge.tone}>{badge.label}</span>
                      {entry.source && (
                        <span className="debug-console-src">
                          {entry.source}{entry.line > 0 ? `:${entry.line}` : ''}
                        </span>
                      )}
                    </span>
                    <pre className="debug-console-msg">{entry.message}</pre>
                  </div>
                );
              })
            )
          ) : visibleLogs.length === 0 ? (
            <p className="debug-console-empty">No matching main-process events.</p>
          ) : (
            visibleLogs.map((entry, idx) => (
              <div key={`${entry.timestamp}-${idx}`} className="debug-console-row" data-tone="info">
                <span className="debug-console-meta">
                  <span className="debug-console-time">{shortTime(entry.timestamp)}</span>
                  <span className="debug-console-event">{entry.event}</span>
                </span>
                {entry.summary && <pre className="debug-console-msg">{entry.summary}</pre>}
              </div>
            ))
          )}
        </div>

        <footer className="shortcuts-foot">
          <span>Read-only session diagnostics (newest first, auto-refreshes every 2s)</span>
          <SheetWidthHint control={sheet} />
        </footer>
      </section>
    </div>
  );
}
