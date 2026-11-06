// 送りすぎの防止（同じ相手からの連続アクセスを数える）と、操作の記録。
// Cloudflare ではリクエストごとにメモリが消えるので、どちらもデータベースに置く。

/** windowMs の間に limit 回まで（区切った時間ごとに数える） */
export function createRateLimiter(db, { name, limit, windowMs, now = () => Date.now() }) {
  return {
    async allow(key) {
      const t = now();
      const row = await db.get(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
         RETURNING count`,
        [`${name}:${key}`, t, t - windowMs, t - windowMs],
      );
      // ときどき古い記録を片づける
      if (Math.random() < 0.02) await db.run('DELETE FROM rate_limits WHERE window_start < ?', [t - 24 * 60 * 60 * 1000]);
      return (row?.count ?? 1) <= limit;
    },
  };
}

export function createAudit(db, { now = () => new Date() } = {}) {
  return {
    async log(action, detail = '', ip = '') {
      await db.run('INSERT INTO audit_log (at, action, detail, ip) VALUES (?, ?, ?, ?)', [
        new Date(now()).toISOString(),
        action,
        String(detail).slice(0, 300),
        ip,
      ]);
      // 古い記録は5000件を超えたら消す
      if (Math.random() < 0.02) {
        await db.run('DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 5000)');
      }
    },
    async list(limit = 200) {
      const rows = await db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
      return rows.map((r) => ({ at: r.at, action: r.action, detail: r.detail, ip: r.ip }));
    },
  };
}
