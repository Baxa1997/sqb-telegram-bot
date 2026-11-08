import { NEWS } from '../config.ts';
import { createRow, getRow, guidOf, listRows, type Row, str, updateRow } from '../ucode.ts';
import { aiFailure, aiModel, askClaude } from './ai.ts';
import { withoutCover } from './extract.ts';
import { type Article, readPage, readSource, SOURCE_KINDS, type SourceKind } from './feeds.ts';
import { firstMatch, languageOf, type Localized, only, shorten, titleKey, wordsOf } from './pick.ts';

/* The news collector (dashboard docs/news.md, batch 28). Every minute it
   looks which sources of Настройки → Сбор новостей are due (each one every
   `fund_settings.news_every` minutes, or at once after «Проверить»), reads
   their new articles and keeps those that fit as rows of the website's
   `news` table: a draft (`is_published` false) with `origin` collected, the
   title, a short summary and the link to the original, in the section
   «Рынок» (Market) or «Пресса о нас» (Press). The fund publishes a draft in
   Сайт → Новости with one click, or rejects it; a source set to publish by
   itself puts its articles on the site at once.

   An article is taken when it names the fund (Press), or, unless the source
   is for mentions only, when its title or lead has one of the source's
   keywords, or the source has none (Market). With ANTHROPIC_API_KEY, Claude
   then reads each such article and keeps it only if it fits the fund's focus,
   with the title and summary in three languages (ai.ts). */

const log = (text: string) => console.log(`[news] ${text}`);
const now = () => new Date().toISOString();

const DEFAULT_NAMES = ['SQB Ventures', 'SQBVC', 'SQB VC', 'СКБ Венчурс'];
const DEFAULT_FOCUS =
   'Венчурные инвестиции и стартапы Узбекистана и Центральной Азии: раунды, фонды, акселераторы, IT Park, регулирование; FinTech, B2B SaaS, AI.';

interface Round {
   names: string[];
   focus: string;
   titles: Set<string>; // the news already kept, from any source
   aiLeft: number;
   aiOff: boolean; // the key failed: keywords only, this round
   aiError: string;
}

const json = <T>(value: unknown, fallback: T): T => {
   if (!value) return fallback;
   if (typeof value !== 'string') return value as T;
   try {
      return JSON.parse(value) as T;
   } catch {
      return fallback;
   }
};

const flag = (value: unknown) => value === true || value === 'true';

const olderThan = (article: Article, days: number) =>
   !!article.date && Date.now() - Date.parse(article.date) > days * 86400000;

// An address the same article has in every source: no query, no hash, no slash.
const canonical = (url: string) => {
   try {
      const parsed = new URL(url);
      if (!/news\.google\./.test(parsed.host)) parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '').replace(/^http:/, 'https:');
   } catch {
      return url;
   }
};

type Decision =
   | { take: false }
   | { take: false; retry: true } // Claude could not answer now: try it next time
   | {
        take: true;
        section: 'market' | 'press';
        title: Localized;
        summary: Localized;
        note: string;
     };

const decide = async (
   source: Row,
   article: Article,
   page: Awaited<ReturnType<typeof readPage>>,
   round: Round,
): Promise<Decision> => {
   const lead = article.summary || page?.description || '';
   const head = `${article.title} ${lead}`;
   const name = firstMatch(`${head} ${page?.text ?? ''}`, round.names);
   const keywords = wordsOf(str(source.keywords));
   const keyword = keywords.length ? firstMatch(head, keywords) : '';
   // the fund named: press, up to a year back; else market news of the week
   const section = name
      ? 'press'
      : flag(source.mentions_only) ||
          (keywords.length && !keyword) ||
          olderThan(article, NEWS.maxAgeDays)
        ? null
        : 'market';
   if (!section) return { take: false };
   const why = name
      ? `Упоминает «${name}»`
      : keyword
        ? `Ключевое слово «${keyword}»`
        : 'Источник без ключевых слов: берутся все статьи';

   if (aiModel() && !round.aiOff && round.aiLeft > 0) {
      round.aiLeft -= 1;
      try {
         const verdict = await askClaude(
            { ...article, summary: lead, text: (page?.text ?? '').slice(0, 12000) },
            round.focus,
            round.names,
         );
         if (!verdict?.relevant) return { take: false };
         return {
            take: true,
            section: name ? 'press' : verdict.section,
            title: verdict.title,
            summary: verdict.summary,
            note: `Claude: ${verdict.reason}`,
         };
      } catch (error) {
         const failure = aiFailure(error);
         round.aiError = failure.text;
         log(failure.text);
         if (failure.keywords) round.aiOff = true;
         else return { take: false, retry: true };
      }
   } else if (aiModel() && !round.aiOff) {
      return { take: false, retry: true }; // this round's Claude budget is spent
   }

   const language = languageOf(article.title);
   return {
      take: true,
      section,
      title: only(language, article.title),
      summary: only(language, shorten(lead)),
      note: why,
   };
};

