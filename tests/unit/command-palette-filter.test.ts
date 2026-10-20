import { describe, expect, it } from 'vitest';
import { filterPaletteCommands } from '../../src/renderer/command-palette-filter';

const commands = [
  { title: 'Export PDF…', source: 'File' },
  { title: 'Export HTML…', source: 'File' },
  { title: 'Demote a level', source: 'Title Shift' },
];

describe('filterPaletteCommands', () => {
  it('keeps everything, in order, for an empty or blank query', () => {
    expect(filterPaletteCommands(commands, '')).toEqual(commands);
    expect(filterPaletteCommands(commands, '   ')).toEqual(commands);
  });

  it('matches every word, in any order and any case, across title and source', () => {
    expect(filterPaletteCommands(commands, 'pdf').map((c) => c.title)).toEqual(['Export PDF…']);
    expect(filterPaletteCommands(commands, 'PDF export').map((c) => c.title)).toEqual(['Export PDF…']);
    expect(filterPaletteCommands(commands, 'shift demote').map((c) => c.title)).toEqual(['Demote a level']);
    expect(filterPaletteCommands(commands, 'file').map((c) => c.title)).toEqual(['Export PDF…', 'Export HTML…']);
  });

  it('returns nothing when a word matches nothing', () => {
    expect(filterPaletteCommands(commands, 'export zzz')).toEqual([]);
  });
});
