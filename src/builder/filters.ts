import { BuilderFilter } from '../types';

/**
 * Query parameters for looking up one filter's possible values.
 *
 * The catalog narrows a partition column's values by every other partition column it is
 * given: each extra query parameter is an equality constraint, and the lookup returns
 * the values that still co-exist with all of them. Sending them is what stops a second
 * filter offering values that cannot co-exist with the first — choosing one of those
 * produced a query with no rows and nothing on screen explaining why (sc-74547).
 *
 * **Position in the partition spec is deliberately not consulted.** An earlier version
 * passed only columns above the one being looked up, on the assumption that a partition
 * is a directory path and only a parent can constrain a child. The catalog does not work
 * that way — it intersects constraints in any direction. Measured on `can_signals_v13`:
 * `sender_node` has 44 values unfiltered and 1 when narrowed by `frame_name`, which sits
 * *below* it in the spec. Skipped levels are fine too: `sender_node` under `platform`
 * alone returns the same 9 values as the full parent chain.
 *
 * That assumption was the bug: whether a filter took effect depended on an ordering the
 * user cannot see, so the same two choices narrowed one row and did nothing to another.
 * The spec order is also not always a hierarchy — `can_signals` reports `channel_name`
 * *after* `signal`, because the list accumulates across schema changes.
 *
 * Two kinds of filter are still dropped:
 *
 *  - **Non-equality operators.** A partition is a directory; `>` or `!=` does not
 *    identify one, so it cannot narrow the lookup even though it will still filter the
 *    final query.
 *  - **Columns absent from the partition spec.** Not partitions at all, so they neither
 *    narrow others nor can be narrowed themselves. The caller falls back to the
 *    unnarrowed list with custom values still allowed.
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

  for (const f of otherFilters) {
    const key = (f.key ?? '').trim();
    const value = (f.value ?? '').trim();
    if (key === '' || value === '' || f.operator !== '=') {
      continue;
    }
    // Never let a filter overwrite the two reserved parameters, or the lookup silently
    // asks about a different table or column than the row displays.
    if (key === 'table' || key === 'column') {
      continue;
    }
    // A second row on the same column would constrain the lookup with the very value
    // being chosen, leaving one option or none.
    if (key === column) {
      continue;
    }
    if (!partitionColumns.includes(key)) {
      continue;
    }
    params[key] = value;
  }

  return params;
}
