import { XMLParser } from 'fast-xml-parser';
import { extractArticle, postHtml } from './extract.ts';

/* The articles of a news source (news_sources, batch 28), newest first:
   - `rss`: an RSS, RDF or Atom feed's address;
   - `site`: a site's page, whose feed is found by its <link rel="alternate">
     (or the address is a feed already);
   - `telegram`: a public channel, read from its web preview t.me/s/<name>, so
     no account or bot is needed;
   - `google`: Google News search words, or a news.google.com/rss address.
   Only what the source publishes openly is read: the title, its short text,
   its picture and the link. */

export type SourceKind = 'rss' | 'site' | 'telegram' | 'google';
export const SOURCE_KINDS: SourceKind[] = ['rss', 'site', 'telegram', 'google'];

export interface Article {
   url: string; // the original: what the website links to
   title: string;
   summary: string; // plain text, as the source gives it
   image: string; // its picture's address, or ''
   date: string; // ISO
   outlet: string; // the publication, for Google News; else the source's name
   html: string; // its full text, when the feed or the post itself has it
}

const AGENT = 'Mozilla/5.0 (compatible; SQBVenturesNews/1.0; +https://sqbvc.uz)';

export const fetchText = async (url: string, timeoutMs = 20000) => {
   const response = await fetch(url, {
      headers: { 'user-agent': AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
   });
   if (!response.ok)
      throw new Error(`${new URL(url).host} ответил ${response.status}`);
   return {
      text: await response.text(),
      url: response.url || url,
      type: response.headers.get('content-type') ?? '',
   };
};

// ---- text

const ENTITIES: Record<string, string> = {
   amp: '&',
   lt: '<',
   gt: '>',
   quot: '"',
   apos: "'",
   nbsp: ' ',
   laquo: '«',
   raquo: '»',
   mdash: '—',
   ndash: '–',
   hellip: '…',
   rsquo: '’',
   lsquo: '‘',
   ldquo: '“',
   rdquo: '”',
   bdquo: '„',
   shy: '',
};

export const decode = (text: string) =>
   text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
         const code =
            name[1] === 'x' || name[1] === 'X'
               ? parseInt(name.slice(2), 16)
               : parseInt(name.slice(1), 10);
         return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
   });

