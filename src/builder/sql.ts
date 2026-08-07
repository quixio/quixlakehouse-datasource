import { BuilderState, QueryFormat } from '../types';

/**
 * Turns builder state into DuckDB SQL.
 *
 * Pure and separate from the React components on purpose: this is where the logic
 * risk lives, so it is the part worth unit-testing. The components only collect
 * values.
 *
 * Two properties the generated SQL must always have, because they are the
 * difference between a query that works and one the ingress kills:
 *
 *  1. `$__timeFilter(...)` whenever a time column is known, so the scan is bounded
 *     by the dashboard range instead of the whole table.
 *  2. `LIMIT`, always, as the backstop when everything else has been edited away.
 *
 * `$__timeGroup(col, $__interval)` is what makes the row count follow zoom rather
 * than range. Both macros expand backend-side, so the same SQL behaves identically
 * in an alert rule, which has no frontend to interpolate anything.
 */
export function buildSQL(state: BuilderState, format: QueryFormat = 'time_series'): string {
  const table = (state.table ?? '').trim();
  if (table === '') {
    // Nothing sensible to generate yet. Returning '' rather than a broken query
    // means filterQuery skips it and the panel stays quiet while you fill the form.
    return '';
  }

  const timeColumn = (state.timeColumn ?? '').trim();
  const bucketing = state.groupByTime && timeColumn !== '';

  const selects: string[] = [];
  if (bucketing) {
    const interval = (state.interval ?? '$__interval').trim() || '$__interval';
    selects.push(`$__timeGroup(${ident(timeColumn)}, ${interval}) AS time`);
  } else if (timeColumn !== '' && format === 'time_series') {
    // A time series needs a time field; without bucketing, pass the column through.
    selects.push(`${ident(timeColumn)} AS time`);
  }

  let valueColumns = 0;
  for (const s of state.select) {
    const col = (s.column ?? '').trim();
    if (col === '') {
      continue;
    }
    valueColumns++;
    if (s.aggregate === 'none') {
      selects.push(ident(col));
    } else {
      // Alias to the bare column name so the series legend reads "speed", not
      // "avg(speed)", matching what the InfluxQL editor produces.
      selects.push(`${s.aggregate}(${ident(col)}) AS ${ident(col)}`);
    }
  }

  // Count value columns, not select entries. With bucketing on, `selects` already
  // holds the time expression, so checking selects.length would happily emit a
  // time-only query -- a real lakehouse hit that can return nothing useful.
  if (valueColumns === 0) {
    return '';
  }

  const wheres: string[] = [];
  if (timeColumn !== '') {
    wheres.push(`$__timeFilter(${ident(timeColumn)})`);
  }
  for (const f of state.filters) {
    const key = (f.key ?? '').trim();
    const value = (f.value ?? '').trim();
    if (key === '' || value === '') {
      continue;
    }
    wheres.push(`${ident(key)} ${f.operator} ${literal(value)}`);
  }

  // GROUP BY 1 refers to the first select item -- the bucket expression. Repeating
  // a macro call in GROUP BY would expand it twice and risk the two copies
  // disagreeing if the interval is recomputed.
  const groups: string[] = [];
  if (bucketing) {
    groups.push('1');
  }
  for (const g of state.groupByColumns) {
    const col = (g ?? '').trim();
    if (col !== '') {
      groups.push(ident(col));
    }
  }
  // An aggregate with no GROUP BY collapses everything to one row, which is almost
  // never what a panel wants; only group when there is a bucket or explicit column.
  const grouping = groups.length > 0 && (bucketing || hasAggregate(state));

  const lines = [`SELECT`, indent(selects.join(',\n')), `FROM ${ident(table)}`];
  if (wheres.length > 0) {
    lines.push(`WHERE ${wheres.join('\n  AND ')}`);
  }
  if (grouping) {
    lines.push(`GROUP BY ${groups.join(', ')}`);
  }
  if (selects.length > 0 && (bucketing || timeColumn !== '')) {
    lines.push(`ORDER BY 1${state.orderDescending ? ' DESC' : ''}`);
  }

  const limit = state.limit ?? 0;
  if (limit > 0) {
    lines.push(`LIMIT ${Math.floor(limit)}`);
  }

  return lines.join('\n');
}

function hasAggregate(state: BuilderState): boolean {
  return state.select.some((s) => s.aggregate !== 'none' && (s.column ?? '').trim() !== '');
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');
}

/**
 * Quotes an identifier only when it needs it.
 *
 * Left bare when it is a plain identifier, so the generated SQL stays readable and
 * looks like something a human would write. Quoted otherwise, because lakehouse
 * columns really do contain awkward names -- rawdata has `__index_level_0__` and
 * mixed-case `rotorID`, and DuckDB folds unquoted identifiers to lower case.
 */
export function ident(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quoted string literal with quote escaping. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
