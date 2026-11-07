import {
   constants,
   createCipheriv,
   createDecipheriv,
   createHash,
   createPrivateKey,
   generateKeyPairSync,
   type KeyObject,
   privateDecrypt,
   randomBytes,
} from 'node:crypto';
import { TELEGRAM } from './config.ts';
import { type Row, str, updateRow } from './ucode.ts';

/* What this server keeps in ucode that nobody else may read: the fund
   account's session and api_hash, and its own private key. Each is sealed
   with AES-256-GCM under a key from TELEGRAM_SECRET (the server's settings;
   without it, from the bot's token). The panel encrypts what a person types
   (api_hash, the two-step password) with this server's public key, kept in
   fund_settings.telegram_keys, so it crosses ucode unreadable. */

const rootKey = () =>
   createHash('sha256')
      .update(TELEGRAM.secret || `sqbv-telegram:${TELEGRAM.botToken}`)
      .digest();

export const seal = (text: string) => {
   const iv = randomBytes(12);
   const cipher = createCipheriv('aes-256-gcm', rootKey(), iv);
   const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
   return ['v1', iv, cipher.getAuthTag(), body]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
};

// The text sealed here; throws if it was sealed under another key.
export const unseal = (sealed: string) => {
   const [version, iv, tag, body] = sealed.split('.');
   if (version !== 'v1' || !iv || !tag || !body) throw new Error('not sealed here');
   const decipher = createDecipheriv(
      'aes-256-gcm',
      rootKey(),
      Buffer.from(iv, 'base64url'),
   );
   decipher.setAuthTag(Buffer.from(tag, 'base64url'));
   return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
   ]).toString('utf8');
};

export const fromJson = <T>(value: unknown, fallback: T): T => {
   if (value === null || value === undefined || value === '') return fallback;
   if (typeof value !== 'string') return value as T;
   try {
      return JSON.parse(value) as T;
   } catch {
      return fallback;
   }
};

let privateKey: KeyObject | null = null;

/* The key pair the panel encrypts with: kept in fund_settings, made anew when
   there is none or it was sealed under another secret. Beside it, `app`:
   whether our Telegram app's keys are set, so the panel can offer the QR. */
export const ensureKeys = async (settings: Row, app: boolean) => {
   const stored = fromJson<{ public?: string; private?: string; app?: boolean }>(
      settings.telegram_keys,
      {},
   );
   if (stored.public && stored.private)
      try {
         privateKey = createPrivateKey(unseal(stored.private));
         if (stored.app !== app)
            await updateRow('fund_settings', {
               guid: settings.guid,
               telegram_keys: JSON.stringify({ ...stored, app }),
            });
         return;
      } catch {
         // sealed under another secret: a new pair
      }
   const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
   });
   privateKey = createPrivateKey(pair.privateKey);
   await updateRow('fund_settings', {
      guid: settings.guid,
      telegram_keys: JSON.stringify({
         public: pair.publicKey.toString('base64'),
         private: seal(pair.privateKey),
         app,
      }),
   });
   console.log('[secrets] a new key pair for the panel');
};

// What the panel encrypted with the public key (RSA-OAEP, SHA-256).
export const openFromPanel = (encrypted: string) => {
   if (!privateKey) throw new Error('no key pair yet');
   return privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(str(encrypted), 'base64'),
   ).toString('utf8');
};
