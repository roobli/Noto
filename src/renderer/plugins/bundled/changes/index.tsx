/**
 * The Changes page, as a bundled plugin.
 *
 * It is the first user of the rail slot and is built only from what the slot
 * offers a plugin: a page in the rail, the `git.read` service, and the host's
 * way to open a note. Anything it needed and could not get is a gap in the
 * slot, to be filled there rather than worked around here.
 */

import { createRoot } from 'react-dom/client';
import type { TrustedPlugin } from '../index';
import type { ShellContext } from '../../slots';
import { ChangesPage } from './ChangesPage';

/** A dot with a ring: something changed. Stroked like the rail's other icons. */
const ICON = 'M8 2.75v3M8 10.25v3M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z';

export class ChangesPlugin implements TrustedPlugin {
  /** Nothing in the editor: the page is all of it. */
  activate(): () => void {
    return () => {};
  }

  shell(context: ShellContext): () => void {
    const page = context.registerRailPage({
      id: 'changes',
      title: 'Changes',
      icon: ICON,
      mount(element, host) {
        const root = createRoot(element);
        root.render(<ChangesPage host={host} />);
        return () => root.unmount();
      },
    });
    const git = context.git;
    const host = context.host;
    const count = () => {
      const marks = git?.current();
      const live = marks && marks.root !== null && marks.root === host.folder() ? marks.files.length : 0;
      page.setBadge(live > 0 ? (live > 999 ? '999+' : String(live)) : null);
    };
    count();
    const stopGit = git?.subscribe(count) ?? (() => {});
    const stopHost = host.subscribe(count);
    return () => {
      stopGit();
      stopHost();
      page.dispose();
    };
  }
}
