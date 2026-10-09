/** UTF-16 code-unit order: what `Array#sort()` does with no comparator, made explicit. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  return a > b ? 1 : 0
}
