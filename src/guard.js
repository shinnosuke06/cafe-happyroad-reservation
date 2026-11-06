// 送りすぎの防止（同じ相手からの連続アクセスを数える）と、操作の記録

/** windowMs の間に limit 回まで */
export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 10_000) {
        for (const [k, list] of hits) if (list.every((x) => x <= t - windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

export function createAudit(db, { now = () => new Date() } = {}) {
  const insert = db.prepare('INSERT INTO audit_log (at, action, detail, ip) VALUES (?, ?, ?, ?)');
  const recent = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?');
  const trim = db.prepare('DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 5000)');
  let count = 0;
  return {
    log(action, detail = '', ip = '') {
      insert.run(new Date(now()).toISOString(), action, String(detail).slice(0, 300), ip);
      if (++count % 200 === 0) trim.run(); // 古い記録は5000件を超えたら消す
    },
    list(limit = 200) {
      return recent.all(limit).map((r) => ({ at: r.at, action: r.action, detail: r.detail, ip: r.ip }));
    },
  };
}
