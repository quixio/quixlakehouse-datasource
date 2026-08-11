import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

/** How a time column is physically stored in the lakehouse. Must stay in sync with
 *  TimeFormat in pkg/plugin/timefmt.go. */
export type TimeFormat = 'epoch_ms' | 'epoch_s' | 'epoch_us' | 'epoch_ns' | 'timestamp';

/** Output shape. 'time_series' promotes a time column to the frame's time field. */
export type QueryFormat = 'time_series' | 'table';

/**
 * One panel target. Raw SQL only in this spike -- the visual builder is a later
 * phase. Field names must match the `json:` tags on queryModel in
 * pkg/plugin/datasource.go.
 *
 * intervalMs / maxDataPoints / the time range are supplied by Grafana on the
 * backend DataQuery and are deliberately absent here.
 */
export interface QuixLakeQuery extends DataQuery {
  rawSql?: string;
  format?: QueryFormat;
  timeColumn?: string;
  timeFormat?: TimeFormat;
  /**
   * Absolute wall-clock time, or an axis rebased so the run starts at zero.
   *
   * Relative works by moving the data to the epoch, because a Grafana time field is
   * an offset from 1970 and there is no duration field type. The dashboard range is
   * then read as elapsed as well, so zoom keeps working.
   */
  timeMode?: TimeMode;
  /**
   * Offset the backend subtracts from the stored value, in the time column's units.
   *
   * DERIVED, not authored: the editor computes it from timeZeroAt and timeRunStart.
   * It is signed and its sign depends on which anchor produced it, which makes it a
   * poor thing to put in front of a user -- hence the two fields below.
   *
   * Stored in the panel rather than recomputed per request on purpose: an offset
   * derived from the filtered rows moves on every zoom, so the window would always
   * restart at zero and dragging would appear to do nothing.
   */
  timeOrigin?: number;
  /**
   * Wall-clock instant, epoch milliseconds, where the START of the run is placed.
   *
   * This is what the user sees and edits. Always a positive unix time: 0 means the
   * run starts at 1970-01-01 (a pure elapsed axis), and `now - duration` means it ends
   * at the present. Expressing it this way avoids the signed offset, which is negative
   * for one anchor and positive for the other and explains nothing at a glance.
   */
  timeZeroAt?: number;
  /**
   * min() of the time column, in the column's units, from the last lookup.
   *
   * Needed to turn timeZeroAt into timeOrigin: the data has to be normalised to
   * zero-based before it can be placed anywhere. Kept in the panel so a saved
   * dashboard does not have to re-query on load.
   */
  timeRunStart?: number;
  /** Which editor is showing. The backend never reads this. */
  editorMode?: EditorMode;
  /** Builder state. Kept alongside rawSql, not instead of it -- see below. */
  builder?: BuilderState;
}

export type EditorMode = 'builder' | 'code';

/** Must stay in sync with TimeMode in pkg/plugin/datasource.go. */
export type TimeMode = 'absolute' | 'relative';

/** Aggregates offered in the SELECT row. 'none' selects the raw column. */
export type AggregateFn = 'none' | 'avg' | 'min' | 'max' | 'sum' | 'count';

export type FilterOperator = '=' | '!=' | '>' | '<' | '>=' | '<=';

export interface BuilderSelect {
  column: string;
  aggregate: AggregateFn;
}

export interface BuilderFilter {
  key: string;
  operator: FilterOperator;
  value: string;
}

/**
 * Visual builder state.
 *
 * IMPORTANT: the builder does not introduce a second query path. It generates
 * `rawSql`, which is the only thing the backend ever executes. That keeps alert
 * rules working -- an alert stores the generated SQL and evaluates it with no
 * frontend in the loop, so a builder-only representation would simply not run there.
 */
