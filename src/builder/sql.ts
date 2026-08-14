import { BuilderCondition, BuilderGroup, BuilderNode, BuilderState, QueryFormat } from '../types';
import { isFilled, whereTree } from './where';

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
    selects.push(`$__timeGroup(${expr(timeColumn)}, ${interval}) AS time`);
  } else if (timeColumn !== '' && format === 'time_series') {
    // A time series needs a time field; without bucketing, pass the column through.
    selects.push(`${expr(timeColumn)} AS time`);
  }

  // Split-by columns are dimensions, and a dimension has to be a FIELD in the frame,
  // not merely a grouping key. Grouping without selecting is valid SQL, so nothing
  // failed -- but the frame came back with only time and value, several rows sharing
  // each timestamp and nothing to tell them apart. Grafana cannot split that into
  // series, so it drew one line zig-zagging between the groups, with no per-series
  // legend or colour (sc-74547).
  //
  // Emitted before the value columns so the frame reads time, dimension, value, which
  // is the shape Grafana expects when deriving series names.
  const splitColumns: string[] = [];
  for (const g of state.groupByColumns) {
    const col = (g ?? '').trim();
    if (col === '') {
      continue;
    }
    // Skip anything already chosen as a select field, or it would appear twice.
    const alreadySelected = state.select.some((s) => (s.column ?? '').trim() === col);
    if (!alreadySelected) {
      splitColumns.push(col);
      selects.push(expr(col));
    }
  }

  let valueColumns = 0;
  for (const s of state.select) {
    const col = (s.column ?? '').trim();
    if (col === '') {
      continue;
    }
    valueColumns++;
    if (s.aggregate === 'none') {
      selects.push(expr(col));
    } else {
      // Alias to the bare column name so the series legend reads "speed", not
      // "avg(speed)", matching what the InfluxQL editor produces.
      selects.push(`${s.aggregate}(${expr(col)}) AS ${ident(aliasFor(col))}`);
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
    wheres.push(`$__timeFilter(${expr(timeColumn)})`);
  }
  const root = whereTree(state);
  if (root.conjunction === 'AND') {
    // Flat AND reads best one condition per line, which is also what this generator
    // emitted before groups existed.
    for (const child of root.children) {
      const sql = renderNode(child);
      if (sql !== '') {
        wheres.push(sql);
      }
    }
  } else {
    // An OR root must be bracketed as soon as anything else is ANDed with it, and
    // $__timeFilter is exactly that: `$__timeFilter(t) AND a OR b` binds as
    // `($__timeFilter(t) AND a) OR b`, so the right-hand branch loses its time bound
    // and scans the whole table.
    const sql = renderGroup(root, wheres.length > 0);
    if (sql !== '') {
      wheres.push(sql);
    }
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
  // Any column selected raw must also be grouped, or DuckDB rejects the query:
  // "column must appear in the GROUP BY clause or be used in an aggregate function".
  // Choosing aggregate "none" while bucketing by time produced exactly that.
  // Grouping it is the honest reading of what was asked for; silently applying an
  // aggregate would change the result without saying so.
  if (bucketing) {
    for (const s of state.select) {
      const col = (s.column ?? '').trim();
      if (col !== '' && s.aggregate === 'none') {
        groups.push(expr(col));
      }
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

function renderCondition(condition: BuilderCondition): string {
  if (!isFilled(condition)) {
    return '';
  }
  return `${ident(condition.key.trim())} ${condition.operator} ${literal(condition.value.trim())}`;
}

function renderNode(node: BuilderNode): string {
  return node.kind === 'condition' ? renderCondition(node.condition) : renderGroup(node.group, true);
}

/**
 * SQL for one group, bracketed when it needs to be.
 *
 * `wrap` asks for brackets; they are still omitted when there is nothing to disambiguate.
 * A group with one effective child is just that child, and `(x = 1)` adds noise to
 * generated SQL that people read and edit. Empty conditions and empty groups render as
 * '' and drop out, so a half-filled row never produces `a =  AND b = 1`.
 */
function renderGroup(group: BuilderGroup, wrap: boolean): string {
  const parts = group.children.map(renderNode).filter((p) => p !== '');
  if (parts.length === 0) {
    return '';
  }
  if (parts.length === 1) {
    return parts[0];
  }
  const joined = parts.join(` ${group.conjunction} `);
  return wrap ? `(${joined})` : joined;
}

/**
 * Alias for an aggregated select item.
 *
 * A plain column aliases to itself, so the legend reads "speed" rather than
 * "avg(speed)". An expression cannot: `avg(value * 100) AS "value * 100"` is legal but
 * makes a wretched series name, so the first identifier in it is used instead.
 */
function aliasFor(col: string): string {
  const v = col.trim();
  if (/^[a-z_][a-z0-9_]*$/i.test(v)) {
    return v;
  }
  const firstIdent = v.match(/[a-z_][a-z0-9_]*/i);
  return firstIdent ? firstIdent[0] : 'value';
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

/**
 * Anything that looks like a SQL expression rather than a column name is passed
 * through untouched; a plain name is quoted as an identifier.
 *
 * This exists because a timestamp is not always one column. In `can_signals`, `ts_ms`
 * is the segment start and is constant for every row in that segment, while `t_rel`
 * is the offset within it -- the actual instant is
 * `ts_ms + CAST(t_rel * 1000 AS BIGINT)`. Without this, ident() would see the spaces
 * and parentheses, decide the whole thing was an awkward column name, and emit
 * `"ts_ms + CAST(t_rel * 1000 AS BIGINT)"` -- a quoted identifier that does not exist.
 *
 * No new injection surface: the Code editor already accepts arbitrary SQL from the
 * same user.
 */
export function expr(value: string): string {
  const v = value.trim();
  if (/^[a-z_][a-z0-9_]*$/i.test(v)) {
    return ident(v);
  }
  // Contains operators, calls, or quoting -- the user means it as SQL.
  if (/[^a-z0-9_]/i.test(v)) {
    return v;
  }
  return ident(v);
}

/** Single-quoted string literal with quote escaping. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
