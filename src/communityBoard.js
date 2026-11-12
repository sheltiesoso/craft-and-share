import { MeshBuilder, StandardMaterial, Color3, TransformNode, Texture } from "@babylonjs/core";
import { fetchBoardPosts, createBoardPost, deleteBoardPost } from "./network.js";

const BOARD_WORLD_X = 1.0;
const BOARD_WORLD_Z = 2.5;
const BOARD_TEXTURE_PATH = "/assets/board-face.png";
const AUTHOR_KEY_STORAGE = "craft_board_author_key";

/** ブラウザ固有の投稿者認証キーを取得または生成する（掲示板・ワールドメモ共通） */
export function getOrCreateAuthorKey() {
    try {
        const existing = localStorage.getItem(AUTHOR_KEY_STORAGE);
        if (existing && /^[a-zA-Z0-9_-]{16,128}$/.test(existing)) return existing;
        const bytes = new Uint8Array(32);
        window.crypto.getRandomValues(bytes);
        const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        localStorage.setItem(AUTHOR_KEY_STORAGE, key);
        return key;
    } catch (_) {
        return `fallback_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    }
}

/** DOM要素を安全に生成するヘルパー */
function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Community Board（3Dオブジェクト＋掲示板UI＋同期制御）を生成して返す
 */
export function createCommunityBoard({
    scene,
    camera,
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
    hideTargetOutline
}) {
    let boardRoot = null;
    let boardBaseY = 0.5;
    let isOpen = false;
    let isLoading = false;
    let postsCache = [];
    let categoryFilter = "すべて";
    let textureChecked = false;

    const showError = (msg) => {
        const banner = document.getElementById("boardErrorBanner");
        if (!banner) return;
        banner.textContent = msg || "";
        banner.style.display = msg ? "block" : "none";
    };

    const formatDate = (iso) => {
        const d = iso ? new Date(iso) : null;
        if (!d || Number.isNaN(d.getTime())) return "";
        return d.toLocaleString("ja-JP", {
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
        });
    };

    // --- 3D掲示板オブジェクト ---
    const ensureBoardMesh = () => {
        if (boardRoot) return boardRoot;

        const root = new TransformNode("community_board_root", scene);
        const woodMat = new StandardMaterial("boardWoodMat", scene);
        woodMat.diffuseColor = new Color3(0.42, 0.25, 0.14);
        woodMat.specularColor = new Color3(0.05, 0.05, 0.05);

        const faceMat = new StandardMaterial("boardFaceMat", scene);
        faceMat.diffuseColor = new Color3(0.71, 0.52, 0.33);
        faceMat.specularColor = new Color3(0.04, 0.04, 0.04);

        // public/assets/board-face.png が配置されていればテクスチャを適用（未配置時は単色のままエラーを出さない）
        if (!textureChecked) {
            textureChecked = true;
            fetch(BOARD_TEXTURE_PATH, { method: "HEAD" })
                .then((res) => {
                    const type = res.headers.get("content-type") || "";
                    if (res.ok && type.startsWith("image/")) {
                        faceMat.diffuseColor = Color3.White();
                        faceMat.diffuseTexture = new Texture(BOARD_TEXTURE_PATH, scene);
                    }
                })
                .catch(() => {});
        }

        const addPart = (name, dims, pos, mat) => {
            const mesh = MeshBuilder.CreateBox(name, dims, scene);
            mesh.position.set(pos[0], pos[1], pos[2]);
            mesh.material = mat;
            mesh.checkCollisions = true;
            mesh.isPickable = true;
            mesh.metadata = { isCommunityBoard: true };
            mesh.parent = root;
            return mesh;
        };

        // シンプルな木製掲示板（支柱2本・木枠背面板1枚・画像テクスチャ面パネル1枚）
        addPart("board_post_l", { width: 0.14, height: 1.8, depth: 0.14 }, [-0.72, 0.9, 0], woodMat);
        addPart("board_post_r", { width: 0.14, height: 1.8, depth: 0.14 }, [0.72, 0.9, 0], woodMat);
        addPart("board_frame", { width: 1.56, height: 1.06, depth: 0.10 }, [0, 1.25, 0], woodMat);
        addPart("board_face", { width: 1.38, height: 0.90, depth: 0.12 }, [0, 1.25, 0], faceMat);

        boardRoot = root;
        return root;
    };

    const findSurfaceY = () => {
        for (let y = 20; y >= 0; y--) {
            if (world.has(`10,${y},12`) || world.has(`11,${y},12`)) {
                return y * blockSize + blockSize / 2;
            }
        }
        return 0.5;
    };

    const placeAtSpawn = () => {
        const root = ensureBoardMesh();
        boardBaseY = findSurfaceY();
        root.position.set(BOARD_WORLD_X, boardBaseY, BOARD_WORLD_Z);
        root.setEnabled(true);
    };

    const hideObject = () => {
        if (boardRoot) boardRoot.setEnabled(false);
        const promptEl = document.getElementById("boardInteractPrompt");
        if (promptEl) promptEl.style.display = "none";
    };

    const isCollidingWithGrid = (gx, gy, gz) => {
        const bx = gx * blockSize - offset;
        const by = gy * blockSize;
        const bz = gz * blockSize - offset;
        const half = blockSize / 2;
        return (
            bx + half > BOARD_WORLD_X - 0.9 && bx - half < BOARD_WORLD_X + 0.9 &&
            bz + half > BOARD_WORLD_Z - 0.35 && bz - half < BOARD_WORLD_Z + 0.35 &&
            by + half > boardBaseY + 0.01 && by - half < boardBaseY + 2.0
        );
    };

    // --- 投稿一覧レンダリング ---
    const renderPosts = () => {
        const listEl = document.getElementById("boardPostsList");
        const countEl = document.getElementById("boardPostCount");
        if (!listEl) return;

        listEl.innerHTML = "";
        if (isLoading) {
            listEl.appendChild(createEl("div", "board-loading", "📋 掲示板を読み込み中..."));
            if (countEl) countEl.textContent = "読込中...";
            return;
        }

        const filtered = categoryFilter === "すべて"
            ? postsCache
            : postsCache.filter((p) => p.category === categoryFilter);

        if (countEl) countEl.textContent = `${filtered.length} 件`;

        if (filtered.length === 0) {
            const msg = categoryFilter === "すべて"
                ? "まだメモが貼られていません。最初のメッセージを残してみましょう！"
                : `「${categoryFilter}」カテゴリの投稿はまだありません。`;
            listEl.appendChild(createEl("div", "board-empty", msg));
            return;
        }

        for (const post of filtered) {
            const isNotice = post.category === "お知らせ";
            const card = createEl("div", `board-note-card ${isNotice ? "category-notice" : ""}`);
            card.appendChild(createEl("span", "board-note-pin"));

            const meta = createEl("div", "board-note-meta");
            const metaLeft = createEl("div", "board-note-meta-left");
            metaLeft.appendChild(createEl("span", `board-note-badge ${isNotice ? "notice" : "chat"}`, isNotice ? "📢 お知らせ" : "💬 交流"));
            metaLeft.appendChild(createEl("span", "board-note-author", post.playerName || "Player"));

            const metaRight = createEl("div", "board-note-meta-right");
            metaRight.appendChild(createEl("span", "board-note-time", formatDate(post.createdAt)));

            if (post.isOwner) {
                const delBtn = createEl("button", "board-note-delete-btn", "🗑️ 削除");
                delBtn.type = "button";
                delBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    if (!confirm("この投稿を削除しますか？")) return;
                    delBtn.disabled = true;
                    delBtn.textContent = "削除中...";
                    showError("");
                    try {
                        await deleteBoardPost(post.id, getOrCreateAuthorKey());
                    } catch (err) {
                        showError(err.message || "投稿の削除に失敗しました。");
                        delBtn.disabled = false;
                        delBtn.textContent = "🗑️ 削除";
                    }
                });
                metaRight.appendChild(delBtn);
            }

            meta.appendChild(metaLeft);
            meta.appendChild(metaRight);
            card.appendChild(meta);
            card.appendChild(createEl("p", "board-note-content", post.content || ""));
            listEl.appendChild(card);
        }
    };

    const loadPosts = async () => {
        const requestedWorldId = getActiveWorld().id;
        isLoading = true;
        showError("");
        renderPosts();
        try {
            const { worldId, posts } = await fetchBoardPosts(getOrCreateAuthorKey());
            if (worldId === getActiveWorld().id && requestedWorldId === getActiveWorld().id) {
                postsCache = Array.isArray(posts) ? posts : [];
            }
        } catch (err) {
            showError(err.message || "掲示板の読み込みに失敗しました。");
        } finally {
            isLoading = false;
            renderPosts();
        }
    };

    // --- モーダル開閉・リセット ---
    const open = () => {
        if (!document.body.classList.contains("in-game") || !isGameReady()) return;
        if (isOpen || isBlockedByOtherUI()) return;

        isOpen = true;
        clearPlayerInputState();
        releasePointerLockSafely();
        hideTargetOutline();

        const promptEl = document.getElementById("boardInteractPrompt");
        if (promptEl) promptEl.style.display = "none";

        const worldLabel = document.getElementById("boardWorldNameLabel");
        const active = getActiveWorld();
        if (worldLabel) worldLabel.textContent = active.name || active.id;

        const modal = document.getElementById("communityBoardModal");
        if (modal) modal.style.display = "flex";
        loadPosts();
    };

    const close = (shouldRequestLock = false) => {
        const modal = document.getElementById("communityBoardModal");
        if (modal) modal.style.display = "none";
        isOpen = false;
        clearPlayerInputState();
        if (shouldRequestLock) requestPointerLockSafely();
    };

    const resetState = () => {
        postsCache = [];
        categoryFilter = "すべて";
        isLoading = false;
        showError("");

        document.querySelectorAll("#boardCategoryTabs .board-tab-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.category === "すべて");
        });

        const input = document.getElementById("boardContentInput");
        const counter = document.getElementById("boardCharCounter");
        if (input) input.value = "";
        if (counter) {
            counter.textContent = "0 / 300";
            counter.classList.remove("limit-near");
        }
        renderPosts();
    };

    // --- DOMイベント初期化 ---
    const initUI = () => {
        const modalEl = document.getElementById("communityBoardModal");
        const closeBtn = document.getElementById("closeBoardModalBtn");
        const tabs = document.getElementById("boardCategoryTabs");
        const form = document.getElementById("boardComposeForm");
        const select = document.getElementById("boardCategorySelect");
        const input = document.getElementById("boardContentInput");
        const counter = document.getElementById("boardCharCounter");
        const submitBtn = document.getElementById("boardSubmitBtn");

        if (closeBtn) closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(true); });
        if (modalEl) modalEl.addEventListener("click", (e) => { if (e.target === modalEl) close(false); });

        if (tabs) {
            tabs.addEventListener("click", (e) => {
                const btn = e.target.closest(".board-tab-btn");
                if (!btn) return;
                categoryFilter = btn.dataset.category || "すべて";
                tabs.querySelectorAll(".board-tab-btn").forEach((el) => el.classList.toggle("active", el === btn));
                renderPosts();
            });
        }

        if (input && counter) {
            input.addEventListener("input", () => {
                const len = input.value.length;
                counter.textContent = `${len} / 300`;
                counter.classList.toggle("limit-near", len >= 270);
            });
        }

        if (form && input && select && submitBtn) {
            form.addEventListener("submit", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                showError("");

                const trimmed = (input.value || "").trim();
                if (!trimmed) return showError("投稿内容を入力してください。");
                if (trimmed.length > 300) return showError("投稿内容は300文字以内で入力してください。");

                try {
                    submitBtn.disabled = true;
                    submitBtn.textContent = "投稿中...";
                    await createBoardPost(select.value, trimmed, getOrCreateAuthorKey());
                    input.value = "";
                    if (counter) {
                        counter.textContent = "0 / 300";
                        counter.classList.remove("limit-near");
                    }
                } catch (err) {
                    showError(err.message || "投稿の送信に失敗しました。");
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "📌 掲示板に投稿";
                }
            });
        }
    };

    const updateProximityPrompt = (pointingAtBoard) => {
        const promptEl = document.getElementById("boardInteractPrompt");
        if (!promptEl) return;
        const shouldShow =
            document.body.classList.contains("in-game") &&
            isGameReady() &&
            !isOpen &&
            !isBlockedByOtherUI() &&
            Boolean(pointingAtBoard);
        promptEl.style.display = shouldShow ? "flex" : "none";
    };

    const onPostCreated = (post) => {
        if (!post || post.worldId !== getActiveWorld().id) return;
        if (postsCache.some((p) => p.id === post.id)) return;
        const myId = getSocketId();
        postsCache.unshift({ ...post, isOwner: Boolean(myId && post.senderId === myId) });
        if (postsCache.length > 50) postsCache = postsCache.slice(0, 50);
        if (isOpen) renderPosts();
    };

    const onPostDeleted = (data) => {
        if (!data || data.worldId !== getActiveWorld().id) return;
        const next = postsCache.filter((p) => p.id !== data.id);
        if (next.length !== postsCache.length) {
            postsCache = next;
            if (isOpen) renderPosts();
        }
    };

    return {
        isOpen: () => isOpen,
        isCollidingWithGrid,
        placeAtSpawn,
        hideObject,
        open,
        close,
        resetState,
        initUI,
        updateProximityPrompt,
        onPostCreated,
        onPostDeleted
    };
}

