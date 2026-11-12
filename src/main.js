import {
    Engine, Scene, UniversalCamera, Vector3, HemisphericLight, MeshBuilder,
    StandardMaterial, Color3, Color4, MultiMaterial, SubMesh, Ray,
    TransformNode, DynamicTexture, Mesh, VertexData, Texture
} from "@babylonjs/core";
import { fetchWorld, fetchWorldList, createWorld, deleteWorld } from "./api.js";
import {
    initNetwork, joinWorld, leaveCurrentWorld,
    setNetworkListeners, sendPlayerMove, requestPlaceBlock, requestBreakBlock,
    sendChatMessage, sendChangeName, isNetworkConnected, getSocketId
} from "./network.js";
import { createCommunityBoard } from "./communityBoard.js";
import { createWorldMemos } from "./worldMemos.js";

// ==============================================================================
// 1. シーン・カメラ・基本状態
// ==============================================================================
const canvas = document.getElementById("gameCanvas");
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.collisionsEnabled = true;
scene.clearColor = new Color4(0.53, 0.81, 0.98, 1.0);

const camera = new UniversalCamera("playerCamera", new Vector3(0, 2.1, -4), scene);
camera.setTarget(new Vector3(0, 2.1, 0));
camera.attachControl(canvas, true);
camera.angularSensibility = 2000;
camera.inertia = 0;
camera.checkCollisions = true;
camera.ellipsoid = new Vector3(0.35, 0.8, 0.35); // 底面が目の高さから -1.6 になる設定
camera.ellipsoidOffset = new Vector3(0, 0, 0);
camera.keysUp = [];
camera.keysDown = [];
camera.keysLeft = [];
camera.keysRight = [];

const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
light.groundColor = new Color3(0.55, 0.55, 0.55);

window.addEventListener("contextmenu", (e) => e.preventDefault());

let isChatFocused = false;
let isControlsModalOpen = false;
let communityBoard = null;
let worldMemos = null;
const PLAYER_NAME_STORAGE_KEY = "craft_player_name";
let myPlayerName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || sessionStorage.getItem("craft_player_name") || "";
if (!myPlayerName.trim()) {
    myPlayerName = `Player-${Math.floor(1000 + Math.random() * 9000)}`;
}
localStorage.setItem(PLAYER_NAME_STORAGE_KEY, myPlayerName);
const inputKeys = {};
let jumpRequested = false;
let isCrouching = false;

const isBoardModalOpen = () => Boolean(communityBoard && communityBoard.isOpen());
const isMemoModalOpen = () => Boolean(worldMemos && worldMemos.isModalOpen());
const isUiModalOrChatActive = () => isChatFocused || isControlsModalOpen || isBoardModalOpen() || isMemoModalOpen();

function clearPlayerInputState() {
    isCrouching = false;
    jumpRequested = false;
    for (const k in inputKeys) inputKeys[k] = false;
}

function releasePointerLockSafely() {
    try { document.exitPointerLock?.(); } catch (_) { }
}

function requestPointerLockSafely() {
    if (!canvas) return;
    const req = canvas.requestPointerLock || canvas.mozRequestPointerLock;
    if (!req) return;
    try {
        const p = req.call(canvas);
        if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) { }
}

function setBannerMessage(el, message = "") {
    if (!el) return;
    el.style.display = message ? "block" : "none";
    el.textContent = message;
}

function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ==============================================================================
// 2. ブロック種別・テクスチャ・ホットバー
// ==============================================================================
const BLOCK_TYPES = {
    GRASS:  { name: "grass",  color: new Color3(0.35, 0.75, 0.25) },
    DIRT:   { name: "dirt",   color: new Color3(0.5, 0.35, 0.2) },
    STONE:  { name: "stone",  color: new Color3(0.6, 0.6, 0.6) },
    WOOD:   { name: "wood",   color: new Color3(0.55, 0.3, 0.1) },
    SAND:   { name: "sand",   color: new Color3(0.88, 0.82, 0.52) },
    GLASS:  { name: "glass",  color: new Color3(0.65, 0.85, 0.95), isTransparent: true },
    LEAVES: { name: "leaves", color: new Color3(0.18, 0.55, 0.18) },
    BRICK:  { name: "brick",  color: new Color3(0.72, 0.28, 0.2) }
};

const BLOCK_TYPE_BY_NAME = Object.fromEntries(
    Object.values(BLOCK_TYPES).map((t) => [t.name, t])
);

const BLOCK_TEXTURE_PATHS = {
    brick: "/assets/block-brick.png",
    leaves: "/assets/block-leaves.png",
    sand: "/assets/block-sand.png",
    glass: "/assets/block-glass.png"
};

const HOTBAR_SLOTS = [
    { key: "1", type: BLOCK_TYPES.GRASS,  name: "草" },
    { key: "2", type: BLOCK_TYPES.DIRT,   name: "土" },
    { key: "3", type: BLOCK_TYPES.STONE,  name: "石" },
    { key: "4", type: BLOCK_TYPES.WOOD,   name: "木" },
    { key: "5", type: BLOCK_TYPES.SAND,   name: "砂" },
    { key: "6", type: BLOCK_TYPES.GLASS,  name: "ガラス" },
    { key: "7", type: BLOCK_TYPES.LEAVES, name: "葉" },
    { key: "8", type: BLOCK_TYPES.BRICK,  name: "レンガ" }
];

let selectedSlotIndex = 0;
let selectedBlockType = BLOCK_TYPES.GRASS;

function selectSlot(index) {
    if (index < 0 || index >= HOTBAR_SLOTS.length) return;
    selectedSlotIndex = index;
    selectedBlockType = HOTBAR_SLOTS[index].type;
    document.querySelectorAll("#hotbar .slot").forEach((el, i) => {
        el.classList.toggle("active", i === index);
    });
    updateTargetBlockHighlight?.();
}

function initHotbar() {
    const hotbarEl = document.getElementById("hotbar");
    if (!hotbarEl) return;
    hotbarEl.innerHTML = HOTBAR_SLOTS.map((slot, i) => `
        <div class="slot${i === 0 ? " active" : ""}" data-slot="${i}">
            <span class="slot-key">${slot.key}</span>
            <img class="slot-icon" src="/assets/icon-${slot.type.name}.png?v=flat" alt="${slot.name}" draggable="false" />
            <span class="slot-name">${slot.name}</span>
        </div>
    `).join("");

    hotbarEl.querySelectorAll(".slot").forEach((el, i) => {
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!isUiModalOrChatActive()) selectSlot(i);
        });
    });
}
initHotbar();

const materials = {};
function getBlockMaterial(blockType) {
    if (!materials[blockType.name]) {
        const mat = new StandardMaterial(`${blockType.name}Material`, scene);
        mat.diffuseColor = blockType.color;
        mat.specularColor = new Color3(0.1, 0.1, 0.1);

        if (blockType.name === BLOCK_TYPES.GLASS.name) {
            mat.alpha = 0.55;
            mat.backFaceCulling = true;
            mat.specularColor = new Color3(0.8, 0.8, 0.8);
        }

        const texPath = BLOCK_TEXTURE_PATHS[blockType.name];
        if (texPath) {
            const tex = new Texture(texPath, scene, false, true, Texture.NEAREST_SAMPLINGMODE);
            tex.hasAlpha = Boolean(blockType.isTransparent);
            mat.diffuseTexture = tex;
        }
        materials[blockType.name] = mat;
    }
    return materials[blockType.name];
}

// ==============================================================================
// 3. ワールドブロック管理 & ガラス面カリング & 照準アウトライン
// ==============================================================================
const GRID_SIZE = 20;
const BLOCK_SIZE = 1;
const offset = (GRID_SIZE * BLOCK_SIZE) / 2 - BLOCK_SIZE / 2;
const world = new Map();
const getBlockKey = (x, y, z) => `${x},${y},${z}`;

