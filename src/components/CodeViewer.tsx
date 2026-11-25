import { Fragment, useMemo, type ReactNode } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-diff';

interface CodeViewerProps {
  code: string;
  filePath?: string;
  mode: 'code' | 'diff';
}

function detectLanguage(filePath?: string, mode?: 'code' | 'diff'): string {
  if (mode === 'diff') return 'diff';
  if (!filePath) return 'typescript';
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) return 'kotlin';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.sh')) return 'bash';
  if (lower.endsWith('.html') || lower.endsWith('.xml')) return 'markup';
  if (lower.endsWith('.css')) return 'css';
  return 'clike';
}

function renderTokenStream(tokens: Array<string | Prism.Token>, prefix: string): ReactNode {
  return tokens.map((token, idx) => {
    const key = `${prefix}-${idx}`;
    if (typeof token === 'string') {
      return <Fragment key={key}>{token}</Fragment>;
    }
    const aliases = Array.isArray(token.alias)
      ? token.alias.join(' ')
      : token.alias
        ? token.alias
        : '';
    const className = `token ${token.type} ${aliases}`.trim();
    const content = Array.isArray(token.content)
      ? renderTokenStream(token.content, key)
      : typeof token.content === 'string'
        ? token.content
        : renderTokenStream([token.content], key);
    return (
      <span key={key} className={className}>
        {content}
      </span>
    );
  });
}

export function CodeViewer({ code, filePath, mode }: CodeViewerProps) {
  const language = detectLanguage(filePath, mode);

  const renderedNodes = useMemo(() => {
    const grammar = Prism.languages[language] ?? Prism.languages.clike ?? Prism.languages.javascript;
    if (!grammar) {
      return code;
    }
    const tokens = Prism.tokenize(code, grammar);
    return renderTokenStream(tokens, 'p');
  }, [code, language]);

  return (
    <div className="h-full overflow-auto bg-[#090D14] p-4 font-mono text-[13px] leading-relaxed">
      <pre className={`language-${language} m-0`}>
        <code className={`language-${language}`}>{renderedNodes}</code>
      </pre>
    </div>
  );
}
