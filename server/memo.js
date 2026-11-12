// ==============================================================================
// CRAFT & SHARE: ワールド内メモ サーバーモジュール (server/memo.js)
// ==============================================================================
const {
    isValidAuthorKey,
    hashKey,
    safeEqualHash,
    withTransaction
} = require('./board');

const FACE_OFFSETS = {
    px: [1, 0, 0],
    nx: [-1, 0, 0],
    py: [0, 1, 0],
    ny: [0, -1, 0],
    pz: [0, 0, 1],
    nz: [0, 0, -1]
};
const MEMO_RATE_LIMIT_MS = 2000;
const MAX_MEMOS_PER_WORLD = 100;

const lastMemoTimes = new Map();

async function initMemoMigration(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS world_memos (
            id SERIAL PRIMARY KEY,
            world_id VARCHAR(50) NOT NULL,
            player_name VARCHAR(50) NOT NULL,
            author_key_hash VARCHAR(64) NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            z INTEGER NOT NULL,
            face VARCHAR(10) NOT NULL CHECK (face IN ('px', 'nx', 'py', 'ny', 'pz', 'nz')),
            content VARCHAR(150) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_memo_world
                FOREIGN KEY (world_id)
                REFERENCES worlds(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_world_memos_world
            ON world_memos (world_id, created_at DESC, id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_world_memos_pos_face
            ON world_memos (world_id, x, y, z, face);
    `);
}

function cleanupMemoSocket(socketId) {
    lastMemoTimes.delete(socketId);
}

function formatMemoRow(row, isOwner, senderId = null) {
    const memo = {
        id: row.id,
        worldId: row.world_id,
        playerName: row.player_name,
        x: row.x,
        y: row.y,
        z: row.z,
        face: row.face,
        content: row.content,
        createdAt: row.created_at,
        isOwner: Boolean(isOwner)
    };
    if (senderId) memo.senderId = senderId;
    return memo;
}

function registerMemoSocketHandlers(io, socket, { pool, players }) {
    socket.on('getWorldMemos', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const player = players.get(socket.id);
        const worldId = (player && player.worldId) || socket.worldId;
        if (!worldId) return respond({ status: 'error', error: 'ワールドに参加していません。' });

        const authorKey = data && data.authorKey;
        const authorHash = isValidAuthorKey(authorKey) ? hashKey(authorKey) : null;

        try {
            const { rows } = await pool.query(
                `SELECT id, world_id, player_name, author_key_hash, x, y, z, face, content, created_at
                 FROM world_memos WHERE world_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2;`,
                [worldId, MAX_MEMOS_PER_WORLD]
            );
            const memos = rows.map((r) => {
                const isOwner = Boolean(
                    authorHash &&
                    safeEqualHash(authorHash, r.author_key_hash) &&
                    player && player.name === r.player_name
                );
                return formatMemoRow(r, isOwner);
            });
            respond({ status: 'success', worldId, memos });
        } catch (err) {
            console.error(`❌ [メモ取得エラー] ワールド: ${worldId}:`, err.message);
            respond({ status: 'error', error: 'ワールドメモの読み込みに失敗しました。' });
        }
    });

    socket.on('createWorldMemo', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const player = players.get(socket.id);
        if (!player || !player.worldId) return respond({ status: 'error', error: 'ワールドに参加していないためメモを設置できません。' });
        if (!data || typeof data !== 'object') return respond({ status: 'error', error: 'メモデータが不正です。' });

        const { x, y, z, face, content, authorKey } = data;
        if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
            Math.abs(x) > 10000 || Math.abs(y) > 10000 || Math.abs(z) > 10000) {
            return respond({ status: 'error', error: '設置座標が不正です。' });
        }
        const dir = FACE_OFFSETS[face];
        if (!dir) return respond({ status: 'error', error: '設置先の面が不正です。' });

        if (typeof content !== 'string') return respond({ status: 'error', error: 'メモ内容はテキストで入力してください。' });
        const trimmed = content.trim();
        if (trimmed.length < 1 || trimmed.length > 150) {
            return respond({ status: 'error', error: 'メモ内容は1〜150文字以内で入力してください。' });
        }
        if (!isValidAuthorKey(authorKey)) {
            return respond({ status: 'error', error: '投稿者認証キーが無効です。ページを再読み込みしてください。' });
        }

        const now = Date.now();
        const lastTime = lastMemoTimes.get(socket.id) || 0;
        if (now - lastTime < MEMO_RATE_LIMIT_MS) {
            const waitSec = Math.ceil((MEMO_RATE_LIMIT_MS - (now - lastTime)) / 1000);
            return respond({ status: 'error', error: `連続設置はできません。あと ${waitSec} 秒ほどお待ちください。` });
        }

        const worldId = player.worldId;
        const authorHash = hashKey(authorKey);

        try {
            const createdMemo = await withTransaction(pool, async (client) => {
                const worldRes = await client.query('SELECT id FROM worlds WHERE id = $1 FOR UPDATE;', [worldId]);
                if (worldRes.rows.length === 0) {
                    const e = new Error('対象のワールドが見つかりません。');
                    e.userMessage = e.message;
                    throw e;
                }

                // 設置対象ブロックの存在確認
                const blockRes = await client.query(
                    'SELECT 1 FROM blocks WHERE world_id = $1 AND x = $2 AND y = $3 AND z = $4;',
                    [worldId, x, y, z]
                );
                if (blockRes.rows.length === 0) {
                    const e = new Error('メモを設置するブロックが存在しません。');
                    e.userMessage = e.message;
                    throw e;
                }

                // 面の手前に隣接ブロックがないか確認
                const adjRes = await client.query(
                    'SELECT 1 FROM blocks WHERE world_id = $1 AND x = $2 AND y = $3 AND z = $4;',
                    [worldId, x + dir[0], y + dir[1], z + dir[2]]
                );
                if (adjRes.rows.length > 0) {
                    const e = new Error('他のブロックに塞がれている面にはメモを設置できません。');
                    e.userMessage = e.message;
                    throw e;
                }

                // 上限（1ワールド100件）チェック
                const countRes = await client.query(
                    'SELECT COUNT(*)::INTEGER AS cnt FROM world_memos WHERE world_id = $1;',
                    [worldId]
                );
                if (countRes.rows[0].cnt >= MAX_MEMOS_PER_WORLD) {
                    const e = new Error(`このワールドのメモ上限（${MAX_MEMOS_PER_WORLD}件）に達しているため、新しく設置できません。`);
                    e.userMessage = e.message;
                    throw e;
                }

                // 同一面への重複チェック
                const dupRes = await client.query(
                    'SELECT 1 FROM world_memos WHERE world_id = $1 AND x = $2 AND y = $3 AND z = $4 AND face = $5;',
                    [worldId, x, y, z, face]
                );
                if (dupRes.rows.length > 0) {
                    const e = new Error('このブロック面には既にメモが貼られています。');
                    e.userMessage = e.message;
                    throw e;
                }

                const { rows } = await client.query(
                    `INSERT INTO world_memos (world_id, player_name, author_key_hash, x, y, z, face, content)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id, world_id, player_name, x, y, z, face, content, created_at;`,
                    [worldId, player.name, authorHash, x, y, z, face, trimmed]
                );
                return formatMemoRow(rows[0], false, socket.id);
            });

            lastMemoTimes.set(socket.id, now);
            console.log(`📝 [メモ設置] [${worldId}] (${x},${y},${z}:${face}) <${player.name}> ID:${createdMemo.id}`);
            socket.broadcast.to(`world:${worldId}`).emit('worldMemoCreated', createdMemo);
            respond({ status: 'success', memo: { ...createdMemo, isOwner: true } });
        } catch (err) {
            if (!err.userMessage) console.error(`❌ [メモ設置エラー] ワールド: ${worldId}:`, err.message);
            respond({ status: 'error', error: err.userMessage || 'メモの保存中にデータベースエラーが発生しました。' });
        }
    });

    socket.on('deleteWorldMemo', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const player = players.get(socket.id);
        if (!player || !player.worldId) return respond({ status: 'error', error: 'ワールドに参加していないため削除できません。' });
        if (!data || typeof data !== 'object') return respond({ status: 'error', error: '削除リクエストが不正です。' });

        const memoId = Number(data.memoId);
        if (!Number.isInteger(memoId) || memoId <= 0) return respond({ status: 'error', error: 'メモIDが不正です。' });
        if (!isValidAuthorKey(data.authorKey)) {
            return respond({ status: 'error', error: '投稿者認証キーが無効です。削除権限がありません。' });
        }

        const worldId = player.worldId;
        const reqHash = hashKey(data.authorKey);

        try {
            await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    'SELECT id, player_name, author_key_hash FROM world_memos WHERE id = $1 AND world_id = $2 FOR UPDATE;',
                    [memoId, worldId]
                );
                if (rows.length === 0) {
                    const e = new Error('指定されたメモが見つかりません。既に削除されている可能性があります。');
                    e.userMessage = e.message;
                    throw e;
                }
                if (!safeEqualHash(reqHash, rows[0].author_key_hash) || rows[0].player_name !== player.name) {
                    const e = new Error('メモを作成したプレイヤー本人のみ削除できます。');
                    e.userMessage = e.message;
                    throw e;
                }
                await client.query('DELETE FROM world_memos WHERE id = $1 AND world_id = $2;', [memoId, worldId]);
            });

            console.log(`🗑️ [メモ削除] [${worldId}] ID:${memoId} by <${player.name}>`);
            io.to(`world:${worldId}`).emit('worldMemoDeleted', { id: memoId, worldId });
            respond({ status: 'success', id: memoId, worldId });
        } catch (err) {
            if (!err.userMessage) console.error(`❌ [メモ削除エラー] ワールド: ${worldId}, ID: ${memoId}:`, err.message);
            respond({ status: 'error', error: err.userMessage || 'メモの削除中にデータベースエラーが発生しました。' });
        }
    });
}

module.exports = {
    initMemoMigration,
    registerMemoSocketHandlers,
    cleanupMemoSocket
};

