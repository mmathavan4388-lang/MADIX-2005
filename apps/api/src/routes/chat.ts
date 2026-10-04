import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, one, many } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { fileDtos } from '../lib/files.js';
import { notify } from '../services/notify.js';
import { emit } from '../services/events.js';

const idp = z.object({ id: z.string().uuid() });

async function assertMember(convId: string, userId: string) {
  const m = await one(pool, 'SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [convId, userId]);
  if (!m) throw notFound('Conversation not found.');
}
async function members(convId: string) { return (await many(pool, 'SELECT user_id FROM conversation_members WHERE conversation_id=$1', [convId])).map((m) => m.user_id as string); }
async function blockedBetween(a: string, b: string) { return !!(await one(pool, 'SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [a, b])); }

async function messageDtos(rows: any[], viewerId: string) {
  const files = await fileDtos(rows.map((r) => r.file_id));
  const ids = rows.map((r) => r.id);
  const reacts = ids.length ? await many(pool, 'SELECT message_id, emoji, count(*)::int n, bool_or(user_id=$2) mine FROM message_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji', [ids, viewerId]) : [];
  return rows.map((r) => ({
    id: r.id, conversationId: r.conversation_id, senderId: r.sender_id, senderName: r.username, body: r.deleted_at ? '' : r.body, deleted: !!r.deleted_at,
    file: r.deleted_at ? null : files.get(r.file_id) ?? null, replyTo: r.reply_to, createdAt: r.created_at,
    reactions: reacts.filter((x) => x.message_id === r.id).map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine })),
  }));
}
const MSG_SQL = `SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id`;

export async function chatRoutes(app: FastifyInstance) {
  const pre = { preHandler: app.verified };

  app.get('/conversations', pre, async (req) => {
    const uid = req.user!.id;
    const rows = await many(pool, `SELECT c.id, c.kind, c.title, c.last_message_at,
        (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'displayName', p.display_name, 'avatarFileId', p.avatar_file_id)) FROM conversation_members cm2 JOIN users u ON u.id=cm2.user_id JOIN profiles p ON p.user_id=u.id WHERE cm2.conversation_id=c.id AND cm2.user_id<>$1) AS others,
        (SELECT row_to_json(x) FROM (SELECT body, sender_id, deleted_at, file_id IS NOT NULL AS has_file, created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) x) AS last,
        (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>$1 AND m.created_at > cm.last_read_at AND m.deleted_at IS NULL) AS unread
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
      WHERE NOT (c.kind='direct' AND EXISTS (SELECT 1 FROM conversation_members o JOIN blocks b ON (b.blocker_id=$1 AND b.blocked_id=o.user_id) WHERE o.conversation_id=c.id AND o.user_id<>$1))
      ORDER BY c.last_message_at DESC LIMIT 100`, [uid]);
    const files = await fileDtos(rows.flatMap((r) => (r.others ?? []).map((o: any) => o.avatarFileId)));
    return { items: rows.map((r) => ({ ...r, others: (r.others ?? []).map((o: any) => ({ ...o, avatar: files.get(o.avatarFileId) ?? null })) })) };
  });

  app.post('/conversations', pre, async (req) => {
    const b = z.object({ userIds: z.array(z.string().uuid()).min(1).max(49), title: z.string().trim().max(60).optional() }).parse(req.body);
    const uid = req.user!.id; const others = [...new Set(b.userIds.filter((x) => x !== uid))];
    if (!others.length) throw badRequest('Choose someone to chat with.');
    const found = await many(pool, `SELECT id FROM users WHERE id = ANY($1) AND status='active'`, [others]);
    if (found.length !== others.length) throw notFound('User not found.');
    for (const o of others) if (await blockedBetween(uid, o)) throw forbidden('You cannot message this user.');
    if (others.length === 1) {
      const key = [uid, others[0]].sort().join(':');
      const ex = await one(pool, 'SELECT id FROM conversations WHERE direct_key=$1', [key]);
      if (ex) return { id: ex.id };
      const c = await tx(async (t) => {
        const conv = await one(t, `INSERT INTO conversations(kind, direct_key, created_by) VALUES ('direct',$1,$2) ON CONFLICT (direct_key) DO UPDATE SET direct_key=EXCLUDED.direct_key RETURNING id`, [key, uid]);
        await t.query('INSERT INTO conversation_members(conversation_id, user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING', [conv.id, uid, others[0]]);
        return conv;
      });
      return { id: c.id };
    }
    if (!b.title) throw badRequest('Give your group a name.');
    const c = await tx(async (t) => {
      const conv = await one(t, `INSERT INTO conversations(kind, title, created_by) VALUES ('group',$1,$2) RETURNING id`, [b.title, uid]);
      await t.query(`INSERT INTO conversation_members(conversation_id, user_id, role) VALUES ($1,$2,'owner')`, [conv.id, uid]);
      for (const o of others) await t.query('INSERT INTO conversation_members(conversation_id, user_id) VALUES ($1,$2)', [conv.id, o]);
      return conv;
    });
    return { id: c.id };
  });

  app.get('/conversations/:id/messages', pre, async (req) => {
    const { id } = idp.parse(req.params); await assertMember(id, req.user!.id);
    const q = z.object({ before: z.string().optional() }).parse(req.query);
    const rows = await many(pool, `${MSG_SQL} WHERE m.conversation_id=$1 AND ($2::timestamptz IS NULL OR m.created_at < $2) ORDER BY m.created_at DESC LIMIT 40`, [id, q.before ?? null]);
    await pool.query('UPDATE conversation_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2', [id, req.user!.id]);
    return { items: (await messageDtos(rows, req.user!.id)).reverse(), next: rows.length === 40 ? rows[39].created_at : null };
  });

  app.post('/conversations/:id/messages', { ...pre, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = idp.parse(req.params); const uid = req.user!.id; await assertMember(id, uid);
    const b = z.object({ body: z.string().max(4000).default(''), fileId: z.string().uuid().optional(), replyTo: z.string().uuid().optional() }).parse(req.body);
    if (!b.body.trim() && !b.fileId) throw badRequest('Write a message or attach a file.');
    const mem = await members(id);
    const conv = await one(pool, 'SELECT kind FROM conversations WHERE id=$1', [id]);
    if (conv.kind === 'direct') { const other = mem.find((m) => m !== uid)!; if (await blockedBetween(uid, other)) throw forbidden('You cannot message this user.'); }
    if (b.fileId && !(await one(pool, `SELECT 1 FROM files WHERE id=$1 AND owner_id=$2 AND status='ready' AND purpose='chat'`, [b.fileId, uid]))) throw badRequest('Attachment not found.');
    if (b.replyTo && !(await one(pool, 'SELECT 1 FROM messages WHERE id=$1 AND conversation_id=$2', [b.replyTo, id]))) throw badRequest('Reply target not found.');
    const m = await tx(async (t) => {
      const r = await one(t, 'INSERT INTO messages(conversation_id, sender_id, body, file_id, reply_to) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, uid, b.body, b.fileId ?? null, b.replyTo ?? null]);
      await t.query('UPDATE conversations SET last_message_at=now() WHERE id=$1', [id]);
      return r;
    });
    const dto = (await messageDtos(await many(pool, `${MSG_SQL} WHERE m.id=$1`, [m.id]), uid))[0];
    void emit(mem, 'message', { conversationId: id, messageId: m.id });
    for (const other of mem.filter((x) => x !== uid)) {
      const muted = await one(pool, 'SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [other, uid]);
      if (!muted) await notify(other, 'message', `New message from ${req.user!.username}`, b.body.slice(0, 80) || 'Sent an attachment', { conversationId: id });
    }
    return reply.status(201).send(dto);
  });

  app.delete('/messages/:id', pre, async (req) => {
    const { id } = idp.parse(req.params);
    const m = await one(pool, `UPDATE messages SET deleted_at=now() WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL RETURNING conversation_id`, [id, req.user!.id]);
    if (!m) throw notFound('Message not found.');
    void emit(await members(m.conversation_id), 'message', { conversationId: m.conversation_id, messageId: id });
    return { ok: true };
  });
  app.put('/messages/:id/reaction', pre, async (req) => {
    const { id } = idp.parse(req.params); const b = z.object({ emoji: z.string().min(1).max(16).nullable() }).parse(req.body);
    const m = await one(pool, 'SELECT conversation_id FROM messages WHERE id=$1', [id]);
    if (!m) throw notFound(); await assertMember(m.conversation_id, req.user!.id);
    if (b.emoji) await pool.query('INSERT INTO message_reactions(message_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT (message_id,user_id) DO UPDATE SET emoji=$3', [id, req.user!.id, b.emoji]);
    else await pool.query('DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2', [id, req.user!.id]);
    void emit(await members(m.conversation_id), 'message', { conversationId: m.conversation_id, messageId: id });
    return { ok: true };
  });
  app.post('/conversations/:id/leave', pre, async (req) => {
    const { id } = idp.parse(req.params);
    await pool.query(`DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 AND conversation_id IN (SELECT id FROM conversations WHERE kind='group')`, [id, req.user!.id]);
    return { ok: true };
  });
}
