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
}

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
  rawSql: DEFAULT_SQL,
  format: 'time_series',
  // Matches the `AS time` alias above. Set explicitly rather than relying on the
  // backend's name heuristic: leaving it empty yields a plain number field and a
  // panel that will not plot, with nothing on screen explaining why.
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
