// ==============================================================================
// CRAFT & SHARE: データベース接続設定 (server/db.js)
// ==============================================================================
// PostgreSQL (Neon) への接続プール（Connection Pool）を作成・管理するモジュールです。
// ==============================================================================

const { Pool } = require('pg');
const dotenv = require('dotenv');

// .env ファイルから環境変数を読み込みます
dotenv.config();

// DATABASE_URLが設定されているか確認
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.warn('⚠️  [DB警告] 環境変数 DATABASE_URL が設定されていません。.env ファイルを確認してください。');
}

// 接続プール（Pool）を作成
// - 接続プールを使うことで、リクエストごとに毎回接続・切断するオーバーヘッドを削減できます
// - NeonなどのクラウドPostgreSQLはSSL通信が必須となるため、ssl設定を有効にしています
const pool = new Pool({
    connectionString: connectionString,
    // ローカル環境（localhost）以外（Neon等のクラウド環境）ではSSL接続を有効化
    ssl: connectionString && connectionString.includes('localhost')
        ? false
        : { rejectUnauthorized: false }
});

// プール内で予期せぬエラーが発生した場合のハンドリング
pool.on('error', (err) => {
    console.error('❌ [DBエラー] データベースプールで予期せぬエラーが発生しました:', err.message);
});

/**
 * データベースへの接続テストを行う関数
 * @returns {Promise<boolean>} 接続成功なら true、失敗なら false
 */
async function testConnection() {
    if (!connectionString) {
        console.error('❌ [DB接続テスト] DATABASE_URL が未設定のため、接続テストをスキップしました。');
        return false;
    }

    try {
        console.log('🔄 [DB接続テスト] PostgreSQLへの接続を確認しています...');
        // 現在日時を取得する軽量なクエリを実行して接続を確認
        const result = await pool.query('SELECT NOW() as current_time, current_database() as db_name');
        console.log('✅ [DB接続成功] PostgreSQLに正常に接続されました！');
        console.log(`   - データベース名: ${result.rows[0].db_name}`);
        console.log(`   - DB現在時刻: ${result.rows[0].current_time}`);
        return true;
    } catch (error) {
        console.error('❌ [DB接続失敗] データベースへの接続に失敗しました:');
        console.error(`   理由: ${error.message}`);
        return false;
    }
}

module.exports = {
    pool,
    testConnection
};
