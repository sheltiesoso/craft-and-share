// ==============================================================================
// CRAFT & SHARE: Community Board サーバーモジュール (server/board.js)
// ==============================================================================
const crypto = require('crypto');

const VALID_CATEGORIES = ['交流', 'お知らせ'];
const POST_RATE_LIMIT_MS = 3000;
const MAX_POSTS_PER_WORLD = 200;
const FETCH_LIMIT = 50;

const lastPostTimes = new Map();

function isValidAuthorKey(key) {
    return typeof key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(key);
}

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function safeEqualHash(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 同一DB接続でトランザクションを実行するヘルパー
 */
async function withTransaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * board_posts テーブルの安全なマイグレーション
 */
async function initBoardMigration(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS board_posts (
            id SERIAL PRIMARY KEY,
            world_id VARCHAR(50) NOT NULL,
            player_name VARCHAR(50) NOT NULL,
            author_key_hash VARCHAR(64) NOT NULL,
            category VARCHAR(20) NOT NULL CHECK (category IN ('交流', 'お知らせ')),
            content VARCHAR(300) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_board_world
                FOREIGN KEY (world_id)
                REFERENCES worlds(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_board_posts_world_created
            ON board_posts (world_id, created_at DESC, id DESC);
    `);
}

function cleanupBoardSocket(socketId) {
    lastPostTimes.delete(socketId);
}

/**
 * Socket.IO に掲示板イベントを登録
 */
function registerBoardSocketHandlers(io, socket, { pool, players }) {
    socket.on('getBoardPosts', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const player = players.get(socket.id);
        const worldId = (player && player.worldId) || socket.worldId;
        if (!worldId) return respond({ status: 'error', error: 'ワールドに参加していません。' });

        const authorKey = data && data.authorKey;
        const authorHash = isValidAuthorKey(authorKey) ? hashKey(authorKey) : null;

        try {
            const { rows } = await pool.query(
                `SELECT id, world_id, player_name, author_key_hash, category, content, created_at
                 FROM board_posts WHERE world_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2;`,
                [worldId, FETCH_LIMIT]
            );
            const posts = rows.map((row) => ({
                id: row.id,
                worldId: row.world_id,
                playerName: row.player_name,
                category: row.category,
                content: row.content,
                createdAt: row.created_at,
                isOwner: Boolean(authorHash && safeEqualHash(authorHash, row.author_key_hash))
            }));
            respond({ status: 'success', worldId, posts });
        } catch (err) {
            console.error(`❌ [掲示板取得エラー] ワールド: ${worldId}:`, err.message);
            respond({ status: 'error', error: '掲示板の読み込みに失敗しました。' });
        }
    });

    socket.on('createBoardPost', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const player = players.get(socket.id);
        if (!player || !player.worldId) return respond({ status: 'error', error: 'ワールドに参加していないため投稿できません。' });
        if (!data || typeof data !== 'object') return respond({ status: 'error', error: '投稿データが不正です。' });

        const { category, content, authorKey } = data;
        if (!VALID_CATEGORIES.includes(category)) {
            return respond({ status: 'error', error: 'カテゴリは「交流」または「お知らせ」を選択してください。' });
        }
        if (typeof content !== 'string') {
            return respond({ status: 'error', error: '投稿内容はテキストで入力してください。' });
        }
        const trimmed = content.trim();
        if (trimmed.length < 1 || trimmed.length > 300) {
            return respond({ status: 'error', error: '投稿内容は1〜300文字以内で入力してください。' });
        }
        if (!isValidAuthorKey(authorKey)) {
            return respond({ status: 'error', error: '投稿者認証キーが無効です。ページを再読み込みしてください。' });
        }

        const now = Date.now();
        const lastTime = lastPostTimes.get(socket.id) || 0;
        if (now - lastTime < POST_RATE_LIMIT_MS) {
            const waitSec = Math.ceil((POST_RATE_LIMIT_MS - (now - lastTime)) / 1000);
            return respond({ status: 'error', error: `連続投稿はできません。あと ${waitSec} 秒ほどお待ちください。` });
        }

        const worldId = player.worldId;
        const authorHash = hashKey(authorKey);

        try {
            const createdPost = await withTransaction(pool, async (client) => {
                const worldCheck = await client.query('SELECT id FROM worlds WHERE id = $1;', [worldId]);
                if (worldCheck.rows.length === 0) {
                    const e = new Error('対象のワールドが見つかりません。');
                    e.userMessage = e.message;
                    throw e;
                }

                const { rows } = await client.query(
                    `INSERT INTO board_posts (world_id, player_name, author_key_hash, category, content)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id, world_id, player_name, category, content, created_at;`,
                    [worldId, player.name, authorHash, category, trimmed]
                );

                await client.query(
                    `DELETE FROM board_posts WHERE world_id = $1 AND id NOT IN (
                        SELECT id FROM board_posts WHERE world_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
                     );`,
                    [worldId, MAX_POSTS_PER_WORLD]
                );

                const row = rows[0];
                return {
                    id: row.id,
                    worldId: row.world_id,
                    playerName: row.player_name,
                    category: row.category,
                    content: row.content,
                    createdAt: row.created_at,
                    senderId: socket.id
                };
            });

            lastPostTimes.set(socket.id, now);
            console.log(`📋 [掲示板投稿] [${worldId}] (${category}) <${player.name}> ID:${createdPost.id}`);
            io.to(`world:${worldId}`).emit('boardPostCreated', createdPost);
            respond({ status: 'success', post: createdPost });
        } catch (err) {
            if (!err.userMessage) console.error(`❌ [掲示板投稿エラー] ワールド: ${worldId}:`, err.message);
            respond({ status: 'error', error: err.userMessage || '投稿の保存中にデータベースエラーが発生しました。' });
        }
    });

    socket.on('deleteBoardPost', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const player = players.get(socket.id);
        if (!player || !player.worldId) return respond({ status: 'error', error: 'ワールドに参加していないため削除できません。' });
        if (!data || typeof data !== 'object') return respond({ status: 'error', error: '削除リクエストが不正です。' });

        const postId = Number(data.postId);
        if (!Number.isInteger(postId) || postId <= 0) return respond({ status: 'error', error: '投稿IDが不正です。' });
        if (!isValidAuthorKey(data.authorKey)) {
            return respond({ status: 'error', error: '投稿者認証キーが無効です。削除権限がありません。' });
        }

        const worldId = player.worldId;
        const reqHash = hashKey(data.authorKey);

        try {
            await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    'SELECT id, author_key_hash FROM board_posts WHERE id = $1 AND world_id = $2 FOR UPDATE;',
                    [postId, worldId]
                );
                if (rows.length === 0) {
                    const e = new Error('指定された投稿が見つかりません。既に削除されている可能性があります。');
                    e.userMessage = e.message;
                    throw e;
                }
                if (!safeEqualHash(reqHash, rows[0].author_key_hash)) {
                    const e = new Error('投稿者本人のみ自分の投稿を削除できます。');
                    e.userMessage = e.message;
                    throw e;
                }
                await client.query('DELETE FROM board_posts WHERE id = $1 AND world_id = $2;', [postId, worldId]);
            });

            console.log(`🗑️ [掲示板削除] [${worldId}] ID:${postId} by <${player.name}>`);
            io.to(`world:${worldId}`).emit('boardPostDeleted', { id: postId, worldId });
            respond({ status: 'success', id: postId, worldId });
        } catch (err) {
            if (!err.userMessage) console.error(`❌ [掲示板削除エラー] ワールド: ${worldId}, ID: ${postId}:`, err.message);
            respond({ status: 'error', error: err.userMessage || '投稿の削除中にデータベースエラーが発生しました。' });
        }
    });
}

module.exports = {
    initBoardMigration,
    registerBoardSocketHandlers,
    cleanupBoardSocket,
    isValidAuthorKey,
    hashKey,
    safeEqualHash,
    withTransaction
};

