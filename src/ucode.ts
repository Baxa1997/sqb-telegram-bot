import { createHash, randomUUID } from 'node:crypto';
import { UCODE } from './config.ts';

/* The fund's ucode tables, with the project's key, as the cabinet's server
   reads and writes them (startup-cabinet/server/ucode). The tables are those
   of the dashboard's docs/ucode-migration.md; this server writes only the
   rows of batch 26 (tg_chats, the journal's Telegram messages, the bot's
   state in fund_settings) and the files of those messages. */

export type Row = { guid: string } & Record<string, unknown>;

export class UcodeError extends Error {
   status: number;
   constructor(message: string, status: number) {
      super(message);
      this.name = 'UcodeError';
      this.status = status;
   }
   // timeouts, network failures, 429 and 5xx: worth trying again later
   get retryable() {
      return this.status === 0 || this.status === 429 || this.status >= 500;
   }
}

const headers = () => {
   const result: Record<string, string> = {
      authorization: 'API-KEY',
      'X-API-KEY': UCODE.apiKey,
      accept: 'application/json',
   };
   if (UCODE.resourceId) result['Resource-Id'] = UCODE.resourceId;
   if (UCODE.environmentId) result['Environment-Id'] = UCODE.environmentId;
   return result;
};

const call = async <T>(
   method: 'GET' | 'POST' | 'PUT' | 'DELETE',
   path: string,
   query: Record<string, string | number | boolean | undefined> = {},
   body?: unknown,
): Promise<T> => {
   const url = new URL(UCODE.baseUrl + path);
   for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
   const form = body instanceof FormData;
   let response: Response;
   try {
      response = await fetch(url, {
         method,
         headers: {
            ...headers(),
            ...(body !== undefined && !form && { 'content-type': 'application/json' }),
         },
         body:
            body === undefined
               ? undefined
               : form
                 ? (body as FormData)
                 : JSON.stringify(body),
         signal: AbortSignal.timeout(UCODE.timeoutMs),
      });
   } catch (error) {
      throw new UcodeError(
         `ucode ${method} ${url.pathname}: ${(error as Error).message}`,
         0,
      );
   }
   const text = await response.text();
   let json: unknown;
   try {
      json = text ? JSON.parse(text) : undefined;
   } catch {
      json = text;
   }
   if (!response.ok) {
      const reply = json as { description?: string; message?: string };
      throw new UcodeError(
         `ucode ${method} ${url.pathname}: ${response.status} ${reply?.description ?? reply?.message ?? response.statusText}`,
         response.status,
      );
   }
   return json as T;
};

const PAGE = 200;

/* Every row that matches the filter. ucode matches a text field by a part of
   its value, so every filtered field is compared exactly afterwards. */
export const listRows = async (
   table: string,
   filter: Record<string, string> = {},
) => {
   const rows: Row[] = [];
   for (let offset = 0; offset < 20000; offset += PAGE) {
      const reply = await call<{
         data?: { data?: { count?: number; response?: Row[] } };
      }>('GET', `/v2/items/${table}`, {
         'from-ofs': true,
         data: JSON.stringify({ ...filter, limit: PAGE, offset }),
         limit: PAGE,
         offset,
      });
      const page = reply.data?.data?.response ?? [];
      rows.push(...page);
      if (page.length < PAGE || rows.length >= (reply.data?.data?.count ?? 0))
         break;
   }
   return rows.filter((row) =>
      Object.entries(filter).every(([field, value]) => str(row[field]) === value),
   );
};

export const getRow = async (table: string, guid: string) => {
   try {
      const reply = await call<{ data?: { data?: { response?: Row } } }>(
         'GET',
         `/v2/items/${table}/${encodeURIComponent(guid)}`,
         { 'from-ofs': true },
      );
      const row = reply.data?.data?.response;
      return row?.guid ? row : undefined;
   } catch (error) {
      // ucode answers a guid it does not have with 400 «Invalid argument value»
      if (error instanceof UcodeError && (error.status === 404 || error.status === 400))
         return undefined;
      throw error;
   }
};

export const createRow = async (table: string, data: Record<string, unknown>) => {
   const guid = typeof data.guid === 'string' ? data.guid : randomUUID();
   await call('POST', `/v2/items/${table}`, { 'from-ofs': true }, {
      data: { ...data, guid },
      disable_faas: true,
   });
   return guid;
};

// Changes the fields given; the others keep their values.
export const updateRow = (table: string, data: Row) =>
   call('PUT', `/v2/items/${table}`, { 'from-ofs': true }, {
      data,
      disable_faas: true,
   });

export const deleteRow = (table: string, guid: string) =>
   call('DELETE', `/v2/items/${table}/${encodeURIComponent(guid)}`, { 'from-ofs': true }, {
      data: {},
   });

// A file into ucode Files; its full address and id.
export const uploadFile = async (file: File) => {
   const form = new FormData();
   form.append('file', file, file.name);
   const reply = await call<{ data?: { id?: string; link?: string } }>(
      'POST',
      '/v1/files/folder_upload',
      { folder_name: UCODE.folder, 'project-id': UCODE.projectId || undefined },
      form,
   );
   const link = reply.data?.link;
   if (!link) throw new Error('ucode stored no file');
   return {
      id: reply.data?.id ?? '',
      url: /^https?:\/\//.test(link)
         ? link
         : `${UCODE.filesUrl}/${link.replace(/^\/+/, '')}`,
   };
};

export const str = (value: unknown) =>
   value === null || value === undefined ? '' : String(value);

/* A guid made from a name, the same every time (UUID v5): a Telegram message
   gets one journal row however often its update comes. */
const NAMESPACE = Buffer.from('5b0c6f2e8d4a4f1e9a7b3c2d1e0f4a5b', 'hex');
export const guidOf = (name: string) => {
   const hash = createHash('sha1').update(NAMESPACE).update(name).digest();
   hash[6] = (hash[6] & 0x0f) | 0x50;
   hash[8] = (hash[8] & 0x3f) | 0x80;
   const hex = hash.subarray(0, 16).toString('hex');
   return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