// One source: its new articles that fit become news; the count kept.
const check = async (source: Row, round: Round) => {
   const kind = str(source.kind) as SourceKind;
   if (!SOURCE_KINDS.includes(kind)) throw new Error(`Неизвестный тип источника: ${kind}`);
   const articles = (await readSource(kind, str(source.address), str(source.name)))
      .filter(
         (article) => article.url && article.title && !olderThan(article, NEWS.pressAgeDays),
      )
      .slice(0, NEWS.perSource);
   const seen = json<string[]>(source.seen, []);
   const known = new Set(seen);
   let kept = 0;
   for (const article of articles) {
      const guid = guidOf(`news:${canonical(article.url)}`);
      if (known.has(guid)) continue;
      const key = titleKey(article.title);
      if (round.titles.has(key) || (await getRow('news', guid))) {
         known.add(guid);
         seen.push(guid);
         continue;
      }
      const page = await readPage(article.url).catch(() => null);
      const decision = await decide(source, article, page, round);
      if ('retry' in decision) break; // the rest stay unseen for next time
      if (decision.take) {
         const published = flag(source.auto_publish);
         const image = article.image || page?.image || '';
         const original = page?.html || article.html || '';
         await createRow('news', {
            guid,
            slug: '',
            date: (article.date || now()).slice(0, 10),
            category: decision.section === 'press' ? 'Press' : 'Market',
            outlet: article.outlet,
            url: article.url,
            image,
            is_published: published,
            title_ru: decision.title.ru,
            title_uz: decision.title.uz,
            title_en: decision.title.en,
            excerpt_ru: decision.summary.ru,
            excerpt_uz: decision.summary.uz,
            excerpt_en: decision.summary.en,
            // «Текст новости»: the article's text and pictures, in its language
            [`body_${languageOf(article.title)}`]: withoutCover(original, image),
            origin: 'collected',
            source_id: source.guid,
            found_at: now(),
            // the source as read, to take its text again in the editor
            original,
            original_at: now(),
            note: decision.note,
            is_rejected: false,
         });
         round.titles.add(key);
         kept += 1;
         log(`${str(source.name)}: «${article.title}» ${published ? 'is on the site' : 'waits in Сайт → Новости'}`);
      }
      known.add(guid);
      seen.push(guid);
   }
   return { kept, seen: seen.slice(-NEWS.seenKept) };
};

const LANGUAGES = ['ru', 'uz', 'en'] as const;

// When the source's text started to go into «Текст новости» by itself.
const BODIES_FROM = '2026-11-08T08:00:00.000Z';

// The language a collected news item was written in: its one title, or the
// language its title reads as.
const languageOfRow = (row: Row) =>
   LANGUAGES.filter((language) => str(row[`title_${language}`])).length === 1
      ? (LANGUAGES.find((language) => str(row[`title_${language}`])) ?? 'ru')
      : languageOf(str(row.title_ru) || str(row.title_uz) || str(row.title_en));

/* The news collected before the source's text was kept get it once, a few
   per minute, as their «Текст новости» too when that is still empty. A
   Google News link opens the article only in a browser, so its text stays
   empty (and is not tried again). */