// HTML to one line of plain text.
export const plain = (html: string) =>
   decode(
      html
         .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
         .replace(/<br\s*\/?>/gi, '\n')
         .replace(/<[^>]+>/g, ' '),
   )
      .replace(/[ \t\r\f\v ]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const absolute = (href: string, base: string) => {
   try {
      return new URL(decode(href), base).toString();
   } catch {
      return '';
   }
};

const isoOf = (value: string) => {
   const time = Date.parse(value);
   return Number.isFinite(time) ? new Date(time).toISOString() : '';
};

// ---- feeds

const parser = new XMLParser({
   ignoreAttributes: false,
   attributeNamePrefix: '@',
   isArray: (name) =>
      ['item', 'entry', 'link', 'enclosure', 'media:content', 'media:thumbnail'].includes(
         name,
      ),
});

type Node = Record<string, unknown>;

// A node's text: a string, its #text, or the first of a list.
const textOf = (value: unknown): string => {
   if (value === undefined || value === null) return '';
   if (typeof value === 'string' || typeof value === 'number') return String(value);
   if (Array.isArray(value)) return textOf(value[0]);
   if (typeof value === 'object') return textOf((value as Node)['#text']);
   return '';
};

const list = (value: unknown) =>
   (Array.isArray(value) ? value : value ? [value] : []) as Node[];

const looksLikeFeed = (text: string) =>
   /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(text);

// The item's link: RSS gives it as text, Atom as <link href rel="alternate">.
const linkOf = (item: Node, base: string) => {
   for (const link of list(item.link)) {
      if (typeof link === 'string') return absolute(link, base);
      const rel = textOf(link['@rel']) || 'alternate';
      if (rel === 'alternate' && link['@href']) return absolute(textOf(link['@href']), base);
   }
   const guid = textOf(item.guid);
   return /^https?:\/\//.test(guid) ? guid : '';
};

const imageOf = (item: Node, html: string, base: string) => {
   for (const enclosure of list(item.enclosure)) {
      const type = textOf(enclosure['@type']);
      const url = textOf(enclosure['@url']);
      if (url && (!type || type.startsWith('image/'))) return absolute(url, base);
   }
   for (const media of [...list(item['media:content']), ...list(item['media:thumbnail'])]) {
      const url = textOf(media['@url']);
      const medium = textOf(media['@medium']);
      if (url && (!medium || medium === 'image')) return absolute(url, base);
   }
   const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
   return img ? absolute(img[1], base) : '';
};

export const parseFeed = (xml: string, base: string, outlet: string): Article[] => {
   const doc = parser.parse(xml) as Node;
   const rss = (doc.rss as Node | undefined)?.channel as Node | undefined;
   const rdf = doc['rdf:RDF'] as Node | undefined;
   const atom = doc.feed as Node | undefined;
   const items = list(rss?.item ?? rdf?.item ?? atom?.entry);
   const google = /news\.google\./.test(base);
   return items.map((item) => {
      const html = textOf(
         item['content:encoded'] ?? item.description ?? item.summary ?? item.content,
      );
      // Google News: «Title - Outlet», the outlet in <source> (its name, or
      // only its address)
      let from = google ? oneLine(textOf(item.source)) : '';
      if (/^https?:\/\//.test(from)) from = new URL(from).host.replace(/^www\./, '');
      let title = oneLine(decode(textOf(item.title)));
      // the last « - Outlet», even an outlet with a hyphen («the-tech.kz»)
      if (google) title = title.replace(/\s+-\s+(?:(?!\s-\s).)+$/, '');
      const encoded = textOf(item['content:encoded']);
      const url = linkOf(item, base);
      return {
         url,
         title,
         summary: google ? '' : oneLine(plain(html)),
         image: imageOf(item, html, base),
         date: isoOf(
            textOf(item.pubDate ?? item['dc:date'] ?? item.published ?? item.updated),
         ),
         outlet: from || outlet,
         // a feed that carries the whole article (content:encoded)
         html: encoded ? extractArticle(`<article>${encoded}</article>`, url || base) : '',
      };
   });
};

// A site's feed: the page's <link rel="alternate">, or a usual address.
const findFeed = async (page: string, base: string) => {
   for (const tag of page.match(/<link\b[^>]*>/gi) ?? []) {
      if (!/rel=["']?alternate/i.test(tag)) continue;
      if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
      const href = tag.match(/href=["']([^"']+)["']/i);
      if (href) return absolute(href[1], base);
   }
   for (const path of ['/rss', '/feed', '/rss.xml', '/feed.xml', '/ru/rss/']) {
      const url = absolute(path, base);
      try {
         const { text } = await fetchText(url, 10000);
         if (looksLikeFeed(text)) return url;
      } catch {
         // not there
      }
   }
   return '';
};

const fromFeed = async (address: string, outlet: string, discover: boolean) => {
   const first = await fetchText(address);
   if (looksLikeFeed(first.text)) return parseFeed(first.text, first.url, outlet);
   if (!discover) throw new Error('По этой ссылке нет RSS-ленты');
   const feed = await findFeed(first.text, first.url);
   if (!feed)
      throw new Error(
         'На сайте не нашлось RSS-ленты: добавьте его как поиск Google News, например «site:домен.uz стартап»',
      );
   const second = await fetchText(feed);
   return parseFeed(second.text, second.url, outlet);
};

// ---- Telegram channels

export const channelOf = (address: string) =>
   address
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/^(www\.)?(t|telegram)\.me\/(s\/)?/, '')
      .replace(/^@/, '')
      .split(/[/?#]/)[0];

const fromChannel = async (address: string, outlet: string): Promise<Article[]> => {
   const name = channelOf(address);
   if (!/^[A-Za-z0-9_]{4,}$/.test(name)) throw new Error('Укажите канал как @имя или t.me/имя');
   const { text } = await fetchText(`https://t.me/s/${name}`);
   const posts = text.split('<div class="tgme_widget_message_wrap').slice(1);
   if (!posts.length)
      throw new Error('Канал закрыт или его нет: читаются только публичные каналы');
   return posts
      .map((post) => {
         const id = post.match(/data-post="([^"]+)"/)?.[1] ?? '';
         const body =
            post.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ??
            '';
         const lines = plain(body)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !/^https?:\/\/\S+$/.test(line));
         const bold = body.match(/^\s*<b>([\s\S]*?)<\/b>/)?.[1];
         const title = oneLine(bold ? plain(bold) : (lines[0] ?? ''));
         const rest = lines.filter((line) => oneLine(line) !== title).join(' ');
         // a post that links to an article: the article is the original
         const links = [...body.matchAll(/<a href="(https?:\/\/[^"]+)"/g)]
            .map((match) => decode(match[1]))
            .filter((url) => !/^https?:\/\/(t\.me|telegram\.me)\//.test(url));
         const photo =
            post.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/)?.[1] ??
            '';
         return {
            url: links[0] ?? (id ? `https://t.me/${id}` : ''),
            title: title.length > 160 ? `${title.slice(0, 157).trimEnd()}…` : title,
            summary: oneLine(rest),
            image: photo,
            date: isoOf(post.match(/<time datetime="([^"]+)"/)?.[1] ?? ''),
            outlet,
            // the post itself; a post that links to an article gets the article's
            html: postHtml(body, photo, 'https://t.me/'),
         };
      })
      .reverse(); // the page lists the oldest first
};

// ---- Google News

const googleAddress = (address: string) =>
   /^https?:\/\//.test(address)
      ? address
      : `https://news.google.com/rss/search?q=${encodeURIComponent(address.trim())}&hl=ru&gl=UZ&ceid=UZ:ru`;

// ---- a source

export const readSource = (kind: SourceKind, address: string, name: string) => {
   switch (kind) {
      case 'rss':
         return fromFeed(address, name, true);
      case 'site':
         return fromFeed(address, name, true);
      case 'telegram':
         return fromChannel(address, name);
      case 'google':
         return fromFeed(googleAddress(address), name, false);
   }
};

/* The article's own page, for what the feed leaves out: its picture, its
   description, and its text (to find the fund named in it, and for Claude).
   A Google News link opens the article only in a browser, so it is not read. */
export const readPage = async (url: string) => {
   if (!/^https?:\/\//.test(url) || /news\.google\.|(^https?:\/\/(t|telegram)\.me\/)/.test(url))
      return null;
   const { text, url: final } = await fetchText(url, 15000);
   const meta = (property: string) => {
      const tag = text.match(
         new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i'),
      )?.[0];
      return decode(tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? '');
   };
   const image = absolute(meta('og:image'), final);
   const html = extractArticle(text, final, image);
   return {
      image,
      description: oneLine(meta('og:description') || meta('description')),
      text: oneLine(plain(html)), // for the fund's names and for Claude
      html, // «Текст из источника» in the panel
   };
};
