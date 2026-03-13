import { marked } from 'marked'

/**
 * Convert markdown body to a styled HTML email with optional signature.
 * Produces a responsive, email-client-compatible layout with inline styles.
 */
export function markdownToEmailHtml(markdown: string, signature?: string): string {
  const bodyHtml = marked.parse(markdown, { async: false }) as string
  const signatureHtml = signature
    ? `<div style="margin-top:24px; padding-top:16px; border-top:1px solid #e5e7eb; color:#6b7280; font-size:14px; line-height:1.5;">
                  ${marked.parse(signature, { async: false }) as string}
                </div>`
    : ''

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f4f4f7; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:32px 40px;">
              <div style="color:#1a1a2e; font-size:16px; line-height:1.6;">
                ${bodyHtml}
              </div>
              ${signatureHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  <style>
    h1 { font-size:24px; font-weight:700; color:#1a1a2e; margin:0 0 16px; }
    h2 { font-size:20px; font-weight:600; color:#1a1a2e; margin:24px 0 12px; }
    h3 { font-size:17px; font-weight:600; color:#1a1a2e; margin:20px 0 8px; }
    p { margin:0 0 14px; }
    a { color:#2563eb; text-decoration:none; }
    a:hover { text-decoration:underline; }
    ul, ol { margin:0 0 14px; padding-left:24px; }
    li { margin-bottom:6px; }
    blockquote { margin:0 0 14px; padding:12px 16px; background:#f8f9fc; border-left:3px solid #d1d5db; border-radius:0 4px 4px 0; color:#4b5563; }
    blockquote p { margin:0; }
    code { font-family:'SF Mono', Consolas, monospace; font-size:14px; background:#f3f4f6; padding:2px 5px; border-radius:3px; }
    pre { background:#1e293b; color:#e2e8f0; padding:16px; border-radius:6px; overflow-x:auto; margin:0 0 14px; }
    pre code { background:none; padding:0; color:inherit; }
    table { width:100%; border-collapse:collapse; margin:0 0 14px; }
    th, td { padding:8px 12px; text-align:left; border-bottom:1px solid #e5e7eb; }
    th { font-weight:600; background:#f8f9fc; }
    hr { border:none; border-top:1px solid #e5e7eb; margin:20px 0; }
    strong { font-weight:600; }
    img { max-width:100%; height:auto; border-radius:4px; }
  </style>
</body>
</html>`
}
