/**
 * Memory, as a bundled plugin: Related and Activity in Note Info, the reads
 * on its timeline, and the Review page in the rail.
 *
 * Built from the info and rail slots, `vault.read` (the open folder's memory
 * as `@roobli/vault` holds it) and `vault.review` (its queue, and the writes
 * that settle it). In a folder without memory the tabs say so and nothing is
 * written.
 */

import { createRoot } from 'react-dom/client';
import type { TrustedPlugin } from '../index';
import type { InfoTrack, ShellContext } from '../../slots';
import { mountActivity, mountRelated } from './MemoryTabs';
import { readMarks, times } from './model';
import { ReviewPage } from './ReviewPage';

/** Lines of a list with a tick beside the last: things to go through. Stroked like the rail's other icons. */
const REVIEW_ICON = 'M2.75 4.25h7.5M2.75 8h5M2.75 11.75h3.5M9.25 11l1.75 1.75 3.25-3.75';

/** How long after the window opens the badge is first counted, so a memory folder opening does not compete with it. */
const FIRST_COUNT_MS = 2_000;

export class MemoryPlugin implements TrustedPlugin {
  activate(): () => void {
    return () => {};
  }

  shell(context: ShellContext): () => void {
    const vault = context.host.vault;
    const stops = [
      context.registerInfoTab({ id: 'related', title: 'Related', order: 10, mount: mountRelated }),
      context.registerInfoTab({ id: 'activity', title: 'Activity', order: 30, mount: mountActivity }),
      context.registerInfoTrack({
        id: 'reads',
        title: 'Reads',
        order: 10,
        tab: 'activity',
        async load(note): Promise<InfoTrack | null> {
          const answer = await vault?.about(note);
          if (answer?.state !== 'ok' || !answer.memory) return null;
          const total = answer.memory.reads.reduce((sum, day) => sum + day.count, 0);
          return {
            kind: 'amounts',
            marks: readMarks(answer.memory.reads),
            summary: total > 0 ? `read ${times(total)}` : undefined,
          };
        },
        changes: (listener) => vault?.subscribe(listener) ?? (() => {}),
      }),
    ];
    const review = context.host.review;
    if (review) {
      const page = context.registerRailPage({
        id: 'review',
        title: 'Review',
        icon: REVIEW_ICON,
        mount(element, host) {
          const root = createRoot(element);
          root.render(<ReviewPage host={host} />);
          return () => root.unmount();
        },
      });
      // What waits on the person: proposals from agents, and links that are always right to fix.
      // The mentions are many and optional, and counting them takes seconds, so they are not in it.
      let asked = 0;
      const count = () => {
        const mine = ++asked;
        void review.ask({ kind: 'summary', counted: ['stale'] }).then((answer) => {
          if (mine !== asked) return;
          const value = answer.state === 'ok' ? answer.value : null;
          const waiting = value ? value.proposals.length + (value.counts.stale ?? 0) : 0;
          page.setBadge(waiting > 0 ? (waiting > 999 ? '999+' : String(waiting)) : null);
        }, () => {});
      };
      const first = setTimeout(count, FIRST_COUNT_MS);
      const stopReview = review.subscribe(count);
      const stopHost = context.host.subscribe(count);
      stops.push(() => { clearTimeout(first); stopReview(); stopHost(); page.dispose(); });
    }
    return () => { for (const stop of stops) stop(); };
  }
}
