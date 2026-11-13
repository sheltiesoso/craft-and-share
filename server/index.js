// ==============================================================================
// CRAFT & SHARE: Express & Socket.IO バックエンドサーバー (server/index.js)
// ==============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { pool, testConnection } = require('./db');
const { initBoardMigration, registerBoardSocketHandlers, cleanupBoardSocket } = require('./board');
const { initMemoMigration, registerMemoSocketHandlers, cleanupMemoSocket } = require('./memo');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 5000,
    pingInterval: 5000
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const distPath = path.join(__dirname, '..', 'dist');
const indexHtmlPath = path.join(distPath, 'index.html');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(distPath));

const VALID_BLOCK_TYPES = ['grass', 'dirt', 'stone', 'wood', 'sand', 'glass', 'leaves', 'brick'];
const TERRAIN_MIN = -2;
const TERRAIN_MAX = 21; // 24×24（中心(9.5, 9.5)を維持しつつ少し拡張）
const PLAYER_COLORS = ['#3B82F6', '#10B981', '#EF4444', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];

const players = new Map();
const verifiedWorlds = new Set(['default']);
const worldVerificationPromises = new Map();
const chatHistories = new Map();
const blockOperationQueues = new Map();
const lastChatTimes = new Map();
let colorIndex = 0;

const ENABLE_PERF_LOG = process.env.ENABLE_PERF_LOG !== 'false';
function logServerPerf(message) {
    if (ENABLE_PERF_LOG) console.log(`⏱️ [Server Perf] ${message}`);
}

function generateInitialTerrainBlocks() {
    const blocks = [];
    for (let x = TERRAIN_MIN; x <= TERRAIN_MAX; x++) {
        for (let z = TERRAIN_MIN; z <= TERRAIN_MAX; z++) {
            // 掲示板（x=10..11, z=12）と重ならないよう丘の中心を(17, 17)へ配置（範囲: 14..20）
            const hillDist = Math.max(Math.abs(x - 17), Math.abs(z - 17));
            const rockDist = Math.max(Math.abs(x - 4), Math.abs(z - 4));
            let topY = 0;
            if (hillDist <= 1) topY = 3;
            else if (hillDist === 2) topY = 2;
            else if (hillDist === 3) topY = 1;
            else if (rockDist === 0) topY = 2;
            else if (rockDist === 1) topY = 1;

            for (let y = 0; y <= topY; y++) {
                const type = rockDist <= 1 ? 'stone' : (y === topY ? 'grass' : 'dirt');
                blocks.push({ x, y, z, type });
            }
        }
    }
    // 角エリア（x=0..1, z=18..19）にアクセントの木ブロックを配置
    blocks.push(
        { x: 0, y: 1, z: 19, type: 'wood' },
        { x: 1, y: 1, z: 19, type: 'wood' },
        { x: 1, y: 1, z: 18, type: 'wood' }
    );
    return blocks;
}

/**
 * ワールドの初期地形をトランザクション内で生成・保存（既に初期化済みなら何もしない）
 */
