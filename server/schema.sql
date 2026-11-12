-- ==============================================================================
-- CRAFT & SHARE: データベース初期化スキーマ (PostgreSQL用)
-- ==============================================================================
-- このSQLファイルは、ワールド情報と各ブロックの配置情報を保存するためのテーブルを作成します。
-- 初心者の方でも理解しやすいよう、各行に解説コメントを付けています。
-- ==============================================================================

-- 既存のテーブルがある場合は、リセットしやすいように一旦削除します
-- （CASCADEをつけることで、関連する外部キー制約も一緒に削除されます）
DROP TABLE IF EXISTS blocks CASCADE;
DROP TABLE IF EXISTS worlds CASCADE;

-- ------------------------------------------------------------------------------
-- 1. worlds テーブル（ワールド管理用テーブル）
-- ------------------------------------------------------------------------------
-- 複数のワールド（例: 'default', 'world-2' など）を管理するための親テーブルです。
-- 初期地形が生成済みかどうかを判定するフラグもここで管理します。
-- ------------------------------------------------------------------------------
CREATE TABLE worlds (
    -- ワールドの一意な識別子（ID）: 主キー（Primary Key）
    -- 例: 'default' などの文字列が入ります
    id VARCHAR(50) PRIMARY KEY,

    -- ワールドが初期化（最初の地形生成・保存）済みかどうかを示す真偽値
    -- FALSE: まだ初期地形が作られていない（ゲーム起動時に自動生成を行う）
    -- TRUE:  既に初期地形がDBに保存されている（DBから読み込んで復元する）
    is_initialized BOOLEAN NOT NULL DEFAULT FALSE,

    -- このワールドが作成された日時（デフォルトで現在時刻が入ります）
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- このワールド情報が最後に更新された日時
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------------------
-- 2. blocks テーブル（ブロック配置情報テーブル）
-- ------------------------------------------------------------------------------
-- ワールド内のすべてのブロック（1×1×1の立方体）の位置と種類を保存する子テーブルです。
-- ------------------------------------------------------------------------------
CREATE TABLE blocks (
    -- どのワールドに属するブロックかを示すID
    -- worldsテーブルの id を参照する外部キー（Foreign Key）です
    world_id VARCHAR(50) NOT NULL,

    -- ブロックの3Dグリッド座標（整数）
    x INTEGER NOT NULL, -- 横方向の位置
    y INTEGER NOT NULL, -- 高さ（上下）の位置
    z INTEGER NOT NULL, -- 奥行き方向の位置

    -- ブロックの種類（文字列）
    -- CHECK制約により、定義済みの 'grass', 'dirt', 'stone', 'wood', 'sand', 'glass', 'leaves', 'brick' 以外の値が入らないよう保護します
    block_type VARCHAR(20) NOT NULL CHECK (block_type IN ('grass', 'dirt', 'stone', 'wood', 'sand', 'glass', 'leaves', 'brick')),

    -- このブロックが設置・更新された日時
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- 【複合主キー（Composite Primary Key）】
    -- (world_id, x, y, z) の4つの組み合わせを主キーに設定します。
    -- これにより「同一ワールドの同一座標には1つしかブロックが存在できない」ことがDB側で保証されます
    PRIMARY KEY (world_id, x, y, z),

    -- 【外部キー制約（Foreign Key Constraint）】
    -- worlds テーブルの id と紐付けます。
    -- ON DELETE CASCADE: 親のワールドが削除された場合、そのワールドに属するブロックも自動で全削除されます
    CONSTRAINT fk_world
        FOREIGN KEY (world_id)
        REFERENCES worlds(id)
        ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- 3. 初期データの挿入（初期ワールドの登録）
-- ------------------------------------------------------------------------------
-- 最初に使用するデフォルトのワールド 'default' を登録しておきます。
-- 初回起動時はまだ地形が作られていないため is_initialized は FALSE です。
-- ------------------------------------------------------------------------------
INSERT INTO worlds (id, is_initialized)
VALUES ('default', FALSE)
ON CONFLICT (id) DO NOTHING;
