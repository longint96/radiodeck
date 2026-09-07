const TRANSLIT_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(str) {
  return str
    .toLowerCase()
    .split('')
    .map((ch) => (ch in TRANSLIT_MAP ? TRANSLIT_MAP[ch] : ch))
    .join('');
}

/**
 * Превращает произвольное название станции в безопасный url-slug.
 * "Радио Ретро 90-х" -> "radio-retro-90-h"
 */
function slugify(name) {
  const base = transliterate(String(name).trim())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'station';
}

/**
 * Гарантирует уникальность слага среди уже существующих значений,
 * добавляя суффикс -2, -3, ... при коллизии.
 */
function uniqueSlug(baseSlug, existingSlugs) {
  if (!existingSlugs.includes(baseSlug)) return baseSlug;
  let i = 2;
  while (existingSlugs.includes(`${baseSlug}-${i}`)) i += 1;
  return `${baseSlug}-${i}`;
}

module.exports = { slugify, uniqueSlug };
