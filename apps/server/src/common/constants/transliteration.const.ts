/**
 * Russian alphabet to Latin transliteration constants.
 * Contains the complete Russian alphabet (33 letters) with their phonetic Latin equivalents.
 * Exported as a Map for efficient lookups and to avoid recreating the map on every function call.
 */

/**
 * Russian alphabet (33 letters) to Latin transliteration map.
 * Includes both lowercase and uppercase letters.
 * Special characters (ъ, ь) are mapped to empty strings for removal.
 */
export const CYRILLIC_TO_LATIN_MAP = new Map<string, string>([
  // Lowercase Russian alphabet
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['ё', 'yo'],
  ['ж', 'zh'],
  ['з', 'z'],
  ['и', 'i'],
  ['й', 'y'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['х', 'h'],
  ['ц', 'ts'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'shch'],
  ['ъ', ''],
  ['ы', 'y'],
  ['ь', ''],
  ['э', 'e'],
  ['ю', 'yu'],
  ['я', 'ya'],
  // Uppercase Russian alphabet
  ['А', 'A'],
  ['Б', 'B'],
  ['В', 'V'],
  ['Г', 'G'],
  ['Д', 'D'],
  ['Е', 'E'],
  ['Ё', 'Yo'],
  ['Ж', 'Zh'],
  ['З', 'Z'],
  ['И', 'I'],
  ['Й', 'Y'],
  ['К', 'K'],
  ['Л', 'L'],
  ['М', 'M'],
  ['Н', 'N'],
  ['О', 'O'],
  ['П', 'P'],
  ['Р', 'R'],
  ['С', 'S'],
  ['Т', 'T'],
  ['У', 'U'],
  ['Ф', 'F'],
  ['Х', 'H'],
  ['Ц', 'Ts'],
  ['Ч', 'Ch'],
  ['Ш', 'Sh'],
  ['Щ', 'Shch'],
  ['Ъ', ''],
  ['Ы', 'Y'],
  ['Ь', ''],
  ['Э', 'E'],
  ['Ю', 'Yu'],
  ['Я', 'Ya'],
]);

/**
 * Regular expression pattern for matching Russian Cyrillic characters.
 * Includes all 33 letters in both lowercase and uppercase.
 */
export const CYRILLIC_PATTERN = /[а-яёъыьА-ЯЁЪЫЬ]/g;
