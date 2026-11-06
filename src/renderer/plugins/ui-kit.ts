/**
 * The pieces of the shell's own interface a trusted plugin may draw with, so a
 * page a plugin puts in the rail reads as part of the same product. Markup and
 * class names here are part of the slot contract (docs/architecture/plugin-slots.md):
 * `tree-level`, `tree-node`, `tree-row`, `tree-leading`, `tree-twisty`,
 * `tree-name` and `rail-empty`, with `sizeTreeGuides` to draw the connectors.
 */

export { FileGlyph, FolderGlyph, GitMark } from '../FileTree';
export { sizeTreeGuides } from '../tree-guides';
