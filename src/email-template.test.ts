import { describe, it, expect } from 'vitest'
import { markdownToEmailHtml } from './email-template.js'

describe('markdownToEmailHtml', () => {
  it('wraps markdown in HTML email structure', () => {
    const html = markdownToEmailHtml('Hello **world**')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('</html>')
  })

  it('includes signature when provided', () => {
    const html = markdownToEmailHtml('Body text', 'Best regards')
    expect(html).toContain('border-top')
    expect(html).toContain('Best regards')
  })

  it('omits signature div when not provided', () => {
    const html = markdownToEmailHtml('Body only')
    // No signature border div
    expect(html).not.toContain('border-top:1px solid #e5e7eb; color:#6b7280')
  })

  it('converts headers', () => {
    const html = markdownToEmailHtml('# Title\n\nParagraph')
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/)
  })

  it('converts links', () => {
    const html = markdownToEmailHtml('[Click](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('Click')
  })

  it('converts code blocks', () => {
    const html = markdownToEmailHtml('```\nconst x = 1\n```')
    expect(html).toContain('<code>')
  })

  it('handles empty markdown', () => {
    const html = markdownToEmailHtml('')
    expect(html).toContain('<!DOCTYPE html>')
  })
})
