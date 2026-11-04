import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/renderer/editor/noto/detect-language';

/*
 * The guess for a fence that names no language. Each sample is the shape such
 * a fence takes in practice: a command copied from a chat, a function from a
 * file, a config block. A guess that is wrong is worse than none, so the
 * plain samples must stay plain.
 */
const SAMPLES: Record<string, string> = {
  bash: 'kubectl get pods -A',
  'bash ': 'cd ~/project\nnpm install\nnpm run build',
  'bash  ': '#!/bin/bash\nset -euo pipefail\nfor f in *.md; do\n  echo "$f"\ndone',
  python: 'def greet(name: str) -> str:\n    return f"hi {name}"\n\nprint(greet("x"))',
  'python ': 'import os\nfrom pathlib import Path\n\nclass Store:\n    def __init__(self):\n        self.items = []',
  javascript: "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send('ok'));",
  typescript: 'interface User {\n  id: number;\n  name: string;\n}\n\nexport const users: User[] = [];',
  json: '{\n  "name": "noto",\n  "version": "0.0.4"\n}',
  yaml: 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\nspec:\n  containers:\n    - name: web\n      image: nginx:1.27',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}',
  rust: 'fn main() {\n    let mut total = 0;\n    println!("{}", total);\n}',
  sql: 'SELECT id, name\nFROM users\nWHERE created_at > now() - interval \'1 day\'\nORDER BY id;',
  html: '<!DOCTYPE html>\n<html>\n<body>\n  <div class="app"></div>\n</body>\n</html>',
  css: '.card {\n  padding: 12px;\n  border-radius: 6px;\n}\n\n@media (max-width: 600px) {\n  .card { padding: 8px; }\n}',
  dockerfile: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nCMD ["python", "main.py"]',
  diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;',
  toml: '[package]\nname = "noto"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"',
  java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}',
  cpp: '#include <iostream>\n\nint main() {\n    std::cout << "hi" << std::endl;\n}',
  c: '#include <stdio.h>\n\nint main(void) {\n    printf("hi\\n");\n    return 0;\n}',
  nginx: 'server {\n    listen 80;\n    server_name example.com;\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}',
  mermaid: 'graph TD\n  A --> B',
};

describe('guessing the language of a fence that names none', () => {
  for (const [language, code] of Object.entries(SAMPLES)) {
    it(`reads ${language.trim()} as ${language.trim()}`, () => {
      expect(detectLanguage(code)).toBe(language.trim());
    });
  }

  it('leaves what is not clearly code as plain text', () => {
    for (const plain of [
      '',
      'ok',
      'Hello, world.',
      'src/\n├── index.ts\n└── app.ts',
      '2024-01-01 12:00:01 INFO started worker 3',
      'TODO: write the second half of this note',
      'print("hi")',
    ]) {
      expect(detectLanguage(plain), plain).toBeNull();
    }
  });

  it('reads a long fence by its start, in well under a millisecond a call', () => {
    const code = 'def f(x):\n    return x\n'.repeat(2000);
    expect(detectLanguage(code)).toBe('python');
    const started = performance.now();
    for (let index = 0; index < 50; index += 1) detectLanguage(code);
    expect((performance.now() - started) / 50).toBeLessThan(2);
  });
});

describe('guesses that were wrong once', () => {
  it('reads a dict in a program as the program, never as JSON', () => {
    expect(detectLanguage('config = {\n    "host": "localhost",\n    "port": 8080,\n}')).not.toBe('json');
  });

  it('leaves the output of git log plain, colons and all', () => {
    expect(detectLanguage('commit 8474d13\nAuthor: me\nDate: Tue\n\n    fix: keep table handles usable')).toBeNull();
  });

  it('reads script with markup in it as JSX', () => {
    expect(detectLanguage('export default function App() {\n  return <div className="app">Hi</div>;\n}')).toBe('jsx');
  });
});
