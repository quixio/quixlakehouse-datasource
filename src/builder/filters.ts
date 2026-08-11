import { BuilderFilter } from '../types';

/**
 * Query parameters for looking up one filter's possible values.
 *
 * The catalog narrows a partition column's values by its ANCESTORS: any extra query
 * parameter is treated as an equality constraint on a column earlier in the partition
 * spec. Sending them is what stops a second filter offering values that cannot
 * co-exist with the first — choosing one of those produced a query with no rows and
 * nothing on screen explaining why (sc-74547).
 *
 * Two constraints are dropped rather than passed:
 *
 *  - **Descendants and same-level columns.** Only a column earlier in the spec is an
 *    ancestor. Sending a later one is not a narrowing the catalog can honour.
 *  - **Non-equality operators.** A partition is a directory; `>` or `!=` does not
 *    identify one, so it cannot narrow the lookup even though it will still filter the
 *    final query.
 *
 * A column absent from the partition spec is not a partition at all, so it neither
 * narrows others nor can be narrowed itself; it is skipped, and the caller falls back
 * to the unnarrowed list with custom values still allowed.
 *
 * Pure and separate from the component so it can be tested without driving a
 * react-select in jsdom, where the placeholder is a div and interaction is fragile.
 */
export function partitionValuesParams(
  table: string,
  column: string,
  otherFilters: BuilderFilter[],
  partitionColumns: string[]
): Record<string, string> {
  const params: Record<string, string> = { table, column };
  const myDepth = partitionColumns.indexOf(column);

  for (const f of otherFilters) {
    const key = (f.key ?? '').trim();
    const value = (f.value ?? '').trim();
    if (key === '' || value === '' || f.operator !== '=') {
      continue;
    }
    // Never let a filter overwrite the two reserved parameters.
    if (key === 'table' || key === 'column') {
      continue;
    }
    const depth = partitionColumns.indexOf(key);
    if (depth === -1) {
      continue;
    }
    if (myDepth !== -1 && depth >= myDepth) {
      continue;
    }
    params[key] = value;
  }

  return params;
}