const baseBlocks = {};
Object.values(BLOCK_TYPES).forEach((type) => {
    const base = MeshBuilder.CreateBox(`base_${type.name}`, { size: BLOCK_SIZE }, scene);
    base.checkCollisions = true;

    if (type.name === BLOCK_TYPES.GRASS.name) {
        const multiMat = new MultiMaterial("grassMultiMaterial", scene);
        multiMat.subMaterials.push(getBlockMaterial(BLOCK_TYPES.GRASS), getBlockMaterial(BLOCK_TYPES.DIRT));
        base.material = multiMat;
        base.subMeshes = [];
        new SubMesh(1, 0, 24, 0, 24, base);  // 側面4面 -> 土
        new SubMesh(0, 0, 24, 24, 6, base);  // 上面   -> 草
        new SubMesh(1, 0, 24, 30, 6, base);  // 下面   -> 土
    } else {
        base.material = getBlockMaterial(type);
    }

    base.isVisible = false;
    baseBlocks[type.name] = base;
});

const boxVertexData = VertexData.CreateBox({ size: BLOCK_SIZE });
const GLASS_FACE_DIRS = [
    { dir: [0, 0, 1],  idx: [0, 1, 2, 0, 2, 3] },
    { dir: [0, 0, -1], idx: [4, 5, 6, 4, 6, 7] },
    { dir: [1, 0, 0],  idx: [8, 9, 10, 8, 10, 11] },
    { dir: [-1, 0, 0], idx: [12, 13, 14, 12, 14, 15] },
    { dir: [0, 1, 0],  idx: [16, 17, 18, 16, 18, 19] },
    { dir: [0, -1, 0], idx: [20, 21, 22, 20, 22, 23] }
];

function applyGlassIndices(mesh, x, y, z) {
    if (!mesh || mesh.isDisposed()) return;
    const indices = [];
    for (const { dir: [dx, dy, dz], idx } of GLASS_FACE_DIRS) {
        if (!world.has(getBlockKey(x + dx, y + dy, z + dz))) indices.push(...idx);
    }
    mesh.setIndices(indices);
}

function updateNeighborGlassMeshes(x, y, z) {
    for (const { dir: [dx, dy, dz] } of GLASS_FACE_DIRS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const block = world.get(getBlockKey(nx, ny, nz));
        if (block && block.type.name === BLOCK_TYPES.GLASS.name && block.instance) {
            applyGlassIndices(block.instance, nx, ny, nz);
        }
    }
}

function updateAllGlassMeshes() {
    world.forEach((block, key) => {
        if (block.type.name === BLOCK_TYPES.GLASS.name && block.instance) {
            const [x, y, z] = key.split(",").map(Number);
            applyGlassIndices(block.instance, x, y, z);
        }
    });
}

function addBlock(x, y, z, blockType) {
    const key = getBlockKey(x, y, z);
    if (world.has(key)) return;

    let instance;
    if (blockType.name === BLOCK_TYPES.GLASS.name) {
        instance = new Mesh(`glass_${key}`, scene);
        boxVertexData.applyToMesh(instance, true);
        instance.material = getBlockMaterial(BLOCK_TYPES.GLASS);
    } else {
        instance = baseBlocks[blockType.name].createInstance(`block_${key}`);
    }

    instance.checkCollisions = true;
    instance.isPickable = true;
    instance.metadata = { x, y, z, isBlock: true };
    instance.position.set(x * BLOCK_SIZE - offset, y * BLOCK_SIZE, z * BLOCK_SIZE - offset);

    world.set(key, { type: blockType, instance });
    if (blockType.name === BLOCK_TYPES.GLASS.name) applyGlassIndices(instance, x, y, z);
    updateNeighborGlassMeshes(x, y, z);
    return instance;
}

function removeBlock(x, y, z) {
    const key = getBlockKey(x, y, z);
    const blockData = world.get(key);
    if (!blockData) return;
    blockData.instance.dispose();
    world.delete(key);
    updateNeighborGlassMeshes(x, y, z);
    updateTargetBlockHighlight();
}

function hasSupportingBlock(x, y, z) {
    return GLASS_FACE_DIRS.some(({ dir: [dx, dy, dz] }) => world.has(getBlockKey(x + dx, y + dy, z + dz)));
}

function isCollidingWithPlayer(gx, gy, gz) {
    const half = BLOCK_SIZE / 2;
    const bMinX = gx * BLOCK_SIZE - offset - half, bMaxX = gx * BLOCK_SIZE - offset + half;
    const bMinY = gy * BLOCK_SIZE - half,          bMaxY = gy * BLOCK_SIZE + half;
    const bMinZ = gz * BLOCK_SIZE - offset - half, bMaxZ = gz * BLOCK_SIZE - offset + half;

    const currentEyeHeight = 1.6 - currentCrouchOffset;
    const r = 0.35;
    const overlapX = camera.position.x - r < bMaxX && camera.position.x + r > bMinX;
    const overlapZ = camera.position.z - r < bMaxZ && camera.position.z + r > bMinZ;
    // 足元へのブリッジング設置を妨げないよう上面より 0.1 以上めり込む場合のみ衝突扱い
    const overlapY = (camera.position.y - currentEyeHeight < bMaxY - 0.1) && (camera.position.y + 0.1 > bMinY);
    return overlapX && overlapY && overlapZ;
}