async function initializeWorldTerrain(client, worldId) {
    const lockRes = await client.query('SELECT is_initialized FROM worlds WHERE id = $1 FOR UPDATE;', [worldId]);
    if (lockRes.rows.length === 0 || lockRes.rows[0].is_initialized) {
        return false;
    }

    await client.query('DELETE FROM blocks WHERE world_id = $1;', [worldId]);

    const blocks = generateInitialTerrainBlocks();
    const CHUNK_SIZE = 200;
    for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
        const chunk = blocks.slice(i, i + CHUNK_SIZE);
        const values = [];
        const placeholders = [];
        chunk.forEach((b, idx) => {
            const base = idx * 5;
            placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, CURRENT_TIMESTAMP)`);
            values.push(worldId, b.x, b.y, b.z, b.type);
        });
        await client.query(
            `INSERT INTO blocks (world_id, x, y, z, block_type, updated_at)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (world_id, x, y, z) DO UPDATE SET block_type = EXCLUDED.block_type, updated_at = CURRENT_TIMESTAMP;`,
            values
        );
    }

    await client.query('UPDATE worlds SET is_initialized = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1;', [worldId]);
    console.log(`🌱 [初期地形生成] ワールド '${worldId}' に ${blocks.length} ブロックを生成・保存しました`);
    return true;
}

async function initDatabaseMigration() {
    try {
        await pool.query(`
            ALTER TABLE worlds ADD COLUMN IF NOT EXISTS name VARCHAR(100);
            ALTER TABLE worlds ADD COLUMN IF NOT EXISTS host_key_hash VARCHAR(64);
            UPDATE worlds SET name = 'デフォルトワールド' WHERE id = 'default' AND (name IS NULL OR name = '');
        `);
        await initBoardMigration(pool);
        await initMemoMigration(pool);
        console.log('✅ [DBマイグレーション] worlds / board_posts / world_memos テーブルのスキーマを確認・更新しました');
    } catch (error) {
        console.error('⚠️ [DBマイグレーション警告]:', error.message);
    }
}

app.get('/health', async (req, res) => {
    const isDbConnected = await testConnection();
    res.json({
        status: 'ok',
        message: 'CRAFT & SHARE サーバーは正常に稼働しています',
        database: isDbConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/worlds', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                w.id,
                COALESCE(w.name, w.id) AS name,
                w.is_initialized,
                w.created_at,
                w.updated_at,
                COUNT(b.x)::INTEGER AS block_count
            FROM worlds w
            LEFT JOIN blocks b ON w.id = b.world_id
            GROUP BY w.id, w.name, w.is_initialized, w.created_at, w.updated_at
            ORDER BY w.updated_at DESC, w.created_at DESC;
        `);
        res.json({ status: 'success', worlds: result.rows });
    } catch (error) {
        console.error('❌ [API GET /api/worlds エラー]:', error);
        res.status(500).json({ error: 'ワールド一覧の取得中にサーバーエラーが発生しました。', details: error.message });
    }
});

