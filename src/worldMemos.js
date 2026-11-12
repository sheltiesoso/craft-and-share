import { MeshBuilder, StandardMaterial, Color3, Texture } from "@babylonjs/core";
import { getOrCreateAuthorKey } from "./communityBoard.js";
import { fetchWorldMemos, createWorldMemo, deleteWorldMemo } from "./network.js";

const FACES = {
    px: { dir: [1, 0, 0],   rot: [0, -Math.PI / 2, 0] },
    nx: { dir: [-1, 0, 0],  rot: [0, Math.PI / 2, 0] },
    py: { dir: [0, 1, 0],   rot: [Math.PI / 2, 0, 0] },
    ny: { dir: [0, -1, 0],  rot: [-Math.PI / 2, 0, 0] },
    pz: { dir: [0, 0, 1],   rot: [0, Math.PI, 0] },
    nz: { dir: [0, 0, -1],  rot: [0, 0, 0] }
};

function getNormalFace(normal) {
    if (!normal) return null;
    const nx = Math.round(normal.x), ny = Math.round(normal.y), nz = Math.round(normal.z);
    if (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) !== 1) return null;
    if (nx === 1) return "px";
    if (nx === -1) return "nx";
    if (ny === 1) return "py";
    if (ny === -1) return "ny";
    return nz === 1 ? "pz" : "nz";
}

function formatMemoDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("ja-JP", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
}

