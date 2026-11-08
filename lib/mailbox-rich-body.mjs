import sanitizeHtml from 'sanitize-html';
import { referencedImageCids } from './email-adapter.mjs';

export const mailboxRichSanitizerVersion = 1;
const rawLimit = 512 * 1024;
const cacheLimit = 1024 * 1024;
const options = {
  allowedTags: [
    'a', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'cid'] },
  allowProtocolRelative: false,
  nonTextTags: ['script', 'style', 'textarea', 'option', 'template', 'svg', 'math', 'iframe', 'object', 'noscript'],
  parseStyleAttributes: false,
  nestingLimit: 60,
};

export function sanitizeMailboxRichBody(source) {
  if (typeof source?.html !== 'string') return null;
  const bytes = Buffer.from(source.html);
  const html = sanitizeHtml(bytes.subarray(0, rawLimit).toString('utf8'), options);
  if (Buffer.byteLength(html) > cacheLimit) return { html: '', truncated: true };
  return { html, truncated: source.truncated === true || bytes.length > rawLimit };
}

export function formatMailboxRichBody(body) {
  const html = body?.html || '';
  return { html, hasInlineImages: referencedImageCids(html).size > 0, ...(body?.truncated ? { truncated: true } : {}) };
}

function httpsImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function referencedMailboxExternalImage(html, value) {
  const url = httpsImageUrl(value);
  if (!html || !url) return null;
  let found = false;
  // Parse the cached HTML attributes rather than matching a URL in arbitrary text or links.
  sanitizeHtml(html, { ...options, allowedTags: ['img'], transformTags: {
    img(tagName, attribs) {
      if (httpsImageUrl(attribs.src) === url) found = true;
      return { tagName, attribs };
    },
  } });
  return found ? url : null;
}
