// Cloudflare D1 を、共通の形（all / get / run / batch）で使えるようにする
export function d1Database(d1) {
  const toD1 = (p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return Number(p);
    if (p instanceof Uint8Array) return p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength);
    return p;
  };
  const bind = (sql, params) => d1.prepare(sql).bind(...params.map(toD1));
  const result = (r) => ({ changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? 0 });

  return {
    async all(sql, params = []) {
      return (await bind(sql, params).all()).results;
    },
    async get(sql, params = []) {
      return (await bind(sql, params).first()) ?? null;
    },
    async run(sql, params = []) {
      return result(await bind(sql, params).run());
    },
    /** D1 の batch はひとまとまり（途中で失敗したら全部取り消し） */
    async batch(list) {
      const results = await d1.batch(list.map(([sql, params = []]) => bind(sql, params)));
      return results.map(result);
    },
    close() {},
  };
}