export function createWorldMemos({
    scene,
    blockSize,
    offset,
    world,
    getActiveWorld,
    getSocketId,
    isGameReady,
    isBlockedByOtherUI,
    clearPlayerInputState,
    releasePointerLockSafely,
    requestPointerLockSafely,
    hideTargetOutline,
    showStatus
}) {
    const memosById = new Map();
    let activeModal = null; // "create" | "view" | null
    let pendingTarget = null;
    let viewingMemoId = null;
    let paperMat = null;

    // DOMキャッシュ
    let el = {};
    const getEl = () => {
        if (!el.modal) {
            el = {
                modal: document.getElementById("memoModal"),
                title: document.getElementById("memoModalTitle"),
                error: document.getElementById("memoModalError"),
                view: document.getElementById("memoViewSection"),
                author: document.getElementById("memoViewAuthor"),
                date: document.getElementById("memoViewDate"),
                content: document.getElementById("memoViewContent"),
                form: document.getElementById("memoCreateForm"),
                input: document.getElementById("memoCreateInput"),
                counter: document.getElementById("memoCreateCounter"),
                submit: document.getElementById("memoSubmitBtn"),
                del: document.getElementById("memoDeleteBtn"),
                cancel: document.getElementById("memoCancelBtn")
            };
        }
        return el;
    };

    const getPaperMaterial = () => {
        if (!paperMat) {
            paperMat = new StandardMaterial("worldMemoPaperMat", scene);
            const tex = new Texture("/assets/memo-paper.png", scene);
            tex.hasAlpha = true;
            paperMat.diffuseTexture = tex;
            paperMat.useAlphaFromDiffuseTexture = true;
            paperMat.specularColor = new Color3(0, 0, 0);
            paperMat.backFaceCulling = false;
        }
        return paperMat;
    };

    const addMemo = (memo) => {
        if (!memo || !FACES[memo.face]) return;
        if (memosById.has(memo.id)) {
            const existing = memosById.get(memo.id);
            const keepOwner = Boolean(existing.data?.isOwner || memo.isOwner);
            existing.data = { ...existing.data, ...memo, isOwner: keepOwner };
            return;
        }
        const { dir: [dx, dy, dz], rot: [rx, ry, rz] } = FACES[memo.face];
        const dist = blockSize / 2 + 0.005;
        const mesh = MeshBuilder.CreatePlane(`world_memo_${memo.id}`, { width: 0.54, height: 0.42 }, scene);
        mesh.material = getPaperMaterial();
        mesh.position.set(
            memo.x * blockSize - offset + dx * dist,
            memo.y * blockSize + dy * dist,
            memo.z * blockSize - offset + dz * dist
        );
        mesh.rotation.set(rx, ry, rz);
        mesh.isPickable = true;
        mesh.checkCollisions = false;
        mesh.metadata = { isWorldMemo: true, memoId: memo.id };
        memosById.set(memo.id, { data: memo, mesh });
    };

    const removeMemo = (memoId) => {
        const entry = memosById.get(memoId);
        if (!entry) return;
        try { entry.mesh?.dispose(); } catch (_) {}
        memosById.delete(memoId);
        if (activeModal === "view" && viewingMemoId === memoId) {
            closeModal(false);
            showStatus?.("このメモは削除されました", "info", 3000);
        }
    };

    const clearAll = () => {
        for (const entry of memosById.values()) {
            try { entry.mesh?.dispose(); } catch (_) {}
        }
        memosById.clear();
        closeModal(false);
    };

    const setError = (msg = "") => {
        const ui = getEl();
        if (ui.error) {
            ui.error.textContent = msg;
            ui.error.style.display = msg ? "block" : "none";
        }
    };

    const prepareModalOpen = (type) => {
        activeModal = type;
        clearPlayerInputState();
        releasePointerLockSafely();
        hideTargetOutline();
        setError("");
    };

    const closeModal = (shouldRequestLock = false) => {
        const ui = getEl();
        if (ui.modal) ui.modal.style.display = "none";
        activeModal = null;
        pendingTarget = null;
        viewingMemoId = null;
        clearPlayerInputState();
        if (shouldRequestLock) requestPointerLockSafely();
    };

    const openCreateForHit = (hit) => {
        if (!isGameReady() || activeModal || isBlockedByOtherUI()) return;
        const meta = hit?.hit && hit.pickedMesh?.metadata;
        if (!meta?.isBlock) return;
        const face = getNormalFace(hit.getNormal(true));
        if (!face) return;

        const { x, y, z } = meta;
        const [dx, dy, dz] = FACES[face].dir;
        if (world.has(`${x + dx},${y + dy},${z + dz}`)) {
            showStatus?.("ブロックに塞がれている面にはメモを設置できません", "error", 3000);
            return;
        }
        for (const { data } of memosById.values()) {
            if (data.x === x && data.y === y && data.z === z && data.face === face) {
                showStatus?.("この面には既にメモが貼られています", "error", 3000);
                return;
            }
        }

        pendingTarget = { x, y, z, face };
        prepareModalOpen("create");

        const ui = getEl();
        ui.title.textContent = "📝 メモを設置";
        ui.view.style.display = "none";
        ui.form.style.display = "block";
        ui.del.style.display = "none";
        ui.submit.style.display = "inline-flex";
        ui.cancel.textContent = "キャンセル";
        if (ui.input) ui.input.value = "";
        if (ui.counter) ui.counter.textContent = "0 / 150";
        ui.modal.style.display = "flex";
        ui.input?.focus();
    };

    const openView = (memoId) => {
        if (!isGameReady() || activeModal || isBlockedByOtherUI()) return;
        const entry = memosById.get(memoId);
        if (!entry) return;
        const memo = entry.data;
        viewingMemoId = memoId;
        prepareModalOpen("view");

        const ui = getEl();
        ui.title.textContent = "📄 メモ";
        ui.form.style.display = "none";
        ui.submit.style.display = "none";
        ui.view.style.display = "block";
        ui.author.textContent = memo.playerName || "Player";
        ui.date.textContent = formatMemoDate(memo.createdAt);
        ui.content.textContent = memo.content || "";
        ui.del.style.display = memo.isOwner ? "inline-flex" : "none";
        ui.del.disabled = false;
        ui.del.textContent = "🗑️ 削除";
        ui.cancel.textContent = "閉じる";
        ui.modal.style.display = "flex";
    };

    const handleActionKey = (hit) => {
        if (!isGameReady() || activeModal || isBlockedByOtherUI()) return;
        const meta = hit?.hit && hit.pickedMesh?.metadata;
        if (meta?.isBlock) return openCreateForHit(hit);
        showStatus?.("ブロックを照準してMキーを押すとメモを設置できます", "info", 2000);
    };

    const loadForWorld = async (worldId) => {
        try {
            const res = await fetchWorldMemos(getOrCreateAuthorKey());
            if (res.worldId !== worldId || getActiveWorld().id !== worldId) return;
            for (const entry of memosById.values()) {
                try { entry.mesh?.dispose(); } catch (_) {}
            }
            memosById.clear();
            res.memos.forEach(addMemo);
        } catch (err) {
            showStatus?.(err.message || "メモの読み込みに失敗しました", "error", 4000);
        }
    };

    const onMemoCreated = (memo) => {
        if (!memo || memo.worldId !== getActiveWorld().id) return;
        const myId = getSocketId();
        addMemo({ ...memo, isOwner: Boolean(memo.isOwner || (myId && memo.senderId === myId)) });
    };

    const onMemoDeleted = (data) => {
        if (data && data.worldId === getActiveWorld().id) removeMemo(data.id);
    };

    const isCollidingWithGrid = (gx, gy, gz) => {
        for (const { data } of memosById.values()) {
            if (!data || !FACES[data.face]) continue;
            const [dx, dy, dz] = FACES[data.face].dir;
            if (data.x + dx === gx && data.y + dy === gy && data.z + dz === gz) return true;
        }
        return false;
    };

    const initUI = () => {
        const ui = getEl();
        ui.input?.addEventListener("input", () => {
            if (ui.counter) ui.counter.textContent = `${ui.input.value.length} / 150`;
        });

        const handleCreateSubmit = async () => {
            if (!pendingTarget || !ui.input || !ui.submit) return;
            const trimmed = ui.input.value.trim();
            if (!trimmed) return setError("メモ内容を入力してください。");
            if (trimmed.length > 150) return setError("メモ内容は150文字以内で入力してください。");

            setError("");
            try {
                ui.submit.disabled = true;
                ui.submit.textContent = "設置中...";
                const created = await createWorldMemo({
                    ...pendingTarget,
                    content: trimmed,
                    authorKey: getOrCreateAuthorKey()
                });
                onMemoCreated({ ...created, isOwner: true });
                closeModal(true);
                showStatus?.("メモを設置しました", "success", 2500);
            } catch (err) {
                setError(err.message || "メモの設置に失敗しました。");
            } finally {
                ui.submit.disabled = false;
                ui.submit.textContent = "📌 設置する";
            }
        };

        ui.form?.addEventListener("submit", (e) => { e.preventDefault(); e.stopPropagation(); handleCreateSubmit(); });
        ui.submit?.addEventListener("click", (e) => { e.stopPropagation(); handleCreateSubmit(); });

        ui.del?.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!viewingMemoId || !confirm("このメモを削除しますか？")) return;
            setError("");
            try {
                ui.del.disabled = true;
                ui.del.textContent = "削除中...";
                const res = await deleteWorldMemo(viewingMemoId, getOrCreateAuthorKey());
                removeMemo(res.id);
                closeModal(true);
                showStatus?.("メモを削除しました", "info", 2500);
            } catch (err) {
                setError(err.message || "メモの削除に失敗しました。");
                ui.del.disabled = false;
                ui.del.textContent = "🗑️ 削除";
            }
        });

        document.getElementById("closeMemoModalBtn")?.addEventListener("click", (e) => { e.stopPropagation(); closeModal(true); });
        ui.cancel?.addEventListener("click", (e) => { e.stopPropagation(); closeModal(true); });
        ui.modal?.addEventListener("click", (e) => { if (e.target === ui.modal) closeModal(false); });
    };

    return {
        isModalOpen: () => Boolean(activeModal),
        isCollidingWithGrid,
        handleActionKey,
        openCreateForHit,
        openView,
        closeModal,
        loadForWorld,
        clearAll,
        onMemoCreated,
        onMemoDeleted,
        initUI
    };
}
