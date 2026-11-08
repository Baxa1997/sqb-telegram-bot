import { readPage, readSource, SOURCE_KINDS, type SourceKind } from './feeds.ts';
import { firstMatch, languageOf, shorten, wordsOf } from './pick.ts';

/* A source tried by hand, without writing anything and without Claude:
     yarn news:try rss https://www.spot.uz/ru/rss/ "стартап, венчур, инвест"
     yarn news:try telegram @spotuz
     yarn news:try google "SQB Ventures"
   It prints what the collector would take and why (the keywords, the fund's
   names as below). */

const [kind, address, keywords = '', names = 'SQB Ventures, SQBVC, SQB VC'] = process.argv.slice(2);
if (!SOURCE_KINDS.includes(kind as SourceKind) || !address) {
   console.error(`yarn news:try <${SOURCE_KINDS.join('|')}> <address> ["keywords"] ["fund names"]`);
   process.exit(1);
}

const articles = await readSource(kind as SourceKind, address, 'Источник');
console.log(`${articles.length} articles\n`);
for (const article of articles.slice(0, 12)) {
   const page = await readPage(article.url).catch(() => null);
   const lead = article.summary || page?.description || '';
   const head = `${article.title} ${lead}`;
   const name = firstMatch(`${head} ${page?.text ?? ''}`, wordsOf(names));
   const words = wordsOf(keywords);
   const keyword = words.length ? firstMatch(head, words) : '';
   const verdict = name
      ? `PRESS (names «${name}»)`
      : !words.length
        ? 'MARKET (no keywords: every article)'
        : keyword
          ? `MARKET (keyword «${keyword}»)`
          : 'skipped';
   console.log(`${article.date.slice(0, 16)}  [${languageOf(article.title)}]  ${verdict}`);
   console.log(`  ${article.title}`);
   console.log(`  ${shorten(lead, 160)}`);
   console.log(`  ${article.url}`);
   console.log(`  picture: ${article.image || page?.image || '—'}  outlet: ${article.outlet}\n`);
}
