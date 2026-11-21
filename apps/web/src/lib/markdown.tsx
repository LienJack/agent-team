import type { ReactNode } from 'react';

// Minimal Markdown → React elements for ticket and receipt text, which is untrusted (written by
// people and models). Everything becomes React text nodes, so HTML in the source is shown as
// text; there is no innerHTML anywhere. Links are kept only for http(s) URLs.
//
// Supported: ATX headings, paragraphs, fenced code, `-`/`*`/`1.` lists (incl. [ ] / [x]),
// blockquotes, horizontal rules, inline code, **bold**, *italic*, [text](url) and bare URLs.

const SAFE_URL = /^https?:\/\/[^\s]+$/i;

export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  return SAFE_URL.test(trimmed) ? trimmed : undefined;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function link(label: ReactNode, url: string, key: string): ReactNode {
  const href = safeHref(url);
  if (!href) return <span key={key}>{label}</span>;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-accent underline underline-offset-2 break-all"
    >
      {label}
    </a>
  );
}

export function renderInline(text: string, keyPrefix = 'i', allowLinks = true): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}${n++}`;
    const [token, code, strong, em, md, bare] = m;
    if (code) {
      out.push(
        <code key={key} className="rounded bg-raised px-1 font-mono text-[0.85em]">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (strong) {
      out.push(
        <strong key={key}>{renderInline(strong.slice(2, -2), `${key}.`, allowLinks)}</strong>,
      );
    } else if (em) {
      out.push(<em key={key}>{renderInline(em.slice(1, -1), `${key}.`, allowLinks)}</em>);
    } else if (md) {
      const close = md.indexOf('](');
      const label = md.slice(1, close);
      const url = md.slice(close + 2, -1);
      out.push(
        allowLinks
          ? link(renderInline(label, `${key}.`, false), url, key)
          : renderInline(label, `${key}.`, false),
      );
    } else if (bare) {
      out.push(allowLinks ? link(bare, bare, key) : bare);
    } else {
      out.push(token);
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of text)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
        body.push(lines[i++]!.trimStart().replace(/^>\s?/, ''));
      }
      blocks.push({ kind: 'quote', text: body.join(' ') });
      continue;
    }
    const listRe = UL.test(line) ? UL : OL.test(line) ? OL : undefined;
    if (listRe) {
      const items: string[] = [];
      while (i < lines.length && listRe.test(lines[i]!)) items.push(listRe.exec(lines[i++]!)![1]!);
      blocks.push({ kind: 'list', ordered: listRe === OL, items });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !FENCE.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !UL.test(lines[i]!) &&
      !OL.test(lines[i]!)
    ) {
      body.push(lines[i++]!.trim());
    }
    blocks.push({ kind: 'paragraph', text: body.join(' ') });
  }
  return blocks;
}

const HEADING_CLASS = ['text-base font-semibold', 'text-sm font-semibold', 'text-sm font-medium'];

function listItem(text: string, key: string): ReactNode {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!task) return <li key={key}>{renderInline(text, `${key}.`)}</li>;
  const done = task[1] !== ' ';
  return (
    <li key={key} className="list-none -ml-4">
      <span aria-hidden="true">{done ? '☑' : '☐'} </span>
      <span className="sr-only">{done ? '已完成：' : '未完成：'}</span>
      {renderInline(task[2]!, `${key}.`)}
    </li>
  );
}

/** Render untrusted Markdown as React elements. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) return <p className="text-muted">（空白）</p>;
  return (
    <div className={`space-y-2 break-words leading-relaxed ${className ?? ''}`}>
      {blocks.map((block, n) => {
        const key = `b${n}`;
        switch (block.kind) {
          case 'heading': {
            const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[Math.min(block.level, 4) - 1]!;
            return (
              <Tag key={key} className={HEADING_CLASS[Math.min(block.level, 3) - 1]}>
                {renderInline(block.text, `${key}.`)}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded bg-raised p-2 font-mono text-xs leading-snug"
              >
                <code>{block.text}</code>
              </pre>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={key}
                className={`pl-5 space-y-0.5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, j) => listItem(item, `${key}.${j}`))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={key} className="border-l-2 border-line pl-3 text-muted">
                {renderInline(block.text, `${key}.`)}
              </blockquote>
            );
          case 'rule':
            return <hr key={key} className="border-line" />;
          case 'paragraph':
            return <p key={key}>{renderInline(block.text, `${key}.`)}</p>;
        }
      })}
    </div>
  );
}