function createBlockOutlineMesh(name) {
    const h = BLOCK_SIZE / 2 + 0.002;
    const corners = [
        [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
        [-h, -h, h],  [h, -h, h],  [h, h, h],  [-h, h, h]
    ].map(([x, y, z]) => new Vector3(x, y, z));
    const edgePairs = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    const outline = MeshBuilder.CreateLineSystem(name, { lines: edgePairs.map(([a, b]) => [corners[a], corners[b]]) }, scene);
    outline.color = new Color3(0.05, 0.05, 0.05);
    outline.isPickable = false;
    outline.checkCollisions = false;
    outline.isVisible = false;
    return outline;
}
const targetOutlineMesh = createBlockOutlineMesh("target_block_outline");

// ==============================================================================
// 4. 楽観的更新 & ブロック設置・破壊操作
// ==============================================================================
const pendingOperations = new Map();
const pendingByPosition = new Map();
let operationSequence = 0;
const PENDING_TIMEOUT_MS = 8000;

let isPerfLogEnabled = true;
window.togglePerfLog = (enable) => {
    isPerfLogEnabled = enable !== undefined ? Boolean(enable) : !isPerfLogEnabled;
};
const logClientPerf = (msg) => {
    if (isPerfLogEnabled) console.log(`⏱️ [Client Perf] ${msg}`);
};

function clearPendingOp(opId, posKey) {
    const op = pendingOperations.get(opId);
    if (op?.timeoutId) clearTimeout(op.timeoutId);
    pendingOperations.delete(opId);
    if (pendingByPosition.get(posKey) === opId) pendingByPosition.delete(posKey);
}

function rollbackOperation(opId) {
    const op = pendingOperations.get(opId);
    if (!op) return;
    if (op.action === "place") {
        removeBlock(op.x, op.y, op.z);
    } else if (op.action === "break" && op.previousType) {
        addBlock(op.x, op.y, op.z, op.previousType);
    }
    clearPendingOp(opId, getBlockKey(op.x, op.y, op.z));
    updateTargetBlockHighlight();
}

function submitOptimisticBlockOp(action, x, y, z, blockType, previousType) {
    const posKey = getBlockKey(x, y, z);
    if (pendingByPosition.has(posKey)) return;

    const applyLocal = () => {
        if (action === "place") addBlock(x, y, z, blockType);
        else removeBlock(x, y, z);
    };

    if (!isNetworkConnected()) {
        applyLocal();
        updateTargetBlockHighlight();
        return;
    }

    const opId = `${action}_${getSocketId() || "local"}_${Date.now()}_${++operationSequence}`;
    applyLocal();

    const timeoutId = setTimeout(() => {
        if (pendingOperations.has(opId)) {
            console.warn(`⚠️ [Optimistic] ${action}操作がタイムアウトしました (${opId})。ロールバックします`);
            rollbackOperation(opId);
        }
    }, PENDING_TIMEOUT_MS);

    pendingOperations.set(opId, {
        opId, action, x, y, z, blockType, previousType,
        startTime: performance.now(),
        timeoutId
    });
    pendingByPosition.set(posKey, opId);

    if (action === "place") requestPlaceBlock(x, y, z, blockType.name, opId);
    else requestBreakBlock(x, y, z, opId);

    updateTargetBlockHighlight();
}

function resolvePendingBlockOp(posKey, operationId, label) {
    if (operationId && pendingOperations.has(operationId)) {
        const op = pendingOperations.get(operationId);
        const rtt = performance.now() - op.startTime;
        logClientPerf(`[${label}確定] RTT: ${rtt.toFixed(1)}ms, pos: (${posKey})`);
        clearPendingOp(operationId, posKey);
        return true; // 自分の先行反映分
    }
    if (pendingByPosition.has(posKey)) {
        clearPendingOp(pendingByPosition.get(posKey), posKey);
    }
    return false;
}

function pickTargetInteractable(maxDistance = 5.0) {
    if (!camera || !scene) return null;
    return scene.pickWithRay(
        camera.getForwardRay(maxDistance),
        (mesh) => mesh.metadata && (mesh.metadata.isBlock || mesh.metadata.isCommunityBoard || mesh.metadata.isWorldMemo)
    );
}

function isPointingAtCommunityBoard() {
    if (!isWorldReady) return false;
    const hit = pickTargetInteractable(5.0);
    return Boolean(hit?.hit && hit.pickedMesh?.metadata?.isCommunityBoard);
}

function pickHorizontalAssistTarget(x, y, z, dirX, dirZ, absX, absZ) {
    const candidates = [];
    if (dirX !== 0 && dirZ !== 0) {
        if (absX >= absZ) {
            candidates.push([x + dirX, y, z], [x, y, z + dirZ], [x + dirX, y, z + dirZ]);
        } else {
            candidates.push([x, y, z + dirZ], [x + dirX, y, z], [x + dirX, y, z + dirZ]);
        }
    } else if (dirX !== 0) {
        candidates.push([x + dirX, y, z]);
    } else if (dirZ !== 0) {
        candidates.push([x, y, z + dirZ]);
    }

    for (const [cx, cy, cz] of candidates) {
        if (!world.has(getBlockKey(cx, cy, cz)) && hasSupportingBlock(cx, cy, cz)) {
            return [cx, cy, cz];
        }
    }
    return null;
}

function getPlacementTarget() {
    if (!camera || !scene || !isWorldReady) return null;
    const hit = pickTargetInteractable(5.0);
    let target = null;

    if (hit?.hit && hit.pickedMesh?.metadata) {
        if (hit.pickedMesh.metadata.isCommunityBoard || hit.pickedMesh.metadata.isWorldMemo) return null;
        const normal = hit.getNormal(true);
        if (!normal) return null;

        const { x, y, z } = hit.pickedMesh.metadata;
        const normX = Math.round(normal.x), normY = Math.round(normal.y), normZ = Math.round(normal.z);

        // エッジ設置補助（上面の端を狙った場合に水平外側へ設置）
        if (normY === 1 && hit.pickedPoint) {
            const localX = hit.pickedPoint.x - hit.pickedMesh.position.x;
            const localZ = hit.pickedPoint.z - hit.pickedMesh.position.z;
            const dirX = Math.abs(localX) >= 0.28 ? Math.sign(localX) : 0;
            const dirZ = Math.abs(localZ) >= 0.28 ? Math.sign(localZ) : 0;
            if (dirX !== 0 || dirZ !== 0) {
                target = pickHorizontalAssistTarget(x, y, z, dirX, dirZ, Math.abs(localX), Math.abs(localZ));
            }
        }
        if (!target) target = [x + normX, y + normY, z + normZ];
    } else if (isPlayerGrounded) {
        // 接地中の見下ろし空中設置補助
        const eyeH = 1.6 - currentCrouchOffset;
        const footHit = scene.pickWithRay(new Ray(camera.position, new Vector3(0, -1, 0), eyeH + 0.35), (m) => m.metadata?.isBlock);
        if (footHit?.hit && footHit.pickedMesh?.metadata) {
            const { x, y, z } = footHit.pickedMesh.metadata;
            const fwd = camera.getForwardRay(5.0).direction;
            if (fwd.y < -0.15) {
                const dirX = Math.abs(fwd.x) > 0.25 ? Math.sign(fwd.x) : 0;
                const dirZ = Math.abs(fwd.z) > 0.25 ? Math.sign(fwd.z) : 0;
                target = pickHorizontalAssistTarget(x, y, z, dirX, dirZ, Math.abs(fwd.x), Math.abs(fwd.z));
            }
        }
    }

    if (!target) return null;
    const [tx, ty, tz] = target;
    if (world.has(getBlockKey(tx, ty, tz))) return null;
    if (!hasSupportingBlock(tx, ty, tz)) return null;
    if (isCollidingWithPlayer(tx, ty, tz)) return null;
    if (communityBoard?.isCollidingWithGrid(tx, ty, tz)) return null;
    if (worldMemos?.isCollidingWithGrid(tx, ty, tz)) return null;
    return { x: tx, y: ty, z: tz };
}

function updateTargetBlockHighlight() {
    if (!isWorldReady || !camera || isUiModalOrChatActive()) {
        if (targetOutlineMesh) targetOutlineMesh.isVisible = false;
        return;
    }
    const hit = pickTargetInteractable(5.0);
    if (hit?.hit && hit.pickedMesh?.metadata?.isBlock) {
        const { x, y, z } = hit.pickedMesh.metadata;
        targetOutlineMesh.position.set(x * BLOCK_SIZE - offset, y * BLOCK_SIZE, z * BLOCK_SIZE - offset);
        targetOutlineMesh.isVisible = true;
    } else if (targetOutlineMesh) {
        targetOutlineMesh.isVisible = false;
    }
}

function breakBlock() {
    const hit = pickTargetInteractable(5.0);
    const meta = hit?.hit && hit.pickedMesh?.metadata;
    if (!meta || meta.isCommunityBoard || meta.isWorldMemo) return;
    const { x, y, z } = meta;
    const existing = world.get(getBlockKey(x, y, z));
    if (!existing) return;
    submitOptimisticBlockOp("break", x, y, z, null, existing.type);
}

function placeBlock() {
    const hit = pickTargetInteractable(5.0);
    const meta = hit?.hit && hit.pickedMesh?.metadata;
    if (meta?.isBlock) {
        const normal = hit.getNormal(true);
        if (normal) {
            const nx = Math.round(normal.x), ny = Math.round(normal.y), nz = Math.round(normal.z);
            if (worldMemos?.isCollidingWithGrid(meta.x + nx, meta.y + ny, meta.z + nz)) {
                showStatus("メモが貼られている面にはブロックを設置できません", "warning", 2500);
                return;
            }
        }
    }
    const target = getPlacementTarget();
    if (!target) return;
    submitOptimisticBlockOp("place", target.x, target.y, target.z, selectedBlockType, null);
}

// ==============================================================================
// 5. 入力ハンドリング・移動物理
// ==============================================================================
canvas.addEventListener("pointerdown", (event) => {
    if (!document.body.classList.contains("in-game") || isUiModalOrChatActive()) return;
    if (document.pointerLockElement !== canvas) {
        requestPointerLockSafely();
        return;
    }
    if (event.button === 0) {
        const hit = pickTargetInteractable(5.0);
        const meta = hit?.hit && hit.pickedMesh?.metadata;
        if (meta?.isCommunityBoard) {
            communityBoard?.open();
            return;
        }
        if (meta?.isWorldMemo) {
            worldMemos?.openView(meta.memoId);
            return;
        }
        breakBlock();
    } else if (event.button === 2) {
        placeBlock();
    }
});

window.addEventListener("keydown", (event) => {
    if (!document.body.classList.contains("in-game")) return;

    if (isControlsModalOpen) {
        if (event.key === "Escape") { event.preventDefault(); closeControlsModal(); }
        return;
    }
    if (isBoardModalOpen()) {
        if (event.key === "Escape") { event.preventDefault(); communityBoard?.close(false); }
        return;
    }
    if (isMemoModalOpen()) {
        if (event.key === "Escape") { event.preventDefault(); worldMemos?.closeModal(false); }
        return;
    }

    const chatInput = document.getElementById("chat-input");
    if (isChatFocused) {
        if (event.key === "Escape") { chatInput?.blur(); event.preventDefault(); }
        return;
    }
    if (event.code === "Enter" || event.code === "KeyT") {
        if (chatInput) { event.preventDefault(); chatInput.focus(); return; }
    }
    if (event.code === "KeyM" && !event.repeat) {
        event.preventDefault();
        const hit = pickTargetInteractable(5.0);
        worldMemos?.handleActionKey(hit);
        return;
    }

    if (event.code === "ShiftLeft" || event.key === "Shift") {
        isCrouching = true;
    } else if (event.code === "Space") {
        if (!event.repeat && !inputKeys[" "]) jumpRequested = true;
        inputKeys[" "] = true;
    } else if (/^[1-8]$/.test(event.key)) {
        if (!event.repeat) selectSlot(Number(event.key) - 1);
    } else {
        inputKeys[event.key.toLowerCase()] = true;
    }
});

window.addEventListener("keyup", (event) => {
    if (!document.body.classList.contains("in-game") || isUiModalOrChatActive()) return;
    if (event.code === "ShiftLeft" || event.key === "Shift") {
        isCrouching = false;
    } else if (event.code === "Space") {
        inputKeys[" "] = false;
        jumpRequested = false;
    } else {
        inputKeys[event.key.toLowerCase()] = false;
    }
});

window.addEventListener("blur", clearPlayerInputState);
window.addEventListener("wheel", (event) => {
    if (!document.body.classList.contains("in-game") || isUiModalOrChatActive()) return;
    const step = event.deltaY > 0 ? 1 : (event.deltaY < 0 ? -1 : 0);
    if (step !== 0) selectSlot((selectedSlotIndex + step + HOTBAR_SLOTS.length) % HOTBAR_SLOTS.length);
}, { passive: true });

const MOVE_SPEED = 4.0;
const CROUCH_MOVE_SPEED = 1.6;
const CROUCH_HEIGHT_OFFSET = 0.3;
const GRAVITY = -18.0;
const JUMP_FORCE = 7.0;
const TERMINAL_VELOCITY = -25.0;

let verticalVelocity = 0;
let isWorldReady = false;
let currentCrouchOffset = 0.0;
let isPlayerGrounded = false;

function updatePlayerPhysics(deltaSec) {
    if (!isWorldReady) return;
    if (camera.position.y < -100) {
        respawnPlayer();
        showStatus("奈落から安全な地点へ復帰しました", "info", 2000);
        return;
    }

    const safeDelta = Math.min(deltaSec, 0.1);
    let moveX = 0, moveZ = 0;
    if (!isUiModalOrChatActive()) {
        if (inputKeys["w"]) moveZ += 1;
        if (inputKeys["s"]) moveZ -= 1;
        if (inputKeys["a"]) moveX -= 1;
        if (inputKeys["d"]) moveX += 1;
    } else {
        isCrouching = false;
        jumpRequested = false;
    }

    let dirX = 0, dirZ = 0;
    if (moveX !== 0 || moveZ !== 0) {
        const len = Math.hypot(moveX, moveZ);
        const nx = moveX / len, nz = moveZ / len;
        const sinY = Math.sin(camera.rotation.y), cosY = Math.cos(camera.rotation.y);
        dirX = sinY * nz + cosY * nx;
        dirZ = cosY * nz - sinY * nx;
    }

    const targetCrouch = isCrouching ? CROUCH_HEIGHT_OFFSET : 0.0;
    let crouchDelta = (targetCrouch - currentCrouchOffset) * Math.min(1.0, safeDelta * 14);
    if (Math.abs(targetCrouch - currentCrouchOffset) < 0.0005) {
        crouchDelta = targetCrouch - currentCrouchOffset;
        currentCrouchOffset = targetCrouch;
    } else {
        currentCrouchOffset += crouchDelta;
    }
    camera.ellipsoidOffset.y = currentCrouchOffset;
    camera.position.y -= crouchDelta;

    const currentEyeHeight = 1.6 - currentCrouchOffset;
    const probeLength = currentEyeHeight + (isPlayerGrounded ? 0.12 : 0.06);
    const groundHit = scene.pickWithRay(new Ray(camera.position, new Vector3(0, -1, 0), probeLength), (m) => m.checkCollisions);
    const isGrounded = Boolean(groundHit?.hit);
    isPlayerGrounded = isGrounded;

    if (jumpRequested && isGrounded) {
        verticalVelocity = JUMP_FORCE;
        jumpRequested = false;
    } else if (isGrounded && verticalVelocity <= 0) {
        verticalVelocity = 0;
    } else {
        verticalVelocity = Math.max(TERMINAL_VELOCITY, verticalVelocity + GRAVITY * safeDelta);
    }

    const speed = isCrouching ? CROUCH_MOVE_SPEED : MOVE_SPEED;
    let dispX = dirX * speed * safeDelta;
    let dispZ = dirZ * speed * safeDelta;

    // しゃがみ中の足場外落下防止
    if (isCrouching && isGrounded) {
        const hasGround = (px, pz) => Boolean(scene.pickWithRay(
            new Ray(new Vector3(px, camera.position.y, pz), new Vector3(0, -1, 0), currentEyeHeight + 0.35),
            (m) => m.checkCollisions
        )?.hit);

        if (dispX !== 0 && !hasGround(camera.position.x + dispX, camera.position.z)) dispX = 0;
        if (dispZ !== 0 && !hasGround(camera.position.x, camera.position.z + dispZ)) dispZ = 0;
        if (dispX !== 0 && dispZ !== 0 && !hasGround(camera.position.x + dispX, camera.position.z + dispZ)) {
            if (hasGround(camera.position.x + dispX, camera.position.z)) dispZ = 0;
            else if (hasGround(camera.position.x, camera.position.z + dispZ)) dispX = 0;
            else { dispX = 0; dispZ = 0; }
        }
    }

    camera.cameraDirection.x += dispX;
    camera.cameraDirection.y = verticalVelocity !== 0 ? camera.cameraDirection.y + verticalVelocity * safeDelta : 0;
    camera.cameraDirection.z += dispZ;
}

// ==============================================================================
// 6. ワールドロード・スポーン・通知・コミュニティ掲示板連携
// ==============================================================================
let toastTimeout = null;
function showStatus(message, type = "info", duration = 4000) {
    const toast = document.getElementById("statusToast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `status-toast visible ${type}`;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.className = "status-toast"; }, duration);
}

function loadBlocksIntoWorld(blocks) {
    let loaded = 0;
    for (const b of blocks) {
        const blockType = BLOCK_TYPE_BY_NAME[b.type];
        if (blockType) { addBlock(b.x, b.y, b.z, blockType); loaded++; }
    }
    return loaded;
}

function findSafeSpawnPosition() {
    if (world.size === 0) return new Vector3(0, 2.1, 0);

    const columnTops = new Map();
    for (const key of world.keys()) {
        const [x, y, z] = key.split(",").map(Number);
        const colKey = `${x},${z}`;
        if (!columnTops.has(colKey) || columnTops.get(colKey).y < y) columnTops.set(colKey, { x, y, z });
    }

    let best = null;
    let bestDistSq = Infinity;
    for (const b of columnTops.values()) {
        if (world.has(getBlockKey(b.x, b.y + 1, b.z)) || world.has(getBlockKey(b.x, b.y + 2, b.z))) continue;
        if (communityBoard?.isCollidingWithGrid(b.x, b.y + 1, b.z)) continue;
        const px = b.x * BLOCK_SIZE - offset, pz = b.z * BLOCK_SIZE - offset;
        const d = px * px + pz * pz;
        if (d < bestDistSq) { bestDistSq = d; best = b; }
    }
    if (!best) best = columnTops.values().next().value;
    return new Vector3(best.x * BLOCK_SIZE - offset, best.y * BLOCK_SIZE + 2.1, best.z * BLOCK_SIZE - offset);
}

function respawnPlayer(position = null) {
    const targetPos = position || findSafeSpawnPosition();
    camera.position.copyFrom(targetPos);
    verticalVelocity = 0;
    jumpRequested = false;
    camera.cameraDirection = new Vector3(0, 0, 0);
    camera.setTarget(new Vector3(0, targetPos.y, 0));
    if (targetOutlineMesh) targetOutlineMesh.isVisible = false;
}

let currentActiveWorldId = "default";
let currentActiveWorldName = "デフォルトワールド";

communityBoard = createCommunityBoard({
    scene,
    camera,
    blockSize: BLOCK_SIZE,
    offset,
    world,
    getActiveWorld: () => ({ id: currentActiveWorldId, name: currentActiveWorldName }),
    getSocketId,
    isGameReady: () => isWorldReady,
    isBlockedByOtherUI: () => {
        const del = document.getElementById("deleteWorldModal");
        return isChatFocused || isControlsModalOpen || isMemoModalOpen() || del?.style.display === "flex";
    },
    clearPlayerInputState,
    releasePointerLockSafely,
    requestPointerLockSafely,
    hideTargetOutline: () => { if (targetOutlineMesh) targetOutlineMesh.isVisible = false; }
});

worldMemos = createWorldMemos({
    scene,
    blockSize: BLOCK_SIZE,
    offset,
    world,
    getActiveWorld: () => ({ id: currentActiveWorldId, name: currentActiveWorldName }),
    getSocketId,
    isGameReady: () => isWorldReady,
    isBlockedByOtherUI: () => {
        const del = document.getElementById("deleteWorldModal");
        return isChatFocused || isControlsModalOpen || isBoardModalOpen() || del?.style.display === "flex";
    },
    clearPlayerInputState,
    releasePointerLockSafely,
    requestPointerLockSafely,
    hideTargetOutline: () => { if (targetOutlineMesh) targetOutlineMesh.isVisible = false; },
    showStatus
});

// ==============================================================================
// 7. マルチプレイHUD・ワールド入退室・タイトル画面・モーダル
// ==============================================================================
const onlineWorldPlayers = new Map();
const otherPlayers = new Map();

function renderOnlinePlayersList() {
    const listContainer = document.getElementById("onlinePlayersList");
    const countEl = document.getElementById("onlinePlayerCount");
    if (!listContainer) return;
    if (countEl) countEl.textContent = onlineWorldPlayers.size;

    const sorted = Array.from(onlineWorldPlayers.values()).sort((a, b) =>
        a.isMe ? -1 : b.isMe ? 1 : (a.name || "").localeCompare(b.name || "")
    );
    listContainer.innerHTML = "";
    for (const p of sorted) {
        const item = document.createElement("div");
        item.className = `player-item ${p.isMe ? "is-me" : ""}`;
        const dot = document.createElement("span");
        dot.className = "player-dot";
        dot.style.background = p.color || "#38bdf8";
        const nameSpan = document.createElement("span");
        nameSpan.className = "player-item-name";
        nameSpan.textContent = p.name || "Player";
        item.append(dot, nameSpan);
        if (p.isMe) {
            const badge = document.createElement("span");
            badge.className = "player-item-badge";
            badge.textContent = "自分";
            item.appendChild(badge);
        }
        listContainer.appendChild(item);
    }
}

function showPlayerNotification(type, playerName) {
    const feed = document.getElementById("playerNotificationFeed");
    if (!feed || !document.body.classList.contains("in-game")) return;

    const toast = document.createElement("div");
    toast.className = `player-toast ${type}`;
    const icon = type === "join" ? "👋" : "🚪";
    const actionText = type === "join" ? "がワールドに参加しました" : "がワールドから退出しました";
    toast.innerHTML = `<span>${icon}</span> <span><strong>${escapeHtml(playerName || "Player")}</strong> ${actionText}</span>`;
    feed.appendChild(toast);
    while (feed.children.length > 4) feed.removeChild(feed.firstChild);
    setTimeout(() => { if (toast.parentNode === feed) feed.removeChild(toast); }, 3100);
}

function updateMyPlayerNameInList(newName) {
    myPlayerName = newName;
    const myId = getSocketId() || "me";
    const entry = onlineWorldPlayers.get(myId) || onlineWorldPlayers.get("me");
    if (entry) entry.name = newName;
    else onlineWorldPlayers.set(myId, { id: myId, name: newName, color: "#38bdf8", isMe: true });
    renderOnlinePlayersList();
}

function clearAllBlocks() {
    world.forEach((b) => { try { b?.instance?.dispose?.(); } catch (_) { } });
    world.clear();
    for (const op of pendingOperations.values()) clearTimeout(op.timeoutId);
    pendingOperations.clear();
    pendingByPosition.clear();
    if (targetOutlineMesh) targetOutlineMesh.isVisible = false;
}

function clearAllOtherPlayers() {
    for (const id of Array.from(otherPlayers.keys())) removePlayerAvatar(id);
    otherPlayers.clear();
}

async function enterWorld(worldId, worldName) {
    currentActiveWorldId = worldId;
    currentActiveWorldName = worldName || worldId;

    const worldNameEl = document.getElementById("currentWorldNameDisplay");
    const worldIdEl = document.getElementById("currentWorldIdDisplay");
    if (worldNameEl) worldNameEl.textContent = currentActiveWorldName;
    if (worldIdEl) worldIdEl.textContent = currentActiveWorldId;

    showStatus(`ワールド「${currentActiveWorldName}」に参加中...`, "info", 4000);
    clearAllBlocks();
    clearAllOtherPlayers();
    worldMemos.clearAll();

    try {
        const worldData = await fetchWorld(worldId);
        const blocks = worldData.blocks || [];
        loadBlocksIntoWorld(blocks);
        updateAllGlassMeshes();
        communityBoard.placeAtSpawn();
        respawnPlayer();
        isWorldReady = true;
        showStatus(`ワールド「${currentActiveWorldName}」を読み込みました (${blocks.length} 個)`, "success", 4000);

        communityBoard.resetState();
        document.body.classList.add("in-game");

        onlineWorldPlayers.clear();
        const myId = getSocketId() || "me";
        onlineWorldPlayers.set(myId, { id: myId, name: myPlayerName, color: "#38bdf8", isMe: true });
        renderOnlinePlayersList();

        const notifFeed = document.getElementById("playerNotificationFeed");
        if (notifFeed) notifFeed.innerHTML = "";

        joinWorld(
            currentActiveWorldId,
            { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            { x: camera.rotation.x, y: camera.rotation.y },
            myPlayerName
        );
        if (isNetworkConnected()) {
            worldMemos.loadForWorld(currentActiveWorldId);
        }

        if (chatMessages) chatMessages.innerHTML = "";
        addChatMessageToUI({
            id: `sys-${Date.now()}`,
            senderName: "システム",
            senderColor: "#38bdf8",
            text: `ワールド「${currentActiveWorldName}」に参加しました。`,
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        });
    } catch (error) {
        console.error("ワールド参加エラー:", error);
        showStatus(`参加に失敗しました: ${error.message}`, "error", 6000);
        exitToTitleScreen();
    }
}

function exitToTitleScreen() {
    closeControlsModal();
    communityBoard.close(false);
    communityBoard.resetState();
    communityBoard.hideObject();
    worldMemos.clearAll();
    releasePointerLockSafely();
    isWorldReady = false;
    leaveCurrentWorld();
    clearAllBlocks();
    clearAllOtherPlayers();
    onlineWorldPlayers.clear();
    renderOnlinePlayersList();
    const notifFeed = document.getElementById("playerNotificationFeed");
    if (notifFeed) notifFeed.innerHTML = "";
    document.body.classList.remove("in-game");
    loadAndRenderWorldList();
}

// ホスト認証キー管理（localStorage）
const HOST_KEYS_STORAGE_KEY = "craft_world_host_keys";
function getStoredHostKeys() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HOST_KEYS_STORAGE_KEY) || "{}");
        return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (_) { return {}; }
}
const getHostKey = (worldId) => (worldId ? getStoredHostKeys()[worldId] || null : null);
function saveHostKey(worldId, hostKey) {
    if (!worldId || !hostKey) return;
    try {
        const keys = getStoredHostKeys();
        keys[worldId] = hostKey;
        localStorage.setItem(HOST_KEYS_STORAGE_KEY, JSON.stringify(keys));
    } catch (e) { console.error("ホスト認証キーの保存に失敗しました:", e); }
}
function removeHostKey(worldId) {
    if (!worldId) return;
    try {
        const keys = getStoredHostKeys();
        if (keys[worldId]) {
            delete keys[worldId];
            localStorage.setItem(HOST_KEYS_STORAGE_KEY, JSON.stringify(keys));
        }
    } catch (e) { console.error("ホスト認証キーの削除に失敗しました:", e); }
}

