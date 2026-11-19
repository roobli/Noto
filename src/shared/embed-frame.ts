/**
 * The name the editor gives every frame it draws a note's embedded page in.
 * The main process reads it to tell that frame from the app's own frames: it
 * alone may follow links on the web.
 */
export const EMBED_FRAME_NAME = 'noto-embed';

/**
 * The name of the frame the code viewer draws a local web page in. It may
 * move between the open folder's pages (`noto-page:`), and the frames the
 * page makes may follow the web, as an embed's do.
 */
export const PAGE_FRAME_NAME = 'noto-page';
