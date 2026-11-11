/**
 * Minimal RFC 822-style email parsing for invoice emails (.eml).
 * For HTML bodies we separate what a human sees from text that is hidden
 * (comments, display:none, white or 1px text): hidden text is a classic
 * place to smuggle instructions to an AI agent.
 */

export interface ParsedEmail {
  headers: Record<string, string>;
  isHtml: boolean;
  visibleText: string;
  hiddenText: string[];
}

const HIDDEN_DECL = String.raw`(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?![.\d])|font-size\s*:\s*[01](?:\.\d+)?(?:px|pt)?(?![.\d])|(?<![-\w])color\s*:\s*(?:#fff(?:fff)?\b|white\b)|max-height\s*:\s*0(?![.\d])|(?<![-\w])height\s*:\s*0(?![.\d]))`;
const HIDDEN_STYLE_EL = new RegExp(String.raw`<(\w+)\b[^>]*\bstyle\s*=\s*(["'])[^"']*?${HIDDEN_DECL}[^"']*?\2[^>]*>([\s\S]*?)<\/\1\s*>`, 'gi');
const HIDDEN_ATTR_EL = /<(\w+)\b(?=[^>]*\shidden(?:[\s=>]|$))[^>]*>([\s\S]*?)<\/\1\s*>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/\s+/g, ' ') // source whitespace is insignificant in HTML
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h\d|table|section)\s*>/gi, '\n\n')
      .replace(/<\/(div|tr|li)\s*>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  );
}

export function cleanText(t: string): string {
  const lines = t.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim());
  const out: string[] = [];
  for (const l of lines) if (l || (out.length && out[out.length - 1] !== '')) out.push(l);
  return out.join('\n').trim();
}

function splitHtml(html: string): { visible: string; hidden: string[] } {
  const hidden: string[] = [];
  const keep = (t: string) => {
    const c = cleanText(htmlToText(t));
    if (c) hidden.push(c);
    return '';
  };
  let s = html.replace(/<!--([\s\S]*?)-->/g, (_, c: string) => keep(c));
  s = s.replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  // Repeat to catch hidden elements nested inside other hidden elements.
  for (let i = 0; i < 3; i++) {
    s = s.replace(HIDDEN_STYLE_EL, (_m, _tag, _q, inner: string) => keep(inner));
    s = s.replace(HIDDEN_ATTR_EL, (_m, _tag, inner: string) => keep(inner));
  }
  return { visible: cleanText(htmlToText(s)), hidden };
}

export function parseEmail(raw: string): ParsedEmail {
  const norm = raw.replace(/\r\n/g, '\n');
  const sep = norm.indexOf('\n\n');
  const head = sep >= 0 ? norm.slice(0, sep) : '';
  const body = sep >= 0 ? norm.slice(sep + 2) : norm;
  const headers: Record<string, string> = {};
  let last = '';
  for (const line of head.split('\n')) {
    if (/^\s/.test(line) && last) {
      headers[last] += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      last = m[1].toLowerCase();
      headers[last] = m[2];
    }
  }
  const isHtml = /text\/html/i.test(headers['content-type'] ?? '') || /^\s*<(!doctype|html)/i.test(body);
  if (!isHtml) return { headers, isHtml, visibleText: cleanText(body), hiddenText: [] };
  const { visible, hidden } = splitHtml(body);
  return { headers, isHtml, visibleText: visible, hiddenText: hidden };
}

export function parseAddress(value: string): { name: string; email: string; domain: string } {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const name = (m ? m[1] : '').trim();
  const email = (m ? m[2] : value).trim().toLowerCase();
  return { name, email, domain: email.includes('@') ? email.split('@').pop()! : '' };
}