// ワールド削除確認モーダル
let currentDeleteTarget = null;
function openDeleteWorldModal(worldId, worldName) {
    const modalEl = document.getElementById("deleteWorldModal");
    const input = document.getElementById("deleteConfirmInput");
    const submitBtn = document.getElementById("confirmDeleteSubmitBtn");
    if (!modalEl || !input || !submitBtn) return;

    currentDeleteTarget = { id: worldId, name: worldName };
    document.getElementById("deleteTargetWorldNameDisplay").textContent = worldName;
    document.getElementById("deleteTargetWorldIdDisplay").textContent = worldId;
    document.getElementById("deleteRequiredNamePrompt").textContent = worldName;
    setBannerMessage(document.getElementById("deleteModalError"), "");

    input.value = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "🗑️ 完全に削除する";
    modalEl.style.display = "flex";
    input.focus();
}

function closeDeleteWorldModal() {
    const modalEl = document.getElementById("deleteWorldModal");
    const input = document.getElementById("deleteConfirmInput");
    if (modalEl) modalEl.style.display = "none";
    if (input) input.value = "";
    setBannerMessage(document.getElementById("deleteModalError"), "");
    currentDeleteTarget = null;
}

function initDeleteWorldModal() {
    const modalEl = document.getElementById("deleteWorldModal");
    const input = document.getElementById("deleteConfirmInput");
    const submitBtn = document.getElementById("confirmDeleteSubmitBtn");
    const errorEl = document.getElementById("deleteModalError");
    if (!modalEl) return;

    if (input && submitBtn) {
        input.addEventListener("input", () => {
            const expected = currentDeleteTarget ? (currentDeleteTarget.name || currentDeleteTarget.id).trim() : "";
            submitBtn.disabled = !currentDeleteTarget || input.value.trim() !== expected;
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !submitBtn.disabled) { e.preventDefault(); submitBtn.click(); }
        });
    }

    submitBtn?.addEventListener("click", async () => {
        if (!currentDeleteTarget) return;
        const { id: targetId, name: targetName } = currentDeleteTarget;
        const hostKey = getHostKey(targetId);
        if (!hostKey) {
            setBannerMessage(errorEl, "このブラウザにはこのワールドのホスト認証キーが保存されていないため、削除できません。");
            return;
        }
        try {
            submitBtn.disabled = true;
            submitBtn.textContent = "🗑️ 削除中...";
            setBannerMessage(errorEl, "");
            await deleteWorld(targetId, hostKey);
            removeHostKey(targetId);
            closeDeleteWorldModal();
            showStatus(`ワールド「${targetName}」を完全に削除しました`, "success", 4000);
            loadAndRenderWorldList();
        } catch (err) {
            setBannerMessage(errorEl, err.message || "ワールドの削除に失敗しました。");
            submitBtn.disabled = false;
            submitBtn.textContent = "🗑️ 完全に削除する";
        }
    });

    document.getElementById("closeDeleteModalBtn")?.addEventListener("click", closeDeleteWorldModal);
    document.getElementById("cancelDeleteModalBtn")?.addEventListener("click", closeDeleteWorldModal);
    modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeDeleteWorldModal(); });
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modalEl.style.display === "flex") closeDeleteWorldModal();
    });
}

