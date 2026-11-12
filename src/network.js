/**
 * CRAFT & SHARE: ネットワーク通信モジュール (src/network.js)
 * Socket.IO クライアント接続、ワールドRoom参加、移動・ブロック・チャット・掲示板通信を管理します。
 */

import { io } from "socket.io-client";

let socket = null;
let currentWorldId = "default";
let lastKnownPosition = null;
let lastKnownRotation = null;
let lastKnownName = "Player";

let lastSentTime = 0;
let lastSentPosition = null;
let lastSentRotation = null;

const MOVE_SEND_INTERVAL_MS = 50; // 約50ms間隔 (20Hz)
const MIN_POSITION_DIFF = 0.005;
const MIN_ROTATION_DIFF = 0.005;

let connectionState = "disconnected";

const listeners = {
    onConnect: null,
    onDisconnect: null,
    onCurrentPlayers: null,
    onPlayerJoined: null,
    onPlayerLeft: null,
    onPlayerMoved: null,
    onBlockPlaced: null,
    onBlockBroken: null,
    onBlockOperationError: null,
    onChatMessage: null,
    onChatHistory: null,
    onPlayerNameChanged: null,
    onBoardPostCreated: null,
    onBoardPostDeleted: null,
    onWorldMemoCreated: null,
    onWorldMemoDeleted: null
};

const SOCKET_EVENT_MAP = [
    {
        event: "currentPlayers",
        key: "onCurrentPlayers",
        transform: (players) => (Array.isArray(players) ? players.filter((p) => p && p.id !== socket.id) : null)
    },
    {
        event: "playerJoined",
        key: "onPlayerJoined",
        transform: (p) => (p && p.id !== socket.id ? p : null)
    },
    {
        event: "playerMoved",
        key: "onPlayerMoved",
        transform: (data) => (data && data.id !== socket.id ? data : null)
    },
    {
        event: "playerLeft",
        key: "onPlayerLeft",
        transform: (playerId) => (playerId && playerId !== socket.id ? playerId : null)
    },
    {
        event: "chatHistory",
        key: "onChatHistory",
        transform: (history) => (Array.isArray(history) ? history : null)
    },
    { event: "blockPlaced", key: "onBlockPlaced" },
    { event: "blockBroken", key: "onBlockBroken" },
    { event: "blockOperationError", key: "onBlockOperationError" },
    { event: "chatMessage", key: "onChatMessage" },
    { event: "playerNameChanged", key: "onPlayerNameChanged" },
    { event: "boardPostCreated", key: "onBoardPostCreated" },
    { event: "boardPostDeleted", key: "onBoardPostDeleted" },
    { event: "worldMemoCreated", key: "onWorldMemoCreated" },
    { event: "worldMemoDeleted", key: "onWorldMemoDeleted" }
];

function bindSocketEvents() {
    if (!socket) return;
    for (const { event, key, transform } of SOCKET_EVENT_MAP) {
        socket.off(event);
        socket.on(event, (raw) => {
            const payload = transform ? transform(raw) : raw;
            if (payload === null || payload === undefined) return;
            if (listeners[key]) listeners[key](payload);
        });
    }
}

export function initNetwork(worldId = "default") {
    currentWorldId = worldId;
    if (socket) return socket;

    socket = io({
        query: { worldId },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000
    });

    const updateConnectionState = (newState) => {
        connectionState = newState;
    };

    socket.on("connect", () => {
        console.log(`🌐 [マルチプレイ] サーバーに接続しました (Socket ID: ${socket.id}, ワールド: ${worldId})`);
        updateConnectionState("connected");
        if (currentWorldId && lastKnownPosition) {
            joinWorld(currentWorldId, lastKnownPosition, lastKnownRotation, lastKnownName);
        }
        if (listeners.onConnect) listeners.onConnect(socket.id);
    });

    socket.on("connect_error", (error) => {
        console.warn(`⚠️ [マルチプレイ接続警告] 接続エラー: ${error.message}`);
        updateConnectionState("reconnecting");
    });

    socket.on("disconnect", (reason) => {
        console.log(`🔌 [マルチプレイ] サーバーから切断されました (理由: ${reason})`);
        const isManual = reason === "io server disconnect" || reason === "io client disconnect";
        updateConnectionState(isManual ? "disconnected" : "reconnecting");
        if (listeners.onDisconnect) listeners.onDisconnect(reason);
    });

    if (socket.io) {
        socket.io.on("reconnect_attempt", () => updateConnectionState("reconnecting"));
        socket.io.on("reconnect", () => updateConnectionState("connected"));
        socket.io.on("reconnect_failed", () => updateConnectionState("disconnected"));
    }

    bindSocketEvents();

    if (typeof window !== "undefined") {
        window.addEventListener("beforeunload", () => {
            if (socket && socket.connected) socket.disconnect();
        });
    }

    return socket;
}

