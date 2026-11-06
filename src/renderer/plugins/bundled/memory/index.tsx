/**
 * Memory in Note Info, as a bundled plugin: Related and Activity, and the
 * reads on the timeline.
 *
 * Built from the info slot and `vault.read`, the open folder's memory as
 * `@roobli/vault` holds it. In a folder without memory the tabs say so and
 * nothing is written.
 */

import type { TrustedPlugin } from '../index';
import type { InfoTrack, ShellContext } from '../../slots';
import { mountActivity, mountRelated } from './MemoryTabs';
import { readMarks, times } from './model';

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
    return () => { for (const stop of stops) stop(); };
  }
}