// 操作方法モーダル
const CONTROL_GUIDES = [
    { desc: "移動", keys: [{ t: "W" }, { t: "A" }, { t: "S" }, { t: "D" }] },
    { desc: "視点操作", keys: [{ t: "マウス移動", cls: "mouse" }] },
    { desc: "視点操作解除", keys: [{ t: "ESC" }] },
    { desc: "ジャンプ", keys: [{ t: "Space", cls: "wide" }] },
    { desc: "しゃがむ", keys: [{ t: "Shift", cls: "wide" }] },
    { desc: "ブロック破壊", keys: [{ t: "左クリック", cls: "mouse" }] },
    { desc: "ブロック設置", keys: [{ t: "右クリック", cls: "mouse" }] },
    { desc: "ブロック選択", keys: [{ t: "1" }, { sep: "〜" }, { t: "8" }, { sep: "/" }, { t: "ホイール", cls: "mouse" }] },
    { desc: "チャット", keys: [{ t: "Enter" }, { sep: "/" }, { t: "T" }] },
    { desc: "メモ設置（ブロック面を照準）", keys: [{ t: "M" }] },
    { desc: "メモ閲覧（メモを照準）", keys: [{ t: "左クリック", cls: "mouse" }] },
    { desc: "メモ削除（作成者のみ）", keys: [{ t: "削除ボタン" }] }
];

