import pg from 'pg';

// Return BIGINT/COUNT values as JS numbers (all counts and GitHub ids we use fit safely).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// Keep DATE columns as 'YYYY-MM-DD' strings; converting to JS Date would shift them by the server timezone.
pg.types.setTypeParser(1082, (v) => v);
