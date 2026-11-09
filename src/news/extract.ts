import { decode } from './feeds.ts';

/* An article's own text and pictures, from its page, as clean HTML for the
   panel's editor («Текст из источника» in Сайт → Новости): paragraphs,
   headings, lists, quotes and pictures with captions, in their order, with
   only links, bold and italic kept inside them. The site never shows it as
   is: the fund decides what to put in a news item's text. */

const MAX = 100_000;

// Where the article's body starts, by how outlets mark it: microdata first,
// then the usual class names, then the page's <article>.
const STARTS = [
   /<([a-z0-9]+)\b[^>]*itemprop=["']articleBody["'][^>]*>/i,
   /<([a-z0-9]+)\b[^>]*class=["'][^"']*\b(?:article-body|article__body|articleBody|article-text|article__text|article-content|article__content|post-content|post__content|entry-content|news-text|news__text|content-text|story-body|single-content)\b[^"']*["'][^>]*>/i,
   /<(article)\b[^>]*>/i,
];

// The element that starts at `from`, to its own closing tag.
const element = (html: string, from: number, tag: string) => {
   const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
   pattern.lastIndex = from;
   let depth = 0;
   for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
      depth += match[1] ? -1 : 1;
      if (depth === 0) return html.slice(from, pattern.lastIndex);
   }
   return html.slice(from);
};

const bodyOf = (page: string) => {
   for (const start of STARTS) {
      const match = start.exec(page);
      if (match) return element(page, match.index, match[1].toLowerCase());
   }
   return page.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? page;
};

const absolute = (href: string, base: string) => {
   try {
      return new URL(decode(href.trim()), base).toString();
   } catch {
      return '';
   }
};

const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Inside a block: links, bold and italic kept, every other tag dropped.
const inline = (html: string, base: string) =>
   html
      .replace(/<(script|style|noscript|svg|button)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<(\/?)(?:b|strong)\b[^>]*>/gi, '<$1strong>')
      .replace(/<(\/?)(?:i|em)\b[^>]*>/gi, '<$1em>')
      // every link rebuilt with its web address only: no other attribute
      // (onclick, style…) of the outlet's page reaches the site
      .replace(/<a\b([^>]*)>/gi, (_, attrs: string) => {
         const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
         const url = href ? absolute(href, base) : '';
         return /^https?:\/\//.test(url) ? `<a href="${escapeAttr(url)}">` : '<a>';
      })
      .replace(/<(?!\/?(?:strong|em|a)\b)[^>]+>/gi, '')
      .replace(/<a>([\s\S]*?)<\/a>/gi, '$1')
      .replace(/\s+/g, ' ')
      .trim();

const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, '')).trim();

// The outlet's own lines, not the article's.
const JUNK =
   /^(реклама|читайте также|подписывайтесь|подпишитесь|фото:|источник:|reklama|obuna bo|advertisement|read also|subscribe)/i;

// A picture worth keeping: not an icon, a logo, a counter or a placeholder.
const pictureOf = (tag: string, base: string) => {
   const attr = (name: string) =>
      tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1] ?? '';
   const src =
      attr('data-src') ||
      attr('data-lazy-src') ||
      attr('data-lazy') ||
      attr('data-original') ||
      attr('srcset').split(/[\s,]+/)[0] ||
      attr('src');
   const width = Number(attr('width')) || 0;
   if (!src || src.startsWith('data:') || /\.svg(\?|$)/i.test(src)) return null;
   if (/logo|avatar|icon|emoji|pixel|counter|spacer|banner/i.test(src)) return null;
   if (width && width < 120) return null;
   const url = absolute(src, base);
   return /^https?:\/\//.test(url) ? { url, alt: decode(attr('alt')) } : null;
};

const BLOCK =
   /<(h[1-6]|p|li|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*>/gi;

/* The article's text and pictures; `cover`, the page's main picture (its
   og:image), goes first unless the text already has it. */
export const extractArticle = (page: string, base: string, cover = '') => {
   const body = bodyOf(page)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|form|nav|aside|footer|header|svg|iframe)\b[\s\S]*?<\/\1>/gi, '');
   const out: string[] = [];
   const seen = new Set<string>();
   let list: string[] = [];
   const flush = () => {
      if (list.length) out.push(`<ul>${list.map((item) => `<li>${item}</li>`).join('')}</ul>`);
      list = [];
   };
   for (const match of body.matchAll(BLOCK)) {
      const tag = match[1]?.toLowerCase();
      if (!tag) {
         const picture = pictureOf(match[0], base);
         if (!picture || seen.has(picture.url)) continue;
         seen.add(picture.url);
         flush();
         out.push(
            `<figure class="image"><img src="${escapeAttr(picture.url)}" alt="${escapeAttr(picture.alt)}"></figure>`,
         );
         continue;
      }
      const text = inline(match[2], base);
      const plain = textOf(text);
      if (!plain || JUNK.test(plain)) continue;
      if (tag === 'li') {
         list.push(text);
         continue;
      }
      flush();
      if (tag === 'h1') continue; // the title, already the news item's own
      if (tag === 'figcaption') {
         const last = out.length - 1;
         if (last >= 0 && out[last].endsWith('</figure>'))
            out[last] = out[last].replace('</figure>', `<figcaption>${text}</figcaption></figure>`);
         continue;
      }
      if (/^h[2-6]$/.test(tag)) out.push(`<${tag === 'h2' ? 'h2' : 'h3'}>${text}</${tag === 'h2' ? 'h2' : 'h3'}>`);
      else if (tag === 'blockquote') out.push(`<blockquote><p>${text}</p></blockquote>`);
      else out.push(`<p>${text}</p>`);
   }
   flush();
   if (cover && !seen.has(cover))
      out.unshift(`<figure class="image"><img src="${escapeAttr(cover)}" alt=""></figure>`);
   const html = out.join('\n');
   // a page whose text was not found: nothing rather than the site's menus
   return textOf(html).length < 200 ? '' : html.slice(0, MAX);
};

/* The text for the news item itself: the source's text without its first
   picture when the news item has a cover. That picture is the page's main
   one, which the cover already is (often another size of it, from the
   feed), and the site shows the cover above the text. */
const FIRST_FIGURE =
   /^<figure class="image"><img [^>]*>(?:<figcaption>[\s\S]*?<\/figcaption>)?<\/figure>\n?/;
export const withoutCover = (html: string, cover: string) =>
   cover ? html.replace(FIRST_FIGURE, '') : html;

// A Telegram post's text as paragraphs, its photo first.
export const postHtml = (body: string, photo: string, base: string) => {
   const paragraphs = body
      .split(/<br\s*\/?>\s*<br\s*\/?>/i)
      .map((part) => inline(part, base))
      .filter((part) => textOf(part));
   return [
      photo ? `<figure class="image"><img src="${escapeAttr(photo)}" alt=""></figure>` : '',
      ...paragraphs.map((part) => `<p>${part}</p>`),
   ]
      .filter(Boolean)
      .join('\n');
};
