// D1 结构与访问。只有建表语句是幂等的，任何时候都不会删除已有邮件。
const SCHEMA_VERSION = 1;

const DDL = [
	`CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		token TEXT NOT NULL UNIQUE,
		address TEXT NOT NULL,
		sender TEXT NOT NULL DEFAULT '',
		sender_name TEXT NOT NULL DEFAULT '',
		subject TEXT NOT NULL DEFAULT '',
		code TEXT NOT NULL DEFAULT '',
		text_body TEXT NOT NULL DEFAULT '',
		html_body TEXT NOT NULL DEFAULT '',
		has_html INTEGER NOT NULL DEFAULT 0,
		image_count INTEGER NOT NULL DEFAULT 0,
		raw_size INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'ok',
		received_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_address ON messages(address, received_at)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at)`,
	`CREATE TABLE IF NOT EXISTS images (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
		byte_size INTEGER NOT NULL DEFAULT 0,
		body BLOB NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_images_message_seq ON images(message_id, seq)`,
];

// 每个 isolate 只迁移一次；失败后清空 memo，下次请求重试。
let readyPromise = null;

export function ensureSchema(env) {
	if (!readyPromise) {
		readyPromise = migrate(env).catch((error) => {
			readyPromise = null;
			throw error;
		});
	}
	return readyPromise;
}

async function migrate(env) {
	await env.db.batch(DDL.map((sql) => env.db.prepare(sql)));
	await env.db
		.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
		.bind('schema_version', String(SCHEMA_VERSION))
		.run();
}

function escapeLike(value) {
	return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function insertMessage(env, message) {
	const row = await env.db
		.prepare(
			`INSERT INTO messages (
				token, address, sender, sender_name, subject, code,
				text_body, html_body, has_html, image_count, raw_size, status,
				received_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			message.token,
			message.address,
			message.sender,
			message.senderName,
			message.subject,
			message.code,
			message.text,
			message.html,
			message.hasHtml ? 1 : 0,
			message.imageCount,
			message.rawSize,
			message.status,
			message.receivedAt,
			message.expiresAt,
		)
		.first();

	return row.id;
}

export async function insertImages(env, messageId, images) {
	if (!images.length) return;
	await env.db.batch(
		images.map((image) =>
			env.db
				.prepare('INSERT INTO images (message_id, seq, content_type, byte_size, body) VALUES (?, ?, ?, ?, ?)')
				.bind(messageId, image.seq, image.contentType, image.byteSize, image.body),
		),
	);
}

export async function listMessages(env, options) {
	const where = ['address = ?', 'expires_at > ?'];
	const binds = [options.address, options.now];

	if (options.since) {
		where.push('received_at >= ?');
		binds.push(options.since);
	}
	if (options.after) {
		where.push('id > ?');
		binds.push(options.after);
	}
	if (options.before) {
		where.push('id < ?');
		binds.push(options.before);
	}
	if (options.from) {
		where.push("sender LIKE ? ESCAPE '\\'");
		binds.push(`%${escapeLike(options.from)}%`);
	}
	if (options.subject) {
		where.push("subject LIKE ? ESCAPE '\\'");
		binds.push(`%${escapeLike(options.subject)}%`);
	}

	// after 是"继续查新来信"，按时间正序返回，调用方可顺序处理；
	// 其余情况按最新优先返回，网页直接把第一封显示在顶部。
	// 以接收时间为主键排序，id 只作为同一毫秒内的稳定次序。
	const order = options.after ? 'ASC' : 'DESC';
	const sql = `SELECT id, token, address, sender, sender_name, subject, code,
			received_at, expires_at, has_html, image_count, status
		FROM messages
		WHERE ${where.join(' AND ')}
		ORDER BY received_at ${order}, id ${order}
		LIMIT ?`;
	binds.push(options.limit);

	const { results } = await env.db
		.prepare(sql)
		.bind(...binds)
		.all();

	return results || [];
}

export async function getMessage(env, id, now) {
	return await env.db
		.prepare(
			`SELECT id, token, address, sender, sender_name, subject, code,
				text_body, html_body, has_html, image_count, raw_size, status,
				received_at, expires_at
			FROM messages
			WHERE id = ? AND expires_at > ?`,
		)
		.bind(id, now)
		.first();
}

export async function listImageMeta(env, messageId) {
	const { results } = await env.db
		.prepare('SELECT seq, content_type, byte_size FROM images WHERE message_id = ? ORDER BY seq ASC')
		.bind(messageId)
		.all();
	return results || [];
}

export async function getImageByToken(env, token, seq, now) {
	return await env.db
		.prepare(
			`SELECT i.content_type, i.body
			FROM images i
			JOIN messages m ON m.id = i.message_id
			WHERE m.token = ? AND i.seq = ? AND m.expires_at > ?`,
		)
		.bind(token, seq, now)
		.first();
}

export async function deleteMessage(env, id) {
	const [, result] = await env.db.batch([
		env.db.prepare('DELETE FROM images WHERE message_id = ?').bind(id),
		env.db.prepare('DELETE FROM messages WHERE id = ?').bind(id),
	]);
	return Number(result?.meta?.changes || 0) > 0;
}

// 每条语句处理 200 行，最多循环 4 轮：既满足子请求上限，也不会让一次清理跑太久。
export async function cleanupExpired(env, now) {
	let removed = 0;

	for (let round = 0; round < 4; round += 1) {
		const [, messages] = await env.db.batch([
			env.db
				.prepare(
					`DELETE FROM images WHERE message_id IN (
						SELECT id FROM messages WHERE expires_at <= ? ORDER BY id LIMIT 200
					)`,
				)
				.bind(now),
			env.db
				.prepare('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE expires_at <= ? ORDER BY id LIMIT 200)')
				.bind(now),
		]);

		const changes = Number(messages?.meta?.changes || 0);
		removed += changes;
		if (changes < 200) break;
	}

	return removed;
}
