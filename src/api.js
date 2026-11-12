/**
 * CRAFT & SHARE: API 通信モジュール (src/api.js)
 * ExpressバックエンドサーバーとのHTTP通信（ワールド取得・一覧・作成・削除）を担当します。
 */

async function requestJson(url, options = {}, errorPrefix = "") {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        let errorDetails = `HTTP ${response.status}`;
        try {
            const errorJson = await response.json();
            if (errorJson.error) errorDetails = errorJson.error;
        } catch (_) {
            // JSONパース失敗時はHTTPステータスをそのまま使用
        }
        throw new Error(errorPrefix ? `${errorPrefix}: ${errorDetails}` : errorDetails);
    }

    return await response.json();
}

export function fetchWorld(worldId = "default") {
    return requestJson(`/api/world?world_id=${encodeURIComponent(worldId)}`, { method: "GET" }, "ワールド取得失敗");
}

export async function fetchWorldList() {
    const data = await requestJson("/api/worlds", { method: "GET" }, "ワールド一覧取得失敗");
    return data.worlds || [];
}

export async function createWorld(name) {
    const data = await requestJson("/api/worlds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    return { world: data.world, hostKey: data.hostKey };
}

export function deleteWorld(worldId, hostKey) {
    return requestJson(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: "DELETE",
        headers: {
            "Content-Type": "application/json",
            "X-Host-Key": hostKey || ""
        },
        body: JSON.stringify({ hostKey })
    });
}