export interface BuilderState {
  table?: string;
  timeColumn?: string;
  select: BuilderSelect[];
  filters: BuilderFilter[];
  /** Emit GROUP BY $__timeGroup(timeColumn, interval), so buckets follow zoom. */
  groupByTime: boolean;
  /** Bucket width. $__interval means "whatever the panel is showing". */
  interval: string;
  /** Extra GROUP BY columns, e.g. a tag to split series by. */
  groupByColumns: string[];
  orderDescending: boolean;
  /** Rows cap. Undefined or 0 emits no LIMIT clause at all. */
  limit?: number;
}

export const DEFAULT_BUILDER: BuilderState = {
  select: [{ column: '', aggregate: 'avg' }],
  filters: [],
  groupByTime: true,
  interval: '$__interval',
  groupByColumns: [],
  orderDescending: false,
  // No default limit. A default truncates silently: a 60-second recording looked one
  // second long in testing because LIMIT 1000 was the whole panel and nothing said so.
  // An empty field means unlimited (sc-74547).
  limit: undefined,
};

/**
 * Starter query for a new panel.
 *
 * Every line of this is defensive, because the default is what most users edit
 * rather than replace:
 *
 *  - `$__timeGroup(<time_column>, $__interval)` buckets by the panel's own interval,
 *    so the row count stays roughly constant as you zoom instead of growing with the
 *    range. Expanded backend-side, so it behaves identically in an alert rule.
 *  - `$__timeFilter(...)` bounds the scan to the dashboard time range. Without it the
 *    query reads the whole table.
 *  - The `year = ...` partition predicate is the one that actually matters here:
 *    unpartitioned scans are the dominant failure mode against this lakehouse and are
 *    killed by the ingress, not by our timeout.
 *  - `LIMIT` caps the worst case even when the above are edited away.
 *
 * Placeholders are angle-bracketed so the query fails with an obvious "does not
 * exist" naming the thing to change, rather than looking plausible and silently
 * scanning something real.
 */
export const DEFAULT_SQL = `SELECT
  $__timeGroup(<time_column>, $__interval) AS time,
  avg(<value_column>) AS value
FROM <table>
WHERE $__timeFilter(<time_column>)
  AND year = '2026'
GROUP BY 1
ORDER BY 1
LIMIT 1000`;

export const DEFAULT_QUERY: Partial<QuixLakeQuery> = {
  // Open in the builder. rawSql stays EMPTY here on purpose: the builder generates
  // it, and seeding a template would both fight the builder and make the editor
  // open in Code mode, since a non-empty rawSql is what selects that view.
  //
  // The "safe default" still holds -- it just lives in DEFAULT_BUILDER now, which
  // starts with time bucketing on at $__interval and LIMIT 1000, so the first query
  // anyone generates is bounded and scales with zoom. DEFAULT_SQL remains the
  // placeholder shown in Code mode.
  editorMode: 'builder',
  builder: DEFAULT_BUILDER,
  rawSql: '',
  format: 'time_series',
  // Matches the `AS time` alias the builder emits. Set explicitly rather than
  // relying on the backend's name heuristic: leaving it empty yields a plain number
  // field and a panel that will not plot, with nothing on screen explaining why.
  timeColumn: 'time',
  timeFormat: 'epoch_ms',
};

/**
 * Non-secret datasource settings (Grafana jsonData). Mirrors PluginSettings in
 * pkg/models/settings.go.
 *
 * The API base URL is deliberately NOT here -- it lives in Grafana's standard `url`
 * field on the datasource, which is what gives the backend TLS options, proxy
 * support and the standard HTTP middleware chain for free.
 */
export interface QuixLakeDataSourceOptions extends DataSourceJsonData {
  /** Maps to ?union_by_name=true on POST /query. Defaults to true. */
  unionByName?: boolean;
  timeoutSeconds?: number;
}

/**
 * Encrypted settings (Grafana secureJsonData). Grafana stores these encrypted and
 * decrypts them only for the backend process -- the browser never receives the
 * token back, which is the security win over a frontend-only datasource.
 */
export interface QuixLakeSecureJsonData {
  token?: string;
}
