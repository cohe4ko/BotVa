import { describe, it, expect } from 'vitest'
import {
  markdownToRichHtml,
  markdownToRichMessage,
  markdownToRichMessages,
  draftRichMessage,
  RICH_MESSAGE_MAX_CHARS,
} from './rich-message.js'

describe('markdownToRichHtml — headings', () => {
  it('maps # .. ###### to <h1> .. <h6>', () => {
    expect(markdownToRichHtml('# Title')).toBe('<h1>Title</h1>')
    expect(markdownToRichHtml('### Sub')).toBe('<h3>Sub</h3>')
    expect(markdownToRichHtml('###### Deep')).toBe('<h6>Deep</h6>')
  })

  it('renders inline formatting inside headings', () => {
    expect(markdownToRichHtml('## Hello **world**')).toBe('<h2>Hello <b>world</b></h2>')
  })
})

describe('markdownToRichHtml — paragraphs & inline', () => {
  it('wraps plain text in a paragraph', () => {
    expect(markdownToRichHtml('just text')).toBe('<p>just text</p>')
  })

  it('bold, italic, strikethrough, code, links', () => {
    expect(markdownToRichHtml('**b** and *i*')).toBe('<p><b>b</b> and <i>i</i></p>')
    expect(markdownToRichHtml('~~gone~~')).toBe('<p><s>gone</s></p>')
    expect(markdownToRichHtml('`x = 1`')).toBe('<p><code>x = 1</code></p>')
    expect(markdownToRichHtml('[site](https://t.me/a_b)'))
      .toBe('<p><a href="https://t.me/a_b">site</a></p>')
  })

  it('handles ||spoiler|| and ==mark== (non-standard markdown)', () => {
    expect(markdownToRichHtml('a ||secret|| b')).toBe('<p>a <tg-spoiler>secret</tg-spoiler> b</p>')
    expect(markdownToRichHtml('a ==hot== b')).toBe('<p>a <mark>hot</mark> b</p>')
  })

  it('mixes multiple inline styles in one paragraph', () => {
    expect(markdownToRichHtml('**bold** `code` *it* ~~st~~ ||sp||'))
      .toBe('<p><b>bold</b> <code>code</code> <i>it</i> <s>st</s> <tg-spoiler>sp</tg-spoiler></p>')
  })

  it('escapes HTML-significant characters', () => {
    expect(markdownToRichHtml('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>')
  })

  it('escapes inside code spans', () => {
    expect(markdownToRichHtml('`a<b>c`')).toBe('<p><code>a&lt;b&gt;c</code></p>')
  })
})

describe('markdownToRichHtml — code blocks', () => {
  it('fenced code with language → <pre><code class="language-x">', () => {
    const html = markdownToRichHtml('```python\nprint("hi")\n```')
    // Quotes are valid in text content; only & < > are escaped.
    expect(html).toBe('<pre><code class="language-python">print("hi")</code></pre>')
  })

  it('fenced code without language → <pre>', () => {
    const html = markdownToRichHtml('```\nraw text\n```')
    expect(html).toBe('<pre>raw text</pre>')
  })

  it('does not apply inline formatting inside code blocks', () => {
    const html = markdownToRichHtml('```\n**not bold** <tag>\n```')
    expect(html).toBe('<pre>**not bold** &lt;tag&gt;</pre>')
  })

  it('takes only the first token of a fence info string as language', () => {
    const html = markdownToRichHtml('```js title=foo\nx\n```')
    expect(html).toBe('<pre><code class="language-js">x</code></pre>')
  })
})

describe('markdownToRichHtml — lists', () => {
  it('unordered list → <ul><li>', () => {
    expect(markdownToRichHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  it('ordered list → <ol><li>', () => {
    expect(markdownToRichHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })

  it('ordered list with non-default start emits start attribute', () => {
    expect(markdownToRichHtml('3. a\n4. b')).toBe('<ol start="3"><li>a</li><li>b</li></ol>')
  })

  it('nested list nests <ul> inside <li>', () => {
    const html = markdownToRichHtml('- top\n  - inner a\n  - inner b')
    expect(html).toBe('<ul><li>top<ul><li>inner a</li><li>inner b</li></ul></li></ul>')
  })

  it('task list items render checkboxes', () => {
    const html = markdownToRichHtml('- [ ] todo\n- [x] done')
    expect(html).toBe(
      '<ul><li><input type="checkbox">todo</li><li><input type="checkbox" checked>done</li></ul>',
    )
  })

  it('inline formatting inside list items', () => {
    expect(markdownToRichHtml('- has **bold**')).toBe('<ul><li>has <b>bold</b></li></ul>')
  })
})

describe('markdownToRichHtml — blockquotes', () => {
  it('single-line blockquote', () => {
    expect(markdownToRichHtml('> quoted')).toBe('<blockquote>quoted</blockquote>')
  })

  it('multi-line blockquote joins with <br><br>', () => {
    const html = markdownToRichHtml('> line one\n>\n> line two')
    expect(html).toBe('<blockquote>line one<br><br>line two</blockquote>')
  })

  it('inline formatting inside blockquote', () => {
    expect(markdownToRichHtml('> a **b**')).toBe('<blockquote>a <b>b</b></blockquote>')
  })
})

describe('markdownToRichHtml — tables', () => {
  it('renders a table with header and alignment', () => {
    const md = '| A | B |\n|:--|--:|\n| 1 | 2 |'
    const html = markdownToRichHtml(md)
    expect(html).toBe(
      '<table><tr><th align="left">A</th><th align="right">B</th></tr>' +
      '<tr><td align="left">1</td><td align="right">2</td></tr></table>',
    )
  })

  it('renders inline formatting in cells', () => {
    const md = '| H |\n|---|\n| **x** |'
    const html = markdownToRichHtml(md)
    expect(html).toBe('<table><tr><th>H</th></tr><tr><td><b>x</b></td></tr></table>')
  })
})

describe('markdownToRichHtml — divider', () => {
  it('horizontal rule → <hr/>', () => {
    const html = markdownToRichHtml('a\n\n---\n\nb')
    expect(html).toBe('<p>a</p><hr/><p>b</p>')
  })
})

describe('markdownToRichHtml — mixed document', () => {
  it('concatenates blocks in order', () => {
    const md = '# Title\n\nIntro para.\n\n- one\n- two\n\n```js\nx\n```'
    const html = markdownToRichHtml(md)
    expect(html).toBe(
      '<h1>Title</h1><p>Intro para.</p><ul><li>one</li><li>two</li></ul>' +
      '<pre><code class="language-js">x</code></pre>',
    )
  })
})

describe('markdownToRichMessage', () => {
  it('returns an InputRichMessage with the html field only', () => {
    const msg = markdownToRichMessage('# Hi')
    expect(msg).toEqual({ html: '<h1>Hi</h1>' })
    expect(msg.markdown).toBeUndefined()
  })
})

describe('markdownToRichMessages — splitting & limits', () => {
  it('returns a single message for short input', () => {
    const msgs = markdownToRichMessages('short')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].html).toBe('<p>short</p>')
  })

  it('splits long input into multiple messages under the limit', () => {
    // Build a document of many paragraphs exceeding the char limit.
    const para = 'x'.repeat(500)
    const md = Array.from({ length: 100 }, () => para).join('\n\n') // ~50k chars
    expect(md.length).toBeGreaterThan(RICH_MESSAGE_MAX_CHARS)
    const msgs = markdownToRichMessages(md)
    expect(msgs.length).toBeGreaterThan(1)
    // Every produced message must carry html content
    for (const m of msgs) {
      expect(m.html && m.html.length).toBeGreaterThan(0)
    }
  })

  it('hard-splits a single oversized block', () => {
    const huge = 'y'.repeat(RICH_MESSAGE_MAX_CHARS * 2 + 100)
    const msgs = markdownToRichMessages(huge)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
  })

  it('respects a custom maxChars argument', () => {
    const md = 'aaaa\n\nbbbb\n\ncccc'
    const msgs = markdownToRichMessages(md, 6)
    expect(msgs.length).toBeGreaterThan(1)
  })
})

describe('draftRichMessage', () => {
  it('renders partial text as rich HTML (same as final)', () => {
    expect(draftRichMessage('partial **ans')).toEqual({ html: '<p>partial **ans</p>' })
  })
  it('falls back to raw markdown when HTML render is empty', () => {
    expect(draftRichMessage('')).toEqual({ markdown: '' })
  })
})
