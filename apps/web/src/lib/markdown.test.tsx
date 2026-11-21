import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks, safeHref } from './markdown.js';

describe('Markdown (untrusted text)', () => {
  it('renders HTML in the source as text, never as elements', () => {
    const { container } = render(
      <Markdown source={'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('onerror="alert(2)"');
  });

  it('drops javascript: and data: links but keeps their label', () => {
    const { container } = render(
      <Markdown
        source={'[點我](javascript:alert(1)) [圖](data:text/html,x) [好](https://ok.test/a)'}
      />,
    );
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['https://ok.test/a']);
    expect(anchors[0]!.getAttribute('rel')).toContain('noopener');
    expect(container.textContent).toContain('點我');
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('renders the supported subset', () => {
    const { container } = render(
      <Markdown
        source={[
          '# 標題',
          '一段 **粗體** 與 *斜體* 和 `code`。',
          '',
          '- [x] 完成',
          '- [ ] 未完成',
          '1. 一',
          '2. 二',
          '> 引言',
          '---',
          '```',
          'const a = "<b>";',
          '```',
        ].join('\n')}
      />,
    );
    expect(container.querySelector('h3')?.textContent).toBe('標題');
    expect(container.querySelector('strong')?.textContent).toBe('粗體');
    expect(container.querySelector('em')?.textContent).toBe('斜體');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.querySelector('blockquote')?.textContent).toBe('引言');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('const a = "<b>";');
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows an empty marker for blank text', () => {
    const { container } = render(<Markdown source={'  \n'} />);
    expect(container.textContent).toBe('（空白）');
  });
});

describe('helpers', () => {
  it('accepts only http(s) hrefs', () => {
    expect(safeHref('https://a.test')).toBe('https://a.test');
    expect(safeHref(' JavaScript:alert(1)')).toBeUndefined();
    expect(safeHref('//evil.test')).toBeUndefined();
    expect(safeHref('/relative')).toBeUndefined();
  });

  it('keeps an unterminated fence as code', () => {
    expect(parseBlocks('```\nopen')).toEqual([{ kind: 'code', text: 'open' }]);
  });
});
