/**
 * Surgical post-render SVG polish for Mermaid 12 diagrams.
 *
 * Mermaid 12 brings native ELK, `erDiagram` four-column tables, `block-beta`,
 * and `treeView-beta`, while leaving a handful of browser-level geometry warts:
 *
 * 1. Sharp `rx=0` rectangles on `classic` flowcharts/clusters and neo drop
 *    shadows that clash with Noto's flat paper aesthetic.
 * 2. Centered subgraph headers that collide with vertical trunk arrows entering
 *    through the middle of a container, plus ~110px of empty bottom slack ELK
 *    reserves on leaf subgraphs.
 * 3. `foreignObject` boxes measured 4-8px narrower than their rendered CJK /
 *    monospace runs, clipping the last character of edge labels (`API key`) or
 *    ER column names.
 * 4. `erDiagram` tables filled in Mermaid's hard-coded `#fff4dd` cream regardless
 *    of theme.
 * 5. `treeView-beta` prepending a synthetic `/` root above a single root folder
 *    and painting black strokes and green italic descriptions on dark themes.
 */

import { mix } from './chart-theme';
import { semanticRoles } from './diagram-roles';
import type { DiagramPalette } from './protocol';

const MONO_STACK = 'Menlo, "SF Mono", Consolas, "Cascadia Mono", "Noto Sans Mono CJK SC", monospace';

export interface PolishOptions {
  readonly isElkFlowchart?: boolean;
}