function openControlsModal() {
    if (!document.body.classList.contains("in-game") || isChatFocused || isBoardModalOpen() || isMemoModalOpen()) return;
    if (document.getElementById("deleteWorldModal")?.style.display === "flex") return;
    isControlsModalOpen = true;
    clearPlayerInputState();
    releasePointerLockSafely();
    if (targetOutlineMesh) targetOutlineMesh.isVisible = false;
    const modal = document.getElementById("controlsModal");
    if (modal) modal.style.display = "flex";
}

function closeControlsModal(shouldRequestPointerLock = false) {
    const modal = document.getElementById("controlsModal");
    if (modal) modal.style.display = "none";
    isControlsModalOpen = false;
    clearPlayerInputState();
    if (shouldRequestPointerLock) requestPointerLockSafely();
}

function initControlsModal() {
    const bodyEl = document.getElementById("controlsModalBody");
    if (bodyEl) {
        bodyEl.innerHTML = CONTROL_GUIDES.map(({ desc, keys }) => `
            <div class="control-row">
                <span class="control-desc">${desc}</span>
                <div class="key-caps">
                    ${keys.map((k) => k.sep
                        ? `<span class="key-sep">${k.sep}</span>`
                        : `<span class="key-cap${k.cls ? ` ${k.cls}` : ""}">${k.t}</span>`
                    ).join("")}
                </div>
            </div>
        `).join("");
    }

    document.getElementById("controlsHelpBtn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openControlsModal();
    });
    document.getElementById("closeControlsModalBtn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeControlsModal(true);
    });
    const modalEl = document.getElementById("controlsModal");
    modalEl?.addEventListener("click", (e) => {
        if (e.target === modalEl) closeControlsModal(false);
    });
}

async function loadAndRenderWorldList() {
    const container = document.getElementById("worldCardsContainer");
    const countEl = document.getElementById("worldListCount");
    const loadingEl = document.getElementById("worldListLoading");
    const errorEl = document.getElementById("worldListError");
    if (!container) return;

    setBannerMessage(errorEl, "");
    if (loadingEl) loadingEl.style.display = "block";
    container.innerHTML = "";

    try {
        const worlds = await fetchWorldList();
        if (loadingEl) loadingEl.style.display = "none";
        if (countEl) countEl.textContent = `登録ワールド (${worlds.length} 件)`;

        if (worlds.length === 0) {
            container.innerHTML = `<div class="empty-list-notice">ワールドがありません。「新規ワールド作成」から新しく作成してください。</div>`;
            return;
        }

        for (const w of worlds) {
            const card = document.createElement("div");
            card.className = "world-card";
            const isDefault = w.id === "default";
            const updatedDate = w.updated_at ? new Date(w.updated_at).toLocaleString("ja-JP") : "未保存";
            const canDelete = Boolean(getHostKey(w.id)) && !isDefault;
            const displayName = escapeHtml(w.name || w.id);
            const displayId = escapeHtml(w.id);

            card.innerHTML = `
                <div class="world-card-info">
                    <div class="world-card-title-row">
                        <span class="world-card-name">${displayName}</span>
                        ${isDefault ? '<span class="world-card-badge-default">デフォルト</span>' : ""}
                        <span class="world-card-id">${displayId}</span>
                    </div>
                    <div class="world-card-meta">
                        <span>🧱 <strong>${w.block_count || 0}</strong> ブロック</span>
                        <span>🕒 最終更新: ${updatedDate}</span>
                    </div>
                </div>
                <div class="world-card-actions">
                    <button class="join-world-btn">参加する 🚀</button>
                    ${canDelete ? '<button class="delete-world-btn" title="ワールドを完全に削除">🗑️ 削除</button>' : ""}
                </div>
            `;

            card.querySelector(".join-world-btn").addEventListener("click", () => enterWorld(w.id, w.name || w.id));
            card.querySelector(".delete-world-btn")?.addEventListener("click", (e) => {
                e.stopPropagation();
                openDeleteWorldModal(w.id, w.name || w.id);
            });
            container.appendChild(card);
        }
    } catch (error) {
        if (loadingEl) loadingEl.style.display = "none";
        setBannerMessage(errorEl, `一覧の読み込みに失敗しました: ${error.message}`);
    }
}

