/* Picking without AI: the fund's names, a source's keywords, the article's
   language, a short summary. */

export type Language = 'ru' | 'uz' | 'en';
export type Localized = Record<Language, string>;

// Words of a setting: one per line or separated by commas.
export const wordsOf = (text: string) =>
   text
      .split(/[\n,;]+/)
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean);

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* The first word found at the start of a word of the text: «стартап» finds
   «стартапы», «ai» finds «AI» but not «said». */
export const firstMatch = (text: string, words: string[]) =>
   words.find((word) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}`, 'iu').test(text),
   ) ?? '';

// Cyrillic is Russian unless it has Uzbek letters; Latin is Uzbek when it
// has the Uzbek apostrophes, letters or common words, English otherwise. A
// Russian title with English names in it stays Russian.
export const languageOf = (text: string): Language => {
   const cyrillic = (text.match(/[а-яёўқғҳ]/gi) ?? []).length;
   const latin = (text.match(/[a-z]/gi) ?? []).length;
   if (cyrillic > 0.25 * (cyrillic + latin)) return /[ўқғҳ]/i.test(text) ? 'uz' : 'ru';
   if (
      /[oOgG][ʻ‘'’`]|[şçğöŞÇĞÖ]|\b(va|uchun|bilan|yil|mlrd|mln|haqida|kompaniyasi|loyiha|startap)\b/i.test(
         text,
      )
   )
      return 'uz';
   return 'en';
};

// A summary of at most `max` characters, cut after a sentence if it can be.
export const shorten = (text: string, max = 320) => {
   const clean = text.replace(/\s+/g, ' ').trim();
   if (clean.length <= max) return clean;
   const cut = clean.slice(0, max);
   const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
   if (sentence > 120) return cut.slice(0, sentence + 1);
   return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
};

// A title as compared between sources: no case, quotes or punctuation.
export const titleKey = (title: string) =>
   title
      .toLowerCase()
      .replace(/[«»"'“”„‘’`.,:;!?()–—-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

export const only = (language: Language, text: string): Localized => ({
   ru: '',
   uz: '',
   en: '',
   [language]: text,
});
