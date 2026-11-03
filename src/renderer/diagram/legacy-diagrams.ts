/**
 * Typora's two older diagram fences, read as mermaid.
 *
 * Typora draws ```sequence with js-sequence-diagrams and ```flow with
 * flowchart.js, and notes written in Typora use both. Rather than carry those
 * two libraries and their Raphael dependency into the sandboxed frame, each
 * fence is rewritten as the mermaid diagram that says the same thing, so it is
 * drawn by the frame that already draws mermaid, in the theme's own palette.
 * The fence keeps its text; this only decides what is drawn.
 *
 * Pure text in and text out, so it is tested without a frame.
 */

export type DiagramDialect = 'mermaid' | 'flow' | 'sequence';

export type MermaidSource = { readonly source: string } | { readonly error: string };

/** The dialect a fence's language names, or null when it is not a diagram. */
export function diagramDialect(lang: string): DiagramDialect | null {
  const name = lang.trim().toLowerCase();
  return name === 'mermaid' || name === 'flow' || name === 'sequence' ? name : null;
}

/** The mermaid source for a fence of this dialect, or why it cannot be read. */
export function toMermaid(dialect: DiagramDialect, source: string): MermaidSource {
  if (dialect === 'flow') return flowToMermaid(source);
  if (dialect === 'sequence') return sequenceToMermaid(source);
  return { source };
}

/**
 * Text as mermaid will print it. `#` opens an entity code and `;` ends a
 * statement, so both are written as entities, in one pass: replacing one and
 * then the other rewrote the `;` that ends the first one's entity.
 */
function text(value: string): string {
  return value.replace(/[#;]/g, (character) => (character === '#' ? '#35;' : '#59;'));
}

/** Message and note text: js-sequence-diagrams breaks a line at `\n`. */
function message(value: string): string {
  return text(value).replace(/\\n/g, '<br/>');
}

/** Text inside a quoted label, where the quote itself has to be an entity too. */
function quoted(value: string): string {
  return `"${text(value).replace(/"/g, '#quot;')}"`;
}

/*
 * js-sequence-diagrams draws `->` and `-->` with a filled head and `->>` and
 * `-->>` with an open one. Mermaid's filled-head messages are `->>` and
 * `-->>`, and its open-head ones are `-)` and `--)`.
 */
const SEQUENCE_ARROWS: Readonly<Record<string, string>> = {
  '->': '->>',
  '-->': '-->>',
  '->>': '-)',
  '-->>': '--)',
};

/**
 * A js-sequence-diagrams fence as a mermaid sequence diagram.
 *
 * Every actor is declared with an alias, in the order it first appears, which
 * is the order js-sequence-diagrams lays them out in. The alias is what lets a
 * name hold spaces or punctuation mermaid would otherwise read as syntax.
 */
export function sequenceToMermaid(source: string): MermaidSource {
  const ids = new Map<string, string>();
  const participants: string[] = [];
  const body: string[] = [];
  let title: string | null = null;

  const actor = (raw: string, shown?: string): string => {
    const name = raw.trim().replace(/^"(.*)"$/, '$1');
    let id = ids.get(name);
    if (id === undefined) {
      id = `a${ids.size}`;
      ids.set(name, id);
      participants.push(`  participant ${id} as ${text((shown ?? name).trim().replace(/^"(.*)"$/, '$1'))}`);
    }
    return id;
  };

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '' || line.startsWith('#')) continue;

    const heading = /^title\s*:\s*(.*)$/i.exec(line);
    if (heading) {
      title = heading[1]!.trim();
      continue;
    }

    // `participant Name as alias`: signals use the alias, the box shows the name.
    const declared = /^participant\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line);
    if (declared) {
      if (declared[2] !== undefined) actor(declared[2], declared[1]);
      else actor(declared[1]!);
      continue;
    }

    const note = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/i.exec(line);
    if (note) {
      const who = note[2]!.split(',').map((name) => actor(name)).join(',');
      body.push(`  Note ${note[1]!.toLowerCase()} ${who}: ${message(note[3]!.trim())}`);
      continue;
    }

    // Longest arrow first, so `-->>` is not read as `->` followed by text.
    const signal = /^(.+?)\s*(-->>|->>|-->|->)\s*([^:]+?)\s*(?::\s*(.*))?$/.exec(line);
    // One arrow to a line; js-sequence-diagrams reads a second as an error,
    // not as part of a name.
    if (signal && !signal[3]!.includes('->')) {
      const from = actor(signal[1]!);
      const to = actor(signal[3]!);
      body.push(`  ${from}${SEQUENCE_ARROWS[signal[2]!]}${to}: ${message((signal[4] ?? '').trim())}`);
      continue;
    }

    return { error: `line ${index + 1} is not sequence syntax: ${line}` };
  }

  return {
    source: ['sequenceDiagram', ...(title !== null ? [`  title ${text(title)}`] : []), ...participants, ...body].join('\n'),
  };
}