const backfill = async (news: Row[]) => {
   const collected = news.filter((row) => str(row.origin) === 'collected');
   const unread = collected.filter((row) => !str(row.original_at)).slice(0, 5);
   for (const row of unread) {
      const page = await readPage(str(row.url)).catch(() => null);
      const image = str(row.image) || page?.image || '';
      const original = page?.html ?? '';
      const bodyEmpty = LANGUAGES.every((language) => !str(row[`body_${language}`]));
      await updateRow('news', {
         guid: row.guid,
         original,
         original_at: now(),
         ...(!str(row.image) && image ? { image } : {}),
         ...(bodyEmpty && original
            ? { [`body_${languageOfRow(row)}`]: withoutCover(original, image) }
            : {}),
      });
   }
   /* read before the text went into «Текст новости» (8 Nov): filled once. A
      later one's text is put in as it is read, so a text the fund clears
      stays cleared. */
   for (const row of collected) {
      const original = str(row.original);
      if (!original || !str(row.original_at) || str(row.original_at) > BODIES_FROM) continue;
      const language = languageOfRow(row);
      const body = withoutCover(original, str(row.image));
      const current = str(row[`body_${language}`]);
      // empty, or still exactly the source with its cover twice: put right
      const untouched = current === original && body !== original;
      if (!untouched && LANGUAGES.some((one) => str(row[`body_${one}`]))) continue;
      await updateRow('news', { guid: row.guid, [`body_${language}`]: body });
   }
};

let missingWarned = false;

// One minute of the collector: its heartbeat, then the sources that are due.
export const collectNews = async () => {
   const [settings] = await listRows('fund_settings');
   if (!settings) return;
   let sources: Row[];
   try {
      sources = await listRows('news_sources');
   } catch (error) {
      if (!missingWarned) log(`no news_sources table yet (batch 28): ${(error as Error).message}`);
      missingWarned = true;
      return;
   }
   await updateRow('fund_settings', {
      guid: settings.guid,
      news_seen_at: now(),
      news_ai: aiModel(),
   });

   const news = await listRows('news');
   await backfill(news);

   const everyMs = (Number(settings.news_every) || NEWS.everyMin) * 60000;
   const asked = str(settings.news_requested_at) > str(settings.news_checked_at);
   const due = sources.filter(
      (source) =>
         flag(source.is_active) &&
         (asked ||
            !str(source.checked_at) ||
            Date.now() - Date.parse(str(source.checked_at)) >= everyMs),
   );
   if (!due.length) {
      // «Проверить сейчас» with nothing switched on: answered all the same
      if (asked) await updateRow('fund_settings', { guid: settings.guid, news_checked_at: now() });
      return;
   }

   const round: Round = {
      names: wordsOf(str(settings.news_names)).length
         ? wordsOf(str(settings.news_names))
         : DEFAULT_NAMES.map((name) => name.toLowerCase()),
      focus: str(settings.news_focus) || DEFAULT_FOCUS,
      titles: new Set(
         news.flatMap((row) =>
            ['title_ru', 'title_uz', 'title_en']
               .map((field) => titleKey(str(row[field])))
               .filter(Boolean),
         ),
      ),
      aiLeft: NEWS.aiPerRound,
      aiOff: false,
      aiError: '',
   };
   for (const source of due) {
      try {
         const { kept, seen } = await check(source, round);
         await updateRow('news_sources', {
            guid: source.guid,
            checked_at: now(),
            error: '',
            found_count: (Number(source.found_count) || 0) + kept,
            seen: JSON.stringify(seen),
         });
      } catch (error) {
         log(`${str(source.name)}: ${(error as Error).message}`);
         await updateRow('news_sources', {
            guid: source.guid,
            checked_at: now(),
            error: (error as Error).message,
         });
      }
   }
   await updateRow('fund_settings', {
      guid: settings.guid,
      news_checked_at: now(),
      news_error: round.aiError,
   });
};
