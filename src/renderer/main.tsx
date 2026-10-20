import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { trackInputModality } from './input-modality';
// ProseMirror's own base rules. Milkdown used to bundle these; owning the
// editor means importing them directly.
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
// Bundled rather than fetched, so formulas render with no network at runtime.
import 'katex/dist/katex.min.css';
import './styles/app.scss';
import './styles/editor.scss';
import './styles/noto-editor.scss';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');

trackInputModality();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

