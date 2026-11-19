import { describe, expect, it } from 'vitest';
import { chartVariables, contrast, labelColourOn, mix, toHex } from '../../src/renderer/diagram/chart-theme';
import type { DiagramPalette } from '../../src/renderer/diagram/protocol';

// The theme's own tokens (_tokens.scss), light and dark.
const LIGHT: DiagramPalette = {
  paper: '#FAF9F6', raised: '#F2F1EE', ink: '#34312E', inkStrong: '#201E1C', muted: '#6F6B66',
  hairline: '#DDD9D2', lineStrong: '#C9C3BB', accent: '#A85D3B',
  series: ['#A5562F', '#3E6187', '#4F7543', '#8C6514', '#7E4C6E', '#2E6E69', '#6E655B', '#5C5B9A'],
};
const DARK: DiagramPalette = {
  paper: '#1F1E1C', raised: '#292826', ink: '#D7D4CF', inkStrong: '#F1EEE8', muted: '#97928B',
  hairline: '#3B3935', lineStrong: '#5C584F', accent: '#E0A07A',
  series: ['#C98A63', '#7F98BC', '#8DA874', '#BE9B52', '#B489A8', '#6CA59E', '#A39A8D', '#9594C8'],
};

describe('the colours a chart is drawn in', () => {
  it('reads a token in any form it is written in', () => {
    expect(toHex('#AbC')).toBe('#aabbcc');
    expect(toHex(' #FAF9F6 ')).toBe('#faf9f6');
    expect(toHex('rgb(250, 249, 246)')).toBe('#faf9f6');
    expect(toHex('var(--x)')).toBeNull();
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('gives every series colour 4.5:1 against the paper, in both themes', () => {
    for (const palette of [LIGHT, DARK]) {
      for (const colour of palette.series) expect(contrast(colour, palette.paper)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('replaces mermaid\'s cream and yellow bars with the series', () => {
    const { xyChart } = chartVariables(LIGHT, false) as { xyChart: { plotColorPalette: string } };
    expect(xyChart.plotColorPalette.split(',')).toEqual(LIGHT.series);
    expect(xyChart.plotColorPalette).not.toMatch(/FFF4DD|FFD74D|FFFFF0/i);
  });

  it('fills every slice, with a label that reads on it', () => {
    for (const [palette, dark] of [[LIGHT, false], [DARK, true]] as const) {
      const variables = chartVariables(palette, dark);
      for (let slice = 1; slice <= 12; slice += 1) {
        const fill = variables[`pie${slice}`] as string;
        expect(fill).not.toBe(palette.paper);
        expect(contrast(variables.pieSectionTextColor as string, fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the ink readable on every tinted section, task and note', () => {
    for (const [palette, dark] of [[LIGHT, false], [DARK, true]] as const) {
      const variables = chartVariables(palette, dark);
      const grounds = [
        ...Array.from({ length: 12 }, (_, at) => variables[`cScale${at}`] as string),
        ...Array.from({ length: 8 }, (_, at) => variables[`fillType${at}`] as string),
        variables.taskBkgColor, variables.activeTaskBkgColor, variables.critBkgColor, variables.noteBkgColor,
        variables.quadrant1Fill, variables.quadrant2Fill, variables.quadrant3Fill, variables.quadrant4Fill, variables.faceColor,
      ] as string[];
      for (const ground of grounds) expect(contrast(palette.ink, ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('rules a timeline section in its own hue, not mermaid\'s complement', () => {
    const variables = chartVariables(LIGHT, false);
    for (let at = 0; at < 8; at += 1) {
      expect(variables[`cScaleInv${at}`]).toBe(LIGHT.series[at]);
      expect(variables[`lineColor${at}`]).toBe(LIGHT.series[at]);
    }
  });

  it('sets a label in whichever ink reads on a fill a note chose itself', () => {
    // The vault's commonest classDef fills, under the dark theme's light ink.
    for (const pastel of ['#fff3e0', '#e3f2fd', '#ffffde', '#e8f5e9']) {
      const ink = labelColourOn(pastel, DARK.ink, [DARK.inkStrong, DARK.paper]);
      expect(ink).toBe(DARK.paper);
      expect(contrast(ink, pastel)).toBeGreaterThanOrEqual(4.5);
    }
    // A label that already reads is left alone.
    expect(labelColourOn(LIGHT.raised, LIGHT.ink, [LIGHT.inkStrong, LIGHT.paper])).toBe(LIGHT.ink);
  });
});
