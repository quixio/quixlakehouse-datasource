/**
 * Dashboard-variable query parsing.
 *
 * A variable query names a partition column whose values should populate a
 * dropdown, e.g.
 *
 *   partition_values(rawdata, rotorID)
 *   partition_values(car_telemetry, driver_acronym, year=2023, circuit=Monza)
 *
 * The trailing key=value pairs are equality filters on ANCESTOR partition columns,
 * matching the API's own convention. They matter: without them you get every value
 * the table has ever held rather than the ones present in the period on screen, and
 * they are what makes chained variables ($year -> $circuit -> $driver) work.
 *
 * Why partition columns specifically, rather than SELECT DISTINCT on anything:
 * partition values are directory names already held in the catalog manifest, so
 * they come back in well under a second. The equivalent SQL opens every file in the
 * table and does not complete -- see the comment block in pkg/plugin/catalog.go.
 */

/** A parsed variable query. */
export interface PartitionValuesQuery {
  kind: 'partition_values';
  table: string;
  column: string;
  /** Ancestor partition filters, e.g. { year: '2023' }. */
  filters: Record<string, string>;
}

export type ParsedVariableQuery = PartitionValuesQuery;

export class VariableQueryError extends Error {}

const FN = 'partition_values';

/**
 * Parses a variable query string.
 *
 * Throws VariableQueryError with an actionable message rather than returning null:
 * a dashboard variable that silently yields nothing is markedly harder to debug
 * than one that says why.
 */
export function parseVariableQuery(raw: string): ParsedVariableQuery {
  const text = (raw ?? '').trim();
  if (text === '') {
    throw new VariableQueryError(`empty variable query; expected ${FN}(table, column)`);
  }

  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) {
    throw new VariableQueryError(`could not parse "${text}"; expected ${FN}(table, column)`);
  }

  const fn = text.slice(0, open).trim().toLowerCase();
  if (fn !== FN) {
    throw new VariableQueryError(`unknown variable query "${fn}"; only ${FN}(table, column) is supported`);
  }

  const args = text
    .slice(open + 1, close)
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');

  if (args.length < 2) {
    throw new VariableQueryError(`${FN} needs at least a table and a column, got ${args.length} argument(s)`);
  }

  const [table, column, ...rest] = args;
  if (table.includes('=') || column.includes('=')) {
    throw new VariableQueryError(`the first two arguments to ${FN} are positional (table, column), not key=value`);
  }

  const filters: Record<string, string> = {};
  for (const pair of rest) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new VariableQueryError(`filter "${pair}" must be key=value`);
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key === '' || value === '') {
      throw new VariableQueryError(`filter "${pair}" must be key=value`);
    }
    filters[key] = stripQuotes(value);
  }

  return { kind: 'partition_values', table: stripQuotes(table), column: stripQuotes(column), filters };
}

/**
 * Removes one matching pair of surrounding quotes.
 *
 * Users copy values out of SQL, where they are quoted, but these go into a URL query
 * parameter where a literal quote would be part of the value and match nothing.
 */
function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}