app.post('/api/worlds', async (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'ワールド名は必須です。' });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 50) {
        return res.status(400).json({ error: 'ワールド名は1〜50文字以内で入力してください。' });
    }

    const client = await pool.connect();
    try {
        const checkResult = await client.query('SELECT id FROM worlds WHERE name = $1;', [trimmedName]);
        if (checkResult.rows.length > 0) {
            return res.status(409).json({ error: `ワールド名「${trimmedName}」は既に使用されています。別の名前を入力してください。` });
        }

        const newWorldId = `world-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
        const hostKey = crypto.randomBytes(32).toString('hex');
        const hostKeyHash = crypto.createHash('sha256').update(hostKey).digest('hex');

        await client.query('BEGIN');
        await client.query(
            `INSERT INTO worlds (id, name, host_key_hash, is_initialized, created_at, updated_at)
             VALUES ($1, $2, $3, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`,
            [newWorldId, trimmedName, hostKeyHash]
        );
        await initializeWorldTerrain(client, newWorldId);
        const worldRes = await client.query(
            'SELECT id, name, is_initialized, created_at, updated_at FROM worlds WHERE id = $1;',
            [newWorldId]
        );
        await client.query('COMMIT');

        verifiedWorlds.add(newWorldId);
        console.log(`✨ [ワールド新規作成] ID: ${newWorldId}, 名前: ${trimmedName}`);
        res.status(201).json({ status: 'success', world: worldRes.rows[0], hostKey });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ [API POST /api/worlds エラー]:', error);
        res.status(500).json({ error: 'ワールドの作成中にエラーが発生しました。', details: error.message });
    } finally {
        client.release();
    }
});

app.delete('/api/worlds/:worldId', async (req, res) => {
    const { worldId } = req.params;
    const hostKey = req.headers['x-host-key'] || (req.body && req.body.hostKey);

    if (worldId === 'default') {
        return res.status(403).json({ error: 'デフォルトワールドは削除できません。' });
    }
    if (!hostKey || typeof hostKey !== 'string') {
        return res.status(401).json({ error: 'ホスト認証キーが必要です。' });
    }

    try {
        const worldRes = await pool.query('SELECT id, name, host_key_hash FROM worlds WHERE id = $1;', [worldId]);
        if (worldRes.rows.length === 0) {
            return res.status(404).json({ error: '指定されたワールドが見つかりません。' });
        }
        const targetWorld = worldRes.rows[0];
        if (!targetWorld.host_key_hash) {
            return res.status(403).json({ error: 'このワールドには削除権限が設定されていないため、削除できません。' });
        }

        const reqHash = crypto.createHash('sha256').update(hostKey).digest('hex');
        const hashA = Buffer.from(reqHash, 'utf8');
        const hashB = Buffer.from(targetWorld.host_key_hash, 'utf8');
        if (hashA.length !== hashB.length || !crypto.timingSafeEqual(hashA, hashB)) {
            return res.status(403).json({ error: 'ホスト認証キーが無効です。ワールドの削除権限がありません。' });
        }

        let activePlayerCount = 0;
        for (const p of players.values()) {
            if (p.worldId === worldId) activePlayerCount++;
        }
        const room = io.sockets.adapter.rooms.get(`world:${worldId}`);
        if (room && room.size > 0) {
            activePlayerCount = Math.max(activePlayerCount, room.size);
        }
        if (activePlayerCount > 0) {
            return res.status(409).json({
                error: `現在 ${activePlayerCount} 人のプレイヤーがワールドに参加中のため、削除できません。全員が退出してから再度お試しください。`
            });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM blocks WHERE world_id = $1;', [worldId]);
            await client.query('DELETE FROM worlds WHERE id = $1;', [worldId]);
            await client.query('COMMIT');
        } catch (dbErr) {
            await client.query('ROLLBACK');
            throw dbErr;
        } finally {
            client.release();
        }

        verifiedWorlds.delete(worldId);
        chatHistories.delete(worldId);
        console.log(`🗑️ [ワールド削除完了] ID: ${worldId}, 名前: ${targetWorld.name}`);
        res.json({ status: 'success', message: `ワールド「${targetWorld.name}」を正常に削除しました。` });
    } catch (error) {
        console.error('❌ [API DELETE /api/worlds/:worldId エラー]:', error);
        res.status(500).json({ error: 'ワールドの削除中にサーバーエラーが発生しました。', details: error.message });
    }
});

app.get('/api/world', async (req, res) => {
    const worldId = req.query.world_id || req.query.worldId || 'default';
    try {
        const worldResult = await pool.query(
            'SELECT id, COALESCE(name, id) AS name, is_initialized FROM worlds WHERE id = $1;',
            [worldId]
        );
        if (worldResult.rows.length === 0) {
            return res.status(404).json({ error: `ワールド '${worldId}' が見つかりませんでした。` });
        }
        const worldData = worldResult.rows[0];

        if (!worldData.is_initialized) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await initializeWorldTerrain(client, worldId);
                await client.query('COMMIT');
                worldData.is_initialized = true;
            } catch (initErr) {
                await client.query('ROLLBACK').catch(() => {});
                throw initErr;
            } finally {
                client.release();
            }
        }

        const blocksResult = await pool.query(
            'SELECT x, y, z, block_type AS type FROM blocks WHERE world_id = $1 ORDER BY y ASC, z ASC, x ASC;',
            [worldId]
        );
        res.json({
            world_id: worldData.id,
            name: worldData.name,
            is_initialized: worldData.is_initialized,
            blocks: blocksResult.rows
        });
    } catch (error) {
        console.error('❌ [API GET /api/world エラー]:', error);
        res.status(500).json({ error: 'ワールド情報の取得中にサーバーエラーが発生しました。', details: error.message });
    }
});

app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io') && fs.existsSync(indexHtmlPath)) {
        return res.sendFile(indexHtmlPath);
    }
    next();
});

async function ensureWorldExists(worldId) {
    if (verifiedWorlds.has(worldId)) return;
    if (worldVerificationPromises.has(worldId)) return worldVerificationPromises.get(worldId);

    const p = (async () => {
        await pool.query(
            `INSERT INTO worlds (id, is_initialized, updated_at) VALUES ($1, TRUE, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING;`,
            [worldId]
        );
        verifiedWorlds.add(worldId);
    })().finally(() => {
        worldVerificationPromises.delete(worldId);
    });
    worldVerificationPromises.set(worldId, p);
    return p;
}

function enqueueBlockOperation(worldId, x, y, z, operationFn) {
    const key = `${worldId}:${x},${y},${z}`;
    const prev = blockOperationQueues.get(key) || Promise.resolve();
    const curr = prev
        .catch(() => {})
        .then(() => operationFn())
        .finally(() => {
            if (blockOperationQueues.get(key) === curr) blockOperationQueues.delete(key);
        });
    blockOperationQueues.set(key, curr);
    return curr;
}

function sanitizeWorldId(rawId) {
    return typeof rawId === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(rawId) ? rawId : 'default';
}

function sanitizePlayerName(rawName, fallbackId) {
    if (typeof rawName === 'string') {
        const trimmed = rawName.trim();
        if (trimmed.length >= 1 && trimmed.length <= 20) return trimmed;
    }
    const shortId = (fallbackId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4) || '0001';
    return `Player-${shortId}`;
}

function handleBlockRequest(socket, data, isPlace) {
    const player = players.get(socket.id);
    if (!player || !data || typeof data !== 'object') return;

    const { x, y, z, type, operationId } = data;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    if (Math.abs(x) > 10000 || Math.abs(y) > 10000 || Math.abs(z) > 10000) return;
    if (isPlace && !VALID_BLOCK_TYPES.includes(type)) return;

    const worldId = player.worldId || 'default';
    const targetRoom = `world:${worldId}`;
    const reqRecvTime = performance.now();

    enqueueBlockOperation(worldId, x, y, z, async () => {
        const queueWaitTime = performance.now() - reqRecvTime;
        const dbStartTime = performance.now();
        try {
            if (isPlace) {
                await ensureWorldExists(worldId);
                const memoCheck = await pool.query(
                    `SELECT 1 FROM world_memos
                     WHERE world_id = $1 AND (
                         (face = 'px' AND x + 1 = $2 AND y = $3 AND z = $4) OR
                         (face = 'nx' AND x - 1 = $2 AND y = $3 AND z = $4) OR
                         (face = 'py' AND x = $2 AND y + 1 = $3 AND z = $4) OR
                         (face = 'ny' AND x = $2 AND y - 1 = $3 AND z = $4) OR
                         (face = 'pz' AND x = $2 AND y = $3 AND z + 1 = $4) OR
                         (face = 'nz' AND x = $2 AND y = $3 AND z - 1 = $4)
                     ) LIMIT 1;`,
                    [worldId, x, y, z]
                );
                if (memoCheck.rows.length > 0) {
                    throw new Error('メモが貼られている面の前にはブロックを設置できません。');
                }

                await pool.query(
                    `INSERT INTO blocks (world_id, x, y, z, block_type, updated_at)
                     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                     ON CONFLICT (world_id, x, y, z) DO UPDATE SET block_type = EXCLUDED.block_type, updated_at = CURRENT_TIMESTAMP;`,
                    [worldId, x, y, z, type]
                );
                const dbDuration = performance.now() - dbStartTime;
                logServerPerf(`[設置完了] ワールド: ${worldId}, pos: (${x},${y},${z}), type: ${type}, キュー待ち: ${queueWaitTime.toFixed(1)}ms, DB処理: ${dbDuration.toFixed(1)}ms, op: ${operationId || 'none'}`);
                io.to(targetRoom).emit('blockPlaced', { x, y, z, type, operationId, senderId: socket.id });
            } else {
                await pool.query('DELETE FROM blocks WHERE world_id = $1 AND x = $2 AND y = $3 AND z = $4;', [worldId, x, y, z]);
                const dbDuration = performance.now() - dbStartTime;
                logServerPerf(`[破壊完了] ワールド: ${worldId}, pos: (${x},${y},${z}), キュー待ち: ${queueWaitTime.toFixed(1)}ms, DB処理: ${dbDuration.toFixed(1)}ms, op: ${operationId || 'none'}`);
                io.to(targetRoom).emit('blockBroken', { x, y, z, operationId, senderId: socket.id });
            }
        } catch (error) {
            const dbDuration = performance.now() - dbStartTime;
            const label = isPlace ? '設置' : '破壊';
            logServerPerf(`[${label}失敗] ワールド: ${worldId}, pos: (${x},${y},${z}), DB処理: ${dbDuration.toFixed(1)}ms, err: ${error.message}`);
            console.error(`❌ [DBエラー] ブロック${label}失敗 (${worldId}, ${x}, ${y}, ${z}):`, error.message);
            socket.emit('blockOperationError', {
                operation: isPlace ? 'place' : 'break',
                x, y, z,
                operationId,
                message: isPlace ? 'データベースへのブロック保存に失敗しました' : 'データベースからのブロック削除に失敗しました',
                details: error.message
            });
        }
    });
}

function handlePlayerExit(socket, shouldLeaveRoom) {
    const player = players.get(socket.id);
    const worldId = (player && player.worldId) || socket.worldId || 'default';
    const targetRoom = `world:${worldId}`;

    if (player) players.delete(socket.id);
    lastChatTimes.delete(socket.id);
    cleanupBoardSocket(socket.id);
    cleanupMemoSocket(socket.id);

    io.to(targetRoom).emit('playerLeft', socket.id);
    if (shouldLeaveRoom) {
        socket.leave(targetRoom);
        socket.worldId = null;
        socket.roomName = null;
    }

    return { worldId, remaining: io.sockets.adapter.rooms.get(targetRoom)?.size || 0 };
}

io.on('connection', (socket) => {
    const initialWorldId = sanitizeWorldId(socket.handshake.query.worldId);
    const roomName = `world:${initialWorldId}`;
    socket.join(roomName);
    socket.worldId = initialWorldId;
    socket.roomName = roomName;

    const roomSize = io.sockets.adapter.rooms.get(roomName)?.size || 1;
    console.log(`🔌 [Socket.IO 接続] プレイヤー接続: ${socket.id} (ワールド: ${initialWorldId}, Room人数: ${roomSize})`);

    socket.on('joinWorld', (data) => {
        const worldId = sanitizeWorldId((data && data.worldId) || socket.worldId);
        const targetRoom = `world:${worldId}`;

        if (socket.roomName && socket.roomName !== targetRoom) {
            io.to(socket.roomName).emit('playerLeft', socket.id);
            socket.leave(socket.roomName);
        }

        socket.join(targetRoom);
        socket.worldId = worldId;
        socket.roomName = targetRoom;

        // 切断済みの古いソケットがあればクリーンアップ
        for (const [existingId, existingPlayer] of players.entries()) {
            const clientSocket = io.sockets.sockets.get(existingId);
            if (!clientSocket || !clientSocket.connected) {
                players.delete(existingId);
                lastChatTimes.delete(existingId);
                cleanupBoardSocket(existingId);
                cleanupMemoSocket(existingId);
                io.to(`world:${existingPlayer.worldId}`).emit('playerLeft', existingId);
            }
        }

        const newPlayer = {
            id: socket.id,
            worldId,
            name: sanitizePlayerName(data && data.name, socket.id),
            position: (data && data.position) || { x: 0, y: 2.1, z: 0 },
            rotation: (data && data.rotation) || { x: 0, y: 0 },
            color: PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length]
        };
        players.set(socket.id, newPlayer);

        const existingPlayersInWorld = [];
        for (const [id, p] of players.entries()) {
            if (p.worldId === worldId && id !== socket.id) existingPlayersInWorld.push(p);
        }
        socket.emit('currentPlayers', existingPlayersInWorld);
        socket.emit('chatHistory', chatHistories.get(worldId) || []);
        socket.to(targetRoom).emit('playerJoined', newPlayer);

        const currentSize = io.sockets.adapter.rooms.get(targetRoom)?.size || 1;
        console.log(`🎮 [マルチプレイ参加] ${socket.id} (${newPlayer.name}, ワールド: ${worldId}, Room人数: ${currentSize})`);
    });

    socket.on('changePlayerName', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        const newName = sanitizePlayerName(data && data.name, socket.id);
        player.name = newName;
        io.to(`world:${player.worldId}`).emit('playerNameChanged', { id: socket.id, name: newName });
    });

    socket.on('chatMessage', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const now = Date.now();
        if (now - (lastChatTimes.get(socket.id) || 0) < 500) return;
        lastChatTimes.set(socket.id, now);

        if (!data || typeof data.text !== 'string') return;
        const text = data.text.trim();
        if (text.length < 1 || text.length > 200) return;

        const worldId = player.worldId || 'default';
        const messageObj = {
            id: `${socket.id}-${now}`,
            senderId: socket.id,
            senderName: player.name,
            senderColor: player.color,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        if (!chatHistories.has(worldId)) chatHistories.set(worldId, []);
        const history = chatHistories.get(worldId);
        history.push(messageObj);
        if (history.length > 50) history.shift();

        io.to(`world:${worldId}`).emit('chatMessage', messageObj);
    });

    socket.on('playerMoved', (data) => {
        const player = players.get(socket.id);
        const pos = data && data.position;
        if (!player || !pos || typeof pos !== 'object') return;
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
        if (Math.abs(pos.x) > 10000 || Math.abs(pos.y) > 10000 || Math.abs(pos.z) > 10000) return;

        const rotData = data.rotation && typeof data.rotation === 'object' ? data.rotation : {};
        player.position = { x: pos.x, y: pos.y, z: pos.z };
        player.rotation = {
            x: Number.isFinite(rotData.x) ? rotData.x : 0,
            y: Number.isFinite(rotData.y) ? rotData.y : 0
        };

        socket.to(`world:${player.worldId}`).emit('playerMoved', {
            id: socket.id,
            position: player.position,
            rotation: player.rotation
        });
    });

    socket.on('blockPlaceRequest', (data) => handleBlockRequest(socket, data, true));
    socket.on('blockBreakRequest', (data) => handleBlockRequest(socket, data, false));

    registerBoardSocketHandlers(io, socket, { pool, players });
    registerMemoSocketHandlers(io, socket, { pool, players });

    socket.on('leaveWorld', () => {
        const { worldId, remaining } = handlePlayerExit(socket, true);
        console.log(`🚪 [ワールド退出] ${socket.id} が ${worldId} から退出 (残り: ${remaining})`);
    });

    socket.on('disconnect', (reason) => {
        const { worldId, remaining } = handlePlayerExit(socket, false);
        console.log(`❌ [Socket.IO 切断] ${socket.id} (ワールド: ${worldId}, 残り: ${remaining}, 理由: ${reason})`);
    });
});

server.listen(PORT, HOST, async () => {
    console.log('==================================================');
    console.log(`🚀 CRAFT & SHARE サーバー起動 (http://${HOST}:${PORT})`);
    console.log('==================================================');
    if (await testConnection()) {
        await initDatabaseMigration();
    }
});
