import type { DbClient } from '../db/pool';

/**
 * Short building code from its name, unique within the plant: "Data Center" → DC, "Hall 3" → H3,
 * "Administration" → ADM; a number is appended when the code is taken (DC2, DC3 …).
 */
export async function uniqueBuildingCode(db: DbClient, plantId: string, name: string): Promise<string> {
  const words = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let base = words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join('');
  if (base.length < 2) base = words[0] ?? '';
  base = base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, words.length > 1 ? 8 : 3) || 'B';

  const { rows } = await db.query<{ code: string }>('SELECT lower(code) AS code FROM building WHERE plant_id = $1', [plantId]);
  const taken = new Set(rows.map((r) => r.code));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}