export function joinWorld(worldId, position, rotation, name) {
    currentWorldId = worldId || currentWorldId;
    if (position) lastKnownPosition = { x: position.x, y: position.y, z: position.z };
    if (rotation) lastKnownRotation = { x: rotation.x, y: rotation.y };
    if (name) lastKnownName = name;

    if (!socket || !socket.connected) return;
    socket.emit("joinWorld", {
        worldId: currentWorldId,
        position: lastKnownPosition || { x: 0, y: 2.1, z: 0 },
        rotation: lastKnownRotation || { x: 0, y: 0 },
        name: lastKnownName
    });
}

export function sendPlayerMove(position, rotation) {
    if (!socket || !socket.connected) return;

    const now = performance.now();
    if (now - lastSentTime < MOVE_SEND_INTERVAL_MS) return;

    if (lastSentPosition && lastSentRotation) {
        const unchanged =
            Math.abs(position.x - lastSentPosition.x) < MIN_POSITION_DIFF &&
            Math.abs(position.y - lastSentPosition.y) < MIN_POSITION_DIFF &&
            Math.abs(position.z - lastSentPosition.z) < MIN_POSITION_DIFF &&
            Math.abs(rotation.x - lastSentRotation.x) < MIN_ROTATION_DIFF &&
            Math.abs(rotation.y - lastSentRotation.y) < MIN_ROTATION_DIFF;
        if (unchanged) return;
    }

    lastSentTime = now;
    lastSentPosition = { x: position.x, y: position.y, z: position.z };
    lastSentRotation = { x: rotation.x, y: rotation.y };
    socket.emit("playerMoved", { position: lastSentPosition, rotation: lastSentRotation });
}

export function requestPlaceBlock(x, y, z, type, operationId) {
    if (!socket || !socket.connected) return false;
    socket.emit("blockPlaceRequest", { x, y, z, type, operationId });
    return true;
}

export function requestBreakBlock(x, y, z, operationId) {
    if (!socket || !socket.connected) return false;
    socket.emit("blockBreakRequest", { x, y, z, operationId });
    return true;
}

export function sendChatMessage(text) {
    if (!socket || !socket.connected) return;
    socket.emit("chatMessage", { text });
}

function emitWithAck(eventName, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        if (!socket || !socket.connected) {
            reject(new Error("サーバーに接続されていません。接続状態を確認してください。"));
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("サーバーからの応答がタイムアウトしました。"));
            }
        }, timeoutMs);

        socket.emit(eventName, payload, (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!res || res.status !== "success") {
                reject(new Error((res && res.error) || "通信エラーが発生しました。"));
                return;
            }
            resolve(res);
        });
    });
}

export async function fetchBoardPosts(authorKey) {
    const res = await emitWithAck("getBoardPosts", { authorKey });
    return { worldId: res.worldId, posts: res.posts || [] };
}

export async function createBoardPost(category, content, authorKey) {
    const res = await emitWithAck("createBoardPost", { category, content, authorKey });
    return res.post;
}

export async function deleteBoardPost(postId, authorKey) {
    const res = await emitWithAck("deleteBoardPost", { postId, authorKey });
    return { id: res.id, worldId: res.worldId };
}

export async function fetchWorldMemos(authorKey) {
    const res = await emitWithAck("getWorldMemos", { authorKey });
    return { worldId: res.worldId, memos: res.memos || [] };
}

export async function createWorldMemo(payload) {
    const res = await emitWithAck("createWorldMemo", payload);
    return res.memo;
}

export async function deleteWorldMemo(memoId, authorKey) {
    const res = await emitWithAck("deleteWorldMemo", { memoId, authorKey });
    return { id: res.id, worldId: res.worldId };
}

export function sendChangeName(name) {
    lastKnownName = name;
    if (!socket || !socket.connected) return;
    socket.emit("changePlayerName", { name });
}

export function isNetworkConnected() {
    return Boolean(socket && socket.connected);
}

export function getSocketId() {
    return socket ? socket.id : null;
}

export function setNetworkListeners(callbacks = {}) {
    for (const key of Object.keys(listeners)) {
        if (callbacks[key] !== undefined) {
            listeners[key] = callbacks[key];
        }
    }
    bindSocketEvents();
}

export function getSocket() {
    return socket;
}

export function getCurrentWorldId() {
    return currentWorldId;
}

export function leaveCurrentWorld() {
    if (socket && socket.connected) {
        socket.emit("leaveWorld");
    }
    currentWorldId = null;
}
