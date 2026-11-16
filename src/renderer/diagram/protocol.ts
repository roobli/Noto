/** What crosses between the editor and the diagram frame, and nothing more. */

export interface DiagramPalette {
  readonly paper: string;
  readonly raised: string;
  readonly ink: string;
  readonly inkStrong: string;
  readonly muted: string;
  readonly hairline: string;
  readonly lineStrong: string;
  readonly accent: string;
  /** The chart series, `--chart-1` onwards: bars, lines, slices, branches. */
  readonly series: readonly string[];
}

export interface DiagramRequest {
  readonly type: 'noto-diagram-render';
  readonly serial: number;
  readonly source: string;
  readonly palette: DiagramPalette;
  readonly dark: boolean;
  readonly font: string;
}

export type DiagramReply =
  | { readonly type: 'noto-diagram-ready' }
  | { readonly type: 'noto-diagram-rendered'; readonly serial: number; readonly width: number; readonly height: number }
  | { readonly type: 'noto-diagram-failed'; readonly serial: number; readonly message: string };