function initTitleScreen() {
    initDeleteWorldModal();
    initControlsModal();
    communityBoard?.initUI();
    worldMemos?.initUI();

    const tabListBtn = document.getElementById("tabWorldListBtn");
    const tabCreateBtn = document.getElementById("tabWorldCreateBtn");
    const panelList = document.getElementById("panelWorldList");
    const panelCreate = document.getElementById("panelWorldCreate");

    if (tabListBtn && tabCreateBtn && panelList && panelCreate) {
        const switchTab = (isList) => {
            tabListBtn.classList.toggle("active", isList);
            tabCreateBtn.classList.toggle("active", !isList);
            panelList.classList.toggle("active", isList);
            panelCreate.classList.toggle("active", !isList);
        };
        tabListBtn.addEventListener("click", () => { switchTab(true); loadAndRenderWorldList(); });
        tabCreateBtn.addEventListener("click", () => {
            switchTab(false);
            setBannerMessage(document.getElementById("createWorldError"), "");
            const nameInput = document.getElementById("newWorldNameInput");
            if (nameInput) { nameInput.value = ""; nameInput.focus(); }
        });
    }

    document.getElementById("refreshWorldListBtn")?.addEventListener("click", loadAndRenderWorldList);

    const createForm = document.getElementById("createWorldForm");
    const nameInput = document.getElementById("newWorldNameInput");
    const submitBtn = document.getElementById("createWorldSubmitBtn");
    const createError = document.getElementById("createWorldError");

    createForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const worldName = (nameInput?.value || "").trim();
        if (!worldName) return setBannerMessage(createError, "ワールド名を入力してください。");
        if (worldName.length > 50) return setBannerMessage(createError, "ワールド名は50文字以内で入力してください。");

        try {
            setBannerMessage(createError, "");
            submitBtn.disabled = true;
            submitBtn.textContent = "🛠️ 作成中...";
            const { world: newWorld, hostKey } = await createWorld(worldName);
            if (hostKey) saveHostKey(newWorld.id, hostKey);
            await enterWorld(newWorld.id, newWorld.name);
        } catch (err) {
            setBannerMessage(createError, err.message || "ワールド作成に失敗しました。");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "🛠️ ワールドを作成して参加";
        }
    });

    document.getElementById("leaveWorldBtn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("タイトル画面に戻りますか？")) exitToTitleScreen();
    });

    loadAndRenderWorldList();
}

// ==============================================================================
// 8. 他プレイヤーアバター・ネームプレート・チャット
// ==============================================================================
function hexToColor3(hex) {
    if (!hex || typeof hex !== "string") return new Color3(0.23, 0.51, 0.96);
    const n = parseInt(hex.replace("#", ""), 16);
    return new Color3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function createAvatarBox(name, size, pos, mat, parent) {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.material = mat;
    mesh.parent = parent;
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    return mesh;
}

function createPlayerAvatar(player) {
    if (!player?.id) return;
    if (otherPlayers.has(player.id)) removePlayerAvatar(player.id);

    const playerId = player.id;
    const color = hexToColor3(player.color);
    const initPos = player.position || { x: 0, y: 2.1, z: 0 };
    const initRot = player.rotation || { x: 0, y: 0 };

    const rootNode = new TransformNode(`avatar_root_${playerId}`, scene);
    rootNode.position.set(initPos.x, initPos.y, initPos.z);
    rootNode.rotation.y = initRot.y || 0;

    const bodyMat = new StandardMaterial(`avatar_body_mat_${playerId}`, scene);
    bodyMat.diffuseColor = color;
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    bodyMat.emissiveColor = color.scale(0.15);

    const headMat = new StandardMaterial(`avatar_head_mat_${playerId}`, scene);
    headMat.diffuseColor = new Color3(0.95, 0.8, 0.65);
    headMat.specularColor = new Color3(0.1, 0.1, 0.1);

    const eyeMat = new StandardMaterial(`avatar_eye_mat_${playerId}`, scene);
    eyeMat.diffuseColor = new Color3(0.1, 0.1, 0.1);

    const head = createAvatarBox(`avatar_head_${playerId}`, { width: 0.5, height: 0.5, depth: 0.5 }, [0, 0, 0], headMat, rootNode);
    head.rotation.x = initRot.x || 0;
    const meshes = [
        head,
        createAvatarBox(`avatar_eyeL_${playerId}`, { width: 0.1, height: 0.1, depth: 0.05 }, [-0.12, 0.05, 0.26], eyeMat, head),
        createAvatarBox(`avatar_eyeR_${playerId}`, { width: 0.1, height: 0.1, depth: 0.05 }, [0.12, 0.05, 0.26], eyeMat, head),
        createAvatarBox(`avatar_body_${playerId}`, { width: 0.6, height: 0.7, depth: 0.35 }, [0, -0.6, 0], bodyMat, rootNode),
        createAvatarBox(`avatar_legL_${playerId}`, { width: 0.25, height: 0.6, depth: 0.3 }, [-0.15, -1.25, 0], bodyMat, rootNode),
        createAvatarBox(`avatar_legR_${playerId}`, { width: 0.25, height: 0.6, depth: 0.3 }, [0.15, -1.25, 0], bodyMat, rootNode)
    ];

    otherPlayers.set(playerId, {
        player,
        root: rootNode,
        head,
        nameplate: createNameplate(player.name || "Player", rootNode),
        targetPosition: new Vector3(initPos.x, initPos.y, initPos.z),
        targetRotationY: initRot.y || 0,
        targetHeadRotationX: initRot.x || 0,
        meshes,
        materials: [bodyMat, headMat, eyeMat]
    });
}

function createNameplate(playerName, parentRoot) {
    const plane = MeshBuilder.CreatePlane(`nameplate_${parentRoot.name}`, { width: 1.8, height: 0.45 }, scene);
    plane.parent = parentRoot;
    plane.position.set(0, 0.55, 0);
    plane.billboardMode = 7;
    plane.isPickable = false;
    plane.checkCollisions = false;

    const texture = new DynamicTexture(`nameplate_tex_${parentRoot.name}`, { width: 512, height: 128 }, scene, false);
    texture.hasAlpha = true;
    updateNameplateTexture(texture, playerName);

    const mat = new StandardMaterial(`nameplate_mat_${parentRoot.name}`, scene);
    mat.diffuseTexture = texture;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    plane.material = mat;

    return { plane, texture, mat };
}

function updateNameplateTexture(texture, name, w = 512, h = 128) {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(10, 10, 20, 0.7)";
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(12, 12, w - 24, h - 24, 20);
        ctx.fill();
    } else {
        ctx.fillRect(12, 12, w - 24, h - 24);
    }
    texture.drawText(name || "Player", null, 82, "bold 46px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", "#FFFFFF", "transparent", true);
}

function lerpAngle(current, target, factor) {
    let diff = (target - current) % (Math.PI * 2);
    if (diff < -Math.PI) diff += Math.PI * 2;
    if (diff > Math.PI) diff -= Math.PI * 2;
    return current + diff * factor;
}

function removePlayerAvatar(playerId) {
    const entry = otherPlayers.get(playerId);
    try {
        if (entry) {
            if (entry.nameplate) {
                try { entry.nameplate.plane?.dispose?.(); } catch (_) { }
                try { entry.nameplate.texture?.dispose?.(); } catch (_) { }
                try { entry.nameplate.mat?.dispose?.(); } catch (_) { }
            }
            for (const m of entry.meshes || []) { try { m?.dispose?.(); } catch (_) { } }
            for (const mat of entry.materials || []) { try { mat?.dispose?.(); } catch (_) { } }
            try { entry.root?.dispose?.(false, true); } catch (_) { }
        }
        scene.meshes?.filter((m) => m?.name?.includes(playerId)).forEach((m) => { try { m.dispose(); } catch (_) { } });
        scene.transformNodes?.filter((t) => t?.name?.includes(playerId)).forEach((t) => { try { t.dispose(); } catch (_) { } });
    } catch (err) {
        console.error(`❌ [マルチプレイ] アバター破棄エラー (${playerId}):`, err);
    } finally {
        otherPlayers.delete(playerId);
    }
}

