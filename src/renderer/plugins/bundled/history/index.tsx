/**
 * History and Properties, as a bundled plugin: the info pane's first tabs.
 *
 * Built only from what the info slot offers (`plugins/slots.ts`): two tabs,
 * a track of commits on the pane's timeline, `git.read` for the history and
 * versions, `editor.read` for the note as it stands and `editor.transform` to
 * take a version back. Anything it needed and could not get is a gap in the
 * slot, to be filled there.
 */

import type { TrustedPlugin } from '../index';
import type { InfoTrack, ShellContext } from '../../slots';
import { mountHistory } from './HistoryTab';
import { mountProperties } from './PropertiesTab';
import { commitsSummary, when } from './model';

export class HistoryPlugin implements TrustedPlugin {
  /** Nothing in the editor: the pane is all of it. */
  activate(): () => void {
    return () => {};
  }

  shell(context: ShellContext): () => void {
    const git = context.git;
    const stops = [
      context.registerInfoTab({ id: 'history', title: 'History', order: 20, mount: mountHistory }),
      context.registerInfoTab({ id: 'properties', title: 'Properties', order: 40, mount: mountProperties }),
      context.registerInfoTrack({
        id: 'commits',
        title: 'Commits',
        order: 20,
        tab: 'history',
        async load(note): Promise<InfoTrack | null> {
          const history = await git?.history(note);
          if (!history || (history.state !== 'ok' && history.state !== 'untracked')) return null;
          return {
            kind: 'events',
            marks: history.commits.map((commit) => ({
              at: commit.time,
              label: `${when(commit.time)}: ${commit.subject || '(no message)'}`,
              key: commit.hash,
              faint: commit.tooling || commit.sweeping,
            })),
            pending: history.uncommitted ? { label: 'Changes not committed', key: 'uncommitted' } : null,
            summary: commitsSummary(history.commits, history.more),
          };
        },
        changes: (listener) => git?.subscribe(listener) ?? (() => {}),
      }),
    ];
    return () => { for (const stop of stops) stop(); };
  }
}
