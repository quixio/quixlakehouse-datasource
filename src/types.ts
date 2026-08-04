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

export const DEFAULT_QUERY: Partial<QuixLakeQuery> = {
  rawSql: '',
  format: 'time_series',
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
