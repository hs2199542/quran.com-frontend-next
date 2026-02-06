import { decamelizeKeys } from 'humps';

import stringify from './qs-stringify';
// CORRECTED: Change { isClient } to import isClient
import isClient from './isClient';

import { Mushaf, MushafLines, QuranFont, QuranFontMushaf } from '@/types/QuranReader';

export const ITEMS_PER_PAGE = 10;

const API_ROOT_PATH = '/api/qdc';

/**
 * Generates a url to make an api call to our backend
 *
 * In client-side environments, this returns a relative URL pointing to the Next.js API proxy route.
 * In server-side (SSR/SSG/API Routes), this returns an absolute URL to the configured QURAN_API_HOST.
 *
 * @param {string} path the path for the call
 * @param {Record<string, unknown>} parameters optional query params, {a: 1, b: 2} is parsed to "?a=1&b=2"
 * @returns {string}
 */
export const makeUrl = (path: string, parameters?: Record<string, unknown>): string => {
  let baseUrl: string;

  if (isClient()) {
      // Client-side requests always hit the Next.js proxy route, which includes the /api/proxy prefix.
      baseUrl = `/api/proxy${API_ROOT_PATH}${path}`;
  } else {
      // Server-side requests (SSR/SSG) use the direct absolute path defined in ENV.
      // The fallback logic is handled within the /api/proxy route itself when the client calls it.
      // For SSR/SSG fetching, we assume the primary host or the fallback if primary is missing.
      const apiHost = process.env.QURAN_API_HOST || process.env.QURAN_PUBLIC_API_HOST || 'https://api.quran.com';
      baseUrl = `${apiHost}${API_ROOT_PATH}${path}`;
  }


  if (!parameters) {
    return baseUrl;
  }

  const decamelizedParams = decamelizeKeys(parameters);

  // The following section parses the query params for convenience
  // E.g. parses {a: 1, b: 2} to "?a=1&b=2"
  const queryParameters = `?${stringify(decamelizedParams)}`;
  return `${baseUrl}${queryParameters}`;
};

/**
 * Get the default word fields that should exist in the response.
 * qpc_uthmani_hafs is added so that we can use it as a fallback
 * text for QCF font V1, V2 and V4.
 *
 * @param {QuranFont} quranFont the selected quran font since.
 * @returns {{ wordFields: string}}
 *
 */
export const getDefaultWordFields = (
  quranFont: QuranFont = QuranFont.QPCHafs,
): { wordFields: string } => ({
  wordFields: `verse_key,verse_id,page_number,location,text_uthmani,text_imlaei_simple,${
    quranFont === QuranFont.TajweedV4 ? QuranFont.MadaniV2 : quranFont
  }${quranFont === QuranFont.QPCHafs ? '' : `,${QuranFont.QPCHafs}`}`,
});

/**
 * Get the mushaf id based on the value inside redux (if it's not SSR).
 *
 * @param {QuranFont} quranFont
 * @param {MushafLines} mushafLines
 * @returns {{mushaf: Mushaf}}
 */
export const getMushafId = (
  // eslint-disable-next-line default-param-last
  quranFont: QuranFont = QuranFont.QPCHafs,
  mushafLines?: MushafLines,
): { mushaf: Mushaf } => {
  let mushaf = QuranFontMushaf[quranFont];
  // convert the Indopak mushaf to either 15 or 16 lines Mushaf
  if (quranFont === QuranFont.IndoPak && mushafLines) {
    mushaf =
      mushafLines === MushafLines.FifteenLines ? Mushaf.Indopak15Lines : Mushaf.Indopak16Lines;
  }
  return { mushaf };
};
