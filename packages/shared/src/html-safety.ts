import sanitizeHtml from 'sanitize-html';

export type StatementHtmlOptions = {
  rewriteImageUrl?: (url: string) => string;
  rewriteLinkUrl?: (url: string) => string;
  embeddedImagesOnly?: boolean;
};

/** The same parser and allowlist protect server rendering, browser rendering and PDF input. */
export function sanitizeStatementHtml(content: string, options: StatementHtmlOptions = {}) {
  return sanitizeHtml(content, {
    allowedTags: ['a', 'abbr', 'article', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
      'del', 'div', 'dl', 'dd', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li',
      'mark', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
      'tfoot', 'th', 'thead', 'tr', 'u', 'ul'],
    allowedAttributes: {
      '*': ['class', 'title'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], col: ['span'], ol: ['start'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'blob', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs,
        href: options.rewriteLinkUrl ? options.rewriteLinkUrl(attrs.href || '') : attrs.href,
        target: '_blank', rel: 'noreferrer noopener' } }),
      img: (_tag, attrs) => {
        const src = options.rewriteImageUrl ? options.rewriteImageUrl(attrs.src || '') : attrs.src || '';
        const raster = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(src);
        const safe = options.embeddedImagesOnly ? raster : !/^data:/i.test(src) || raster;
        return { tagName: 'img', attribs: { ...attrs, src: safe ? src : '' } };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
}