export function polishDiagramSvg(
  svg: SVGSVGElement,
  palette: DiagramPalette,
  dark: boolean,
  font: string,
  options: PolishOptions = {},
): void {
  const roles = semanticRoles(palette, dark);
  const clusterBg = mix(palette.raised, palette.paper, 0.45);

  // 1. Strip residual drop-shadows and add subtle architectural corner radius
  for (const shape of svg.querySelectorAll<SVGElement>('.node rect, .node polygon, .node path, .node circle, .cluster rect')) {
    shape.style.filter = 'none';
  }
  for (const rect of svg.querySelectorAll<SVGRectElement>('g.node > rect.label-container, g.cluster > rect')) {
    const rx = Number(rect.getAttribute('rx') || 0);
    if (rx === 0) {
      const radius = rect.parentElement?.classList.contains('cluster') ? '8' : '6';
      rect.setAttribute('rx', radius);
      rect.setAttribute('ry', radius);
    }
  }
  for (const rect of svg.querySelectorAll<SVGRectElement>('g.block rect.cluster')) {
    rect.style.fill = clusterBg;
    rect.style.stroke = palette.hairline;
    rect.style.strokeDasharray = '4 3';
    rect.setAttribute('rx', '8');
    rect.setAttribute('ry', '8');
  }

  // 2. Left-align subgraph headers & trim excessive ELK bottom slack on leaf containers
  const placedNodes = [...svg.querySelectorAll<SVGGElement>('g.node')]
    .map((node) => {
      const m = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(node.getAttribute('transform') ?? '');
      if (!m) return null;
      const bb = node.getBBox();
      const x = Number(m[1]);
      const y = Number(m[2]);
      return { x, y, bottom: y + bb.y + bb.height };
    })
    .filter((entry): entry is { x: number; y: number; bottom: number } => entry !== null);

  const edgeLabels = [...svg.querySelectorAll<SVGGElement>('g.edgeLabel')]
    .map((el) => {
      const m = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(el.getAttribute('transform') ?? '');
      if (!m) return null;
      const bb = el.getBBox();
      const x = Number(m[1]);
      const y = Number(m[2]);
      return { x, y, bottom: y + bb.y + bb.height };
    })
    .filter((entry): entry is { x: number; y: number; bottom: number } => entry !== null);

  const clusters = [...svg.querySelectorAll<SVGGElement>('g.cluster')].map((cl) => {
    const rect = cl.querySelector<SVGRectElement>(':scope > rect');
    const label = cl.querySelector<SVGGElement>(':scope > .cluster-label');
    if (!rect) return null;
    return {
      cl,
      rect,
      label,
      rx: Number(rect.getAttribute('x') || 0),
      ry: Number(rect.getAttribute('y') || 0),
      rw: Number(rect.getAttribute('width') || 0),
      rh: Number(rect.getAttribute('height') || 0),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);

  for (const c of clusters) {
    if (c.label) {
      const fo = c.label.querySelector('foreignObject');
      const lw = fo ? Number(fo.getAttribute('width') || 0) : c.label.getBBox().width;
      if (c.rw > lw + 28) {
        c.label.setAttribute('transform', `translate(${c.rx + 14}, ${c.ry + 7})`);
      }
      for (const sp of c.label.querySelectorAll<HTMLElement | SVGElement>('span, p, text')) {
        sp.style.fontWeight = '600';
        sp.style.fontSize = '12.5px';
        sp.style.color = palette.muted;
        sp.style.fill = palette.muted;
      }
    }

    if (!options.isElkFlowchart) continue;

    // Only tighten leaf clusters (no nested cluster inside this cluster's rect)
    const hasNestedCluster = clusters.some(
      (other) => other !== c && other.rx >= c.rx && other.rx + other.rw <= c.rx + c.rw && other.ry >= c.ry && other.ry + other.rh <= c.ry + c.rh,
    );
    if (hasNestedCluster) continue;

    const insideNodes = placedNodes.filter((n) => n.x >= c.rx && n.x <= c.rx + c.rw && n.y >= c.ry && n.y <= c.ry + c.rh);
    if (insideNodes.length === 0) continue;
    const insideLabels = edgeLabels.filter((l) => l.x >= c.rx && l.x <= c.rx + c.rw && l.y >= c.ry && l.y <= c.ry + c.rh);

    // Also include internal edge paths confined inside the cluster so nothing protrudes below tightBottom
    let maxInternalEdgeY = 0;
    const edgePaths = [...svg.querySelectorAll<SVGPathElement>('g.edgePaths path')];
    for (const path of edgePaths) {
      const bb = path.getBBox();
      if (bb.x >= c.rx - 2 && bb.x + bb.width <= c.rx + c.rw + 2 && bb.y >= c.ry - 2 && bb.y + bb.height <= c.ry + c.rh + 2) {
        maxInternalEdgeY = Math.max(maxInternalEdgeY, bb.y + bb.height);
      }
    }

    const maxChildBottom = Math.max(
      ...insideNodes.map((n) => n.bottom),
      ...insideLabels.map((l) => l.bottom),
      maxInternalEdgeY,
    );
    const oldBottom = c.ry + c.rh;
    const tightBottom = maxChildBottom + 20;
    if (oldBottom - tightBottom > 28) {
      c.rect.setAttribute('height', String(tightBottom - c.ry));
      for (const path of edgePaths) {
        let d = path.getAttribute('d') ?? '';
        const startM = /^M\s*([-\d.]+)[,\s]+([-\d.]+)/.exec(d);
        if (startM) {
          const sx = Number(startM[1]);
          const sy = Number(startM[2]);
          if (sx >= c.rx - 2 && sx <= c.rx + c.rw + 2 && Math.abs(sy - oldBottom) < 4) {
            d = d.replace(/^M\s*[-\d.]+[,\s]+[-\d.]+/, `M${sx},${tightBottom}`);
          }
        }
        const endL = /L\s*([-\d.]+)[,\s]+([-\d.]+)\s*$/.exec(d);
        if (endL) {
          const ex = Number(endL[1]);
          const ey = Number(endL[2]);
          if (ex >= c.rx - 2 && ex <= c.rx + c.rw + 2 && Math.abs(ey - oldBottom) < 4) {
            d = d.replace(/L\s*[-\d.]+[,\s]+[-\d.]+\s*$/, `L${ex},${tightBottom}`);
          }
        }
        if (d !== (path.getAttribute('d') ?? '')) {
          path.setAttribute('d', d);
        }
      }
    }
  }

  // 3. Restyle ER entity tables to Noto's warm palette instead of `#fff4dd`
  for (const erNode of svg.querySelectorAll<SVGGElement>('g[id*="entity-"]')) {
    const outerBg = erNode.querySelector<SVGPathElement>(':scope > g.outer-path > path:first-child');
    const outerStroke = erNode.querySelector<SVGPathElement>(':scope > g.outer-path > path:nth-child(2)');
    if (outerBg) outerBg.setAttribute('fill', roles.core.fill);
    if (outerStroke) {
      outerStroke.setAttribute('stroke', palette.lineStrong);
      outerStroke.setAttribute('stroke-width', '1.2');
    }
    for (const odd of erNode.querySelectorAll<SVGPathElement>('g.row-rect-odd > path:first-child')) {
      odd.setAttribute('fill', palette.paper);
    }
    for (const even of erNode.querySelectorAll<SVGPathElement>('g.row-rect-even > path:first-child')) {
      even.setAttribute('fill', palette.raised);
    }
    for (const strokePath of erNode.querySelectorAll<SVGPathElement>(
      'g.row-rect-odd > path:nth-child(2), g.row-rect-even > path:nth-child(2), g.divider > path:nth-child(2)',
    )) {
      strokePath.setAttribute('stroke', palette.hairline);
      strokePath.setAttribute('stroke-width', '1');
    }
    const headerText = erNode.querySelector<HTMLElement>('g.label.name p, g.label.name span');
    if (headerText) {
      headerText.style.fontWeight = '600';
      headerText.style.color = roles.core.text;
    }
    for (const typeEl of erNode.querySelectorAll<HTMLElement>('g.attribute-type p')) {
      typeEl.style.fontFamily = MONO_STACK;
      typeEl.style.fontSize = '11.5px';
      typeEl.style.color = palette.muted;
    }
    for (const nameEl of erNode.querySelectorAll<HTMLElement>('g.attribute-name p')) {
      nameEl.style.fontFamily = MONO_STACK;
      nameEl.style.fontSize = '12px';
      nameEl.style.color = palette.inkStrong;
    }
    for (const keyEl of erNode.querySelectorAll<HTMLElement>('g.attribute-keys p')) {
      if ((keyEl.textContent ?? '').trim()) {
        keyEl.style.fontFamily = MONO_STACK;
        keyEl.style.fontSize = '11px';
        keyEl.style.fontWeight = '600';
        keyEl.style.color = palette.accent;
      }
    }
  }

  // 4. Unclip foreignObjects whose inner scrollWidth strictly exceeds Mermaid's pre-measured box
  for (const fo of svg.querySelectorAll<SVGForeignObjectElement>('foreignObject')) {
    fo.style.overflow = 'visible';
    const inner = fo.firstElementChild as HTMLElement | null;
    if (!inner) continue;
    const curW = Number.parseFloat(fo.getAttribute('width') ?? '0');
    const curH = Number.parseFloat(fo.getAttribute('height') ?? '0');
    if (curW <= 0 || curH <= 0) continue;
    const isEdge = Boolean(fo.closest('g.edgeLabel'));
    const neededW = Math.ceil(inner.scrollWidth);
    const neededH = Math.ceil(inner.scrollHeight);
    if (neededW > curW + 0.5) {
      const grown = neededW + 2;
      const dx = (grown - curW) / 2;
      fo.setAttribute('width', String(grown));
      if (isEdge) {
        const parentG = fo.parentElement;
        const m = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(parentG?.getAttribute('transform') ?? '');
        if (m && parentG) {
          parentG.setAttribute('transform', `translate(${Number(m[1]) - dx}, ${Number(m[2])})`);
        }
      }
    }
    if (neededH > curH + 0.5) {
      fo.setAttribute('height', String(neededH + 2));
    }
  }

  // 5. TreeView refinement: unwrap synthetic "/" root only when there is a single depth-1 root entry,
  // recolour connectors, highlight bar, monospace paths, and muted sans comments
  const tvRoot = svg.querySelector<SVGGElement>('g.tree-view');
  if (tvRoot) {
    const allLabels = [...tvRoot.querySelectorAll<SVGTextElement>('.treeView-node-label')];
    for (const ln of [...tvRoot.querySelectorAll<SVGLineElement>('.treeView-node-line')]) {
      if (Number(ln.getAttribute('x1')) < 0) ln.remove();
    }
    const firstLabel = allLabels[0];
    if (firstLabel && (firstLabel.textContent ?? '').trim() === '/' && allLabels.length > 1) {
      const rootGroup = firstLabel.parentElement;
      const rootGroupX = Number(firstLabel.getAttribute('x') || 8);
      // Depth-1 items all share the smallest x strictly greater than rootGroupX (or icon-shifted equivalent)
      const childGroups = allLabels.slice(1).map((lb) => {
        const g = lb.parentElement!;
        const iconG = g.querySelector<SVGGElement>('.treeView-node-icon');
        const iconM = /translate\(\s*([-\d.]+)/.exec(iconG?.getAttribute('transform') ?? '');
        const leftX = iconM ? Number(iconM[1]) : Number(lb.getAttribute('x') || 0);
        return { lb, g, leftX };
      });
      const minChildX = Math.min(...childGroups.map((c) => c.leftX));
      const depth1Count = childGroups.filter((c) => Math.abs(c.leftX - minChildX) < 2).length;
      if (depth1Count === 1) {
        // Remove only the synthetic root's vertical trunk (at x = rootGroupX) and the single depth-1 elbow (x1 < minChildX - 2 && x2 <= minChildX + 2)
        for (const ln of [...tvRoot.querySelectorAll<SVGLineElement>('.treeView-node-line')]) {
          const x1 = Number(ln.getAttribute('x1'));
          const x2 = Number(ln.getAttribute('x2'));
          const isRootVertical = Math.abs(x1 - rootGroupX) < 1.5 && Math.abs(x2 - rootGroupX) < 1.5;
          const isDepth1Elbow = x1 < minChildX - 2 && x2 <= minChildX + 2 && Math.abs(Number(ln.getAttribute('y1')) - Number(ln.getAttribute('y2'))) < 1;
          if (isRootVertical || isDepth1Elbow) ln.remove();
        }
        rootGroup?.remove();
      }
    }
    for (const ln of tvRoot.querySelectorAll<SVGLineElement>('.treeView-node-line')) {
      ln.style.stroke = palette.lineStrong;
    }
    for (const hi of tvRoot.querySelectorAll<SVGRectElement>('.treeView-highlight-bg')) {
      hi.style.fill = roles.core.fill;
      hi.style.stroke = roles.core.stroke;
      hi.style.strokeWidth = '1px';
    }
    for (const lb of tvRoot.querySelectorAll<SVGTextElement>('.treeView-node-label')) {
      lb.style.fontFamily = MONO_STACK;
      lb.style.fontSize = '13px';
      lb.style.fill = palette.ink;
      lb.style.fontWeight = lb.classList.contains('treeView-node-dir') ? '600' : '400';
    }
    const descriptions = [...tvRoot.querySelectorAll<SVGTextElement>('.treeView-node-description')];
    if (descriptions.length > 0) {
      // Shift descriptions right if monospace labels grew wider than the original label column
      const maxLabelRight = Math.max(
        0,
        ...[...tvRoot.querySelectorAll<SVGTextElement>('.treeView-node-label')].map((lb) => {
          const b = lb.getBBox();
          return b.x + b.width;
        }),
      );
      const curDescX = Number(descriptions[0]!.getAttribute('x') || 0);
      const targetDescX = Math.max(curDescX, Math.ceil(maxLabelRight + 18));
      for (const desc of descriptions) {
        desc.setAttribute('x', String(targetDescX));
        desc.style.fontFamily = font;
        desc.style.fontSize = '13px';
        desc.style.fontStyle = 'normal';
        desc.style.fill = palette.muted;
      }
    }
    // Re-fit highlight bars to new total width if present
    const tempBox = tvRoot.getBBox();
    for (const hi of tvRoot.querySelectorAll<SVGRectElement>('.treeView-highlight-bg')) {
      const hx = Number(hi.getAttribute('x') || 0);
      hi.setAttribute('width', String(Math.max(Number(hi.getAttribute('width') || 0), Math.ceil(tempBox.x + tempBox.width - hx + 8))));
    }
    const bb = tvRoot.getBBox();
    if (bb.width > 0 && bb.height > 0) {
      const newW = Math.ceil(bb.width + 20);
      const newH = Math.ceil(bb.height + 16);
      svg.setAttribute('viewBox', `${bb.x - 10} ${bb.y - 8} ${newW} ${newH}`);
      svg.style.maxWidth = `${newW}px`;
    }
  }
}
