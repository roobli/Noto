import type { NotoDesktopApi } from '../shared/ipc/contracts';
import type { NotoFileTruthApiV1 } from '../shared/file-truth/v1/contracts';
import type { NotoWorkspaceApiV1 } from '../shared/workspace/v1/contracts';
import type { NotoSettingsApiV1 } from '../shared/settings/v1/contracts';
import type { NotoAssetsApiV1 } from '../shared/assets/v1/contracts';
import type { NotoUpdatesApiV1 } from '../shared/updates/v1/contracts';

declare global {
  interface Window {
    notoDesktop: NotoDesktopApi;
    notoFileTruth: NotoFileTruthApiV1;
    notoWorkspace: NotoWorkspaceApiV1;
    notoSettings: NotoSettingsApiV1;
    notoAssets: NotoAssetsApiV1;
    notoUpdates: NotoUpdatesApiV1;
    notoPlatform: { readonly home: string };
  }
}

export {};
