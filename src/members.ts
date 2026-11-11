import * as bot from './bot.ts';
import { createRow, getRow, guidOf, listRows, type Row, str, updateRow } from './ucode.ts';

/* Who is in a group (tg_members, batch 31), as far as the Bot API tells: its
   admins (asked when the group opens and when the server starts), whoever
   joins or leaves while the bot is in it, and whoever writes. Telegram gives
   a bot no full list of a group, so a person who was there before the bot and
   never wrote is counted in `tg_chats.member_count` but not listed. */

const log = (text: string) => console.log(`[members] ${text}`);
const now = () => new Date().toISOString();

export const members = { botId: 0 };

// What was last written for a person in a group, so a message does not read ucode each time.
const written = new Map<string, string>();

const guidOfMember = (group: Row, userId: number | string) =>
   guidOf(`member:${group.guid}:${userId}`);

const nameOf = (user: bot.TgUser) =>
   [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
   (user.username ? `@${user.username}` : String(user.id));

// Telegram's statuses as kept: a restricted person is still in the group.
const statusOf = (status: string) =>
   status === 'creator' || status === 'administrator'
      ? status
      : status === 'left' || status === 'kicked'
        ? 'left'
        : 'member';

/* A person's status in a group. `status` undefined (they wrote) keeps a
   known one, and brings back one who had left. */
export const noteMember = async (group: Row, user: bot.TgUser, status?: string) => {
   if (user.id === members.botId) return;
   const guid = guidOfMember(group, user.id);
   const known = written.get(guid);
   if (known && (status === undefined ? known !== 'left' : known === statusOf(status))) return;
   const row = known === undefined ? await getRow('tg_members', guid) : undefined;
   const before = known ?? (row ? str(row.status) : undefined);
   const next =
      status !== undefined
         ? statusOf(status)
         : before && before !== 'left'
           ? before
           : 'member';
   const details = {
      name: nameOf(user),
      username: user.username ?? '',
      status: next,
      ...(next === 'left' ? { left_at: now() } : before === 'left' ? { joined_at: now(), left_at: null } : {}),
   };
   if (before === undefined)
      await createRow('tg_members', {
         guid,
         tg_group_id: group.guid,
         user_id: String(user.id),
         joined_at: now(),
         ...details,
      });
   else if (before !== next || !row || str(row.name) !== details.name)
      await updateRow('tg_members', { guid, ...details });
   written.set(guid, next);
};

// How many are in the group, as Telegram counts them.
export const countMembers = async (group: Row) => {
   try {
      const count = await bot.memberCount(str(group.chat_id));
      if (Number(group.member_count) !== count) {
         await updateRow('tg_chats', { guid: group.guid, member_count: count });
         group.member_count = count;
      }
   } catch (error) {
      log(`${str(group.title)}: not counted: ${(error as Error).message}`);
   }
};

// A group just opened, or on start: its admins and its count.
export const seedMembers = async (group: Row) => {
   try {
      for (const admin of await bot.getAdmins(str(group.chat_id)))
         await noteMember(group, admin.user, admin.status);
   } catch (error) {
      log(`${str(group.title)}: admins not read: ${(error as Error).message}`);
   }
   await countMembers(group);
};

/* The people the panel asked to remove (`status` removing): taken out of the
   group, free to come back by a link. Without the right to, the row says so. */
export const processRemovals = async (groups: Row[]) => {
   for (const row of await listRows('tg_members', { status: 'removing' })) {
      const group = groups.find(
         (item) => item.guid === str(row.tg_group_id) && str(item.status) === 'active',
      );
      if (!group) {
         await updateRow('tg_members', {
            guid: row.guid,
            status: 'member',
            error: 'Бот больше не в этой группе',
         });
         continue;
      }
      try {
         await bot.removeMember(str(group.chat_id), str(row.user_id));
         await updateRow('tg_members', { guid: row.guid, status: 'left', left_at: now(), error: '' });
         written.set(row.guid, 'left');
         log(`${str(group.title)}: ${str(row.name)} removed, as the panel asked`);
         await countMembers(group);
      } catch (error) {
         if (!(error instanceof bot.TelegramError) || ![400, 403].includes(error.code)) throw error;
         await updateRow('tg_members', {
            guid: row.guid,
            status: 'member',
            error: `Не удалось удалить: у бота нет права блокировать участников или это администратор группы (${error.message})`,
         });
      }
   }
};