type FlowShape = 'start' | 'end' | 'operation' | 'inputoutput' | 'subroutine' | 'condition' | 'parallel';

/** Each flowchart.js symbol as the mermaid shape that reads the same way. */
function shape(kind: FlowShape, label: string): string {
  const inner = quoted(label);
  switch (kind) {
    case 'start':
    case 'end':
      return `([${inner}])`;
    case 'inputoutput':
      return `[/${inner}/]`;
    case 'subroutine':
      return `[[${inner}]]`;
    case 'condition':
      return `{${inner}}`;
    default:
      return `[${inner}]`;
  }
}

/**
 * A flowchart.js fence as a mermaid flowchart, top to bottom.
 *
 * Node names become `n0`, `n1` and so on, because flowchart.js allows names
 * mermaid reserves (`end` among them). A condition's `yes` and `no` label the
 * edge they leave by. The hints flowchart.js takes for which side an edge
 * leaves from, `(right)` and the like, are dropped: mermaid lays out the graph
 * itself, and a hint it cannot follow is better ignored than misread.
 */
export function flowToMermaid(source: string): MermaidSource {
  const ids = new Map<string, string>();
  const defined = new Map<string, string>();
  const edges: string[] = [];

  const id = (name: string): string => {
    let value = ids.get(name);
    if (value === undefined) {
      value = `n${ids.size}`;
      ids.set(name, value);
    }
    return value;
  };

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '') continue;

    const symbol = /^([^=\s]+)\s*=>\s*(start|end|operation|inputoutput|subroutine|condition|parallel)\s*(?::\s*(.*))?$/.exec(line);
    if (symbol) {
      // A link (`:>url`, with `[blank]`) and a state (`|past`) ride on the end
      // of the label; neither is drawn.
      const label = (symbol[3] ?? symbol[1]!)
        .replace(/:>\S*(?:\[blank\])?\s*$/, '')
        .replace(/\|(?:past|current|future|invalid|approved|rejected|request)$/, '')
        .trim();
      defined.set(id(symbol[1]!), shape(symbol[2] as FlowShape, label || symbol[1]!));
      continue;
    }

    if (line.includes('->')) {
      const steps = line.split('->').map((step) => /^([^(\s]+)\s*(?:\(([^)]*)\))?$/.exec(step.trim()));
      if (steps.some((step) => step === null)) {
        return { error: `line ${index + 1} is not a flow connection: ${line}` };
      }
      for (let step = 0; step + 1 < steps.length; step += 1) {
        const from = steps[step]!;
        const to = steps[step + 1]!;
        const branch = (from[2] ?? '').split(',')[0]!.trim().toLowerCase();
        const label = branch === 'yes' || branch === 'no' ? `|${branch}|` : '';
        edges.push(`  ${id(from[1]!)} -->${label} ${id(to[1]!)}`);
      }
      continue;
    }

    return { error: `line ${index + 1} is not flow syntax: ${line}` };
  }

  // A name used in a connection but never defined is drawn as a plain box.
  const nodes = [...ids].map(([name, value]) => `  ${value}${defined.get(value) ?? shape('operation', name)}`);
  return { source: ['flowchart TD', ...nodes, ...edges].join('\n') };
}
