/** Indexed read that fails loudly instead of yielding `undefined` (the scorers index dense arrays only). */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range (length ${items.length})`);
  return item;
}

/** Keyed read that fails loudly when the key is absent. */
export function get<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`missing entry ${key}`);
  return value;
}