// プレイヤー名UI表示 & 名前変更
const playerNameDisplay = document.getElementById("playerNameDisplay");
if (playerNameDisplay) playerNameDisplay.textContent = myPlayerName;

document.getElementById("changeNameBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const inputName = prompt("新しいプレイヤー名を入力してください (1〜20文字):", myPlayerName);
    if (inputName === null) return;
    const trimmed = inputName.trim();
    if (trimmed.length >= 1 && trimmed.length <= 20) {
        myPlayerName = trimmed;
        localStorage.setItem(PLAYER_NAME_STORAGE_KEY, myPlayerName);
        if (playerNameDisplay) playerNameDisplay.textContent = myPlayerName;
        sendChangeName(myPlayerName);
        updateMyPlayerNameInList(myPlayerName);
        showStatus(`プレイヤー名を '${myPlayerName}' に変更しました`, "info", 3000);
    } else {
        alert("プレイヤー名は1文字以上20文字以内で入力してください。");
    }
});

// チャットUI
const chatInput = document.getElementById("chat-input");
const chatForm = document.getElementById("chat-form");
const chatMessages = document.getElementById("chat-messages");

chatInput?.addEventListener("focus", () => {
    isChatFocused = true;
    clearPlayerInputState();
    releasePointerLockSafely();
});
chatInput?.addEventListener("blur", () => { isChatFocused = false; });
chatForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput?.value.trim() || "";
    if (text.length >= 1 && text.length <= 200) {
        sendChatMessage(text);
        chatInput.value = "";
        chatInput.blur();
    }
});

function addChatMessageToUI(message) {
    if (!chatMessages) return;
    const line = document.createElement("div");
    line.className = "chat-line";

    const timeSpan = document.createElement("span");
    timeSpan.className = "chat-time";
    timeSpan.textContent = `[${message.timestamp || ""}]`;

    const senderSpan = document.createElement("span");
    senderSpan.className = "chat-sender";
    senderSpan.textContent = `<${message.senderName || "Unknown"}>:`;
    if (message.senderColor) senderSpan.style.color = message.senderColor;

    const textSpan = document.createElement("span");
    textSpan.className = "chat-text";
    textSpan.textContent = ` ${message.text || ""}`;

    line.append(timeSpan, senderSpan, textSpan);
    chatMessages.appendChild(line);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==============================================================================
// 9. ネットワークイベント連携 & 毎フレーム更新ループ
// ==============================================================================
setNetworkListeners({
    onConnect: (socketId) => {
        showStatus("サーバーに接続しました", "success", 2000);
        const myEntry = onlineWorldPlayers.get("me");
        if (myEntry) {
            onlineWorldPlayers.delete("me");
            myEntry.id = socketId;
            onlineWorldPlayers.set(socketId, myEntry);
            renderOnlinePlayersList();
        }
        if (isWorldReady && currentActiveWorldId) {
            worldMemos?.loadForWorld(currentActiveWorldId);
        }
    },
    onDisconnect: () => {
        showStatus("サーバーから切断されました。再接続を試行中...", "warning", 4000);
        for (const opId of Array.from(pendingOperations.keys())) rollbackOperation(opId);
    },
    onCurrentPlayers: (players) => {
        const activeIds = new Set(players.map((p) => p.id));
        for (const existingId of Array.from(otherPlayers.keys())) {
            if (!activeIds.has(existingId)) removePlayerAvatar(existingId);
        }
        players.forEach(createPlayerAvatar);

        onlineWorldPlayers.clear();
        const myId = getSocketId() || "me";
        onlineWorldPlayers.set(myId, { id: myId, name: myPlayerName, color: "#38bdf8", isMe: true });
        for (const p of players) {
            if (p.id !== myId) {
                onlineWorldPlayers.set(p.id, { id: p.id, name: p.name || "Player", color: p.color || "#888", isMe: false });
            }
        }
        renderOnlinePlayersList();
    },
    onPlayerJoined: (player) => {
        createPlayerAvatar(player);
        if (player.id !== getSocketId()) {
            onlineWorldPlayers.set(player.id, { id: player.id, name: player.name || "Player", color: player.color || "#888", isMe: false });
            renderOnlinePlayersList();
            showPlayerNotification("join", player.name || "Player");
        }
    },
    onPlayerMoved: (data) => {
        const entry = otherPlayers.get(data.id);
        if (!entry) return;
        if (data.position) entry.targetPosition.set(data.position.x, data.position.y, data.position.z);
        if (typeof data.rotation?.y === "number") entry.targetRotationY = data.rotation.y;
        if (typeof data.rotation?.x === "number") entry.targetHeadRotationX = data.rotation.x;
    },
    onPlayerLeft: (playerId) => {
        if (playerId === getSocketId()) return;
        const p = onlineWorldPlayers.get(playerId) || otherPlayers.get(playerId);
        const leftName = p?.name || p?.player?.name || "Player";
        removePlayerAvatar(playerId);
        onlineWorldPlayers.delete(playerId);
        renderOnlinePlayersList();
        showPlayerNotification("leave", leftName);
    },
    onBlockPlaced: (data) => {
        const { x, y, z, type, operationId } = data;
        if (resolvePendingBlockOp(getBlockKey(x, y, z), operationId, "設置")) return;
        const blockType = BLOCK_TYPE_BY_NAME[type];
        if (blockType) addBlock(x, y, z, blockType);
    },
    onBlockBroken: (data) => {
        const { x, y, z, operationId } = data;
        if (resolvePendingBlockOp(getBlockKey(x, y, z), operationId, "破壊")) return;
        removeBlock(x, y, z);
    },
    onBlockOperationError: (data) => {
        console.error(`⚠️ [マルチプレイ] ブロック操作エラー (${data.operation}): ${data.message}`, data.details || "");
        showStatus(`ブロック操作に失敗しました: ${data.message}`, "error", 4000);
        if (data.operationId && pendingOperations.has(data.operationId)) {
            rollbackOperation(data.operationId);
        } else if (typeof data.x === "number" && typeof data.y === "number" && typeof data.z === "number") {
            const opId = pendingByPosition.get(getBlockKey(data.x, data.y, data.z));
            if (opId) rollbackOperation(opId);
        }
    },
    onChatMessage: addChatMessageToUI,
    onChatHistory: (history) => {
        if (chatMessages) chatMessages.innerHTML = "";
        history.forEach(addChatMessageToUI);
    },
    onPlayerNameChanged: (data) => {
        const entry = otherPlayers.get(data.id);
        if (entry) {
            entry.player.name = data.name;
            if (entry.nameplate?.texture) updateNameplateTexture(entry.nameplate.texture, data.name);
        }
        const onlineP = onlineWorldPlayers.get(data.id);
        if (onlineP) {
            onlineP.name = data.name;
            renderOnlinePlayersList();
        }
    },
    onBoardPostCreated: (post) => communityBoard?.onPostCreated(post),
    onBoardPostDeleted: (data) => communityBoard?.onPostDeleted(data),
    onWorldMemoCreated: (memo) => worldMemos?.onMemoCreated(memo),
    onWorldMemoDeleted: (data) => worldMemos?.onMemoDeleted(data)
});

initNetwork();
initTitleScreen();

scene.onBeforeRenderObservable.add(() => {
    const delta = engine.getDeltaTime() / 1000;
    updatePlayerPhysics(delta);

    const lerpFactor = Math.min(1.0, 15.0 * delta);
    for (const entry of otherPlayers.values()) {
        if (!entry.root || entry.root.isDisposed()) continue;
        if (entry.targetPosition) Vector3.LerpToRef(entry.root.position, entry.targetPosition, lerpFactor, entry.root.position);
        if (typeof entry.targetRotationY === "number") entry.root.rotation.y = lerpAngle(entry.root.rotation.y, entry.targetRotationY, lerpFactor);
        if (entry.head && !entry.head.isDisposed() && typeof entry.targetHeadRotationX === "number") {
            entry.head.rotation.x = lerpAngle(entry.head.rotation.x, entry.targetHeadRotationX, lerpFactor);
        }
    }

    if (camera && isWorldReady) {
        sendPlayerMove(
            { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            { x: camera.rotation.x, y: camera.rotation.y }
        );
    }

    updateTargetBlockHighlight();
    communityBoard?.updateProximityPrompt(isPointingAtCommunityBoard());
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());

export {};
