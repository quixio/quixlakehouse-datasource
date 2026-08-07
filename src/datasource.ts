import { CoreApp, DataSourceInstanceSettings, MetricFindValue, ScopedVars } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';

import { DEFAULT_QUERY, QuixLakeDataSourceOptions, QuixLakeQuery } from './types';
import { parseVariableQuery } from './variables';

/**
 * Matches the <angle_bracketed> placeholders in DEFAULT_SQL. Angle brackets are not
 * valid DuckDB identifier syntax, so this cannot collide with real SQL.
 */
const UNEDITED_PLACEHOLDER = /<[a-z_]+>/i;

/**
 * DataSourceWithBackend routes every query through Grafana's server-side
 * /api/ds/query path into the Go backend. That is the whole point: the same code
 * path serves dashboards, Explore, and alert rule evaluation.
 */
export class DataSource extends DataSourceWithBackend<QuixLakeQuery, QuixLakeDataSourceOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<QuixLakeDataSourceOptions>) {
    super(instanceSettings);
  }

  getDefaultQuery(_: CoreApp): Partial<QuixLakeQuery> {
    return DEFAULT_QUERY;
  }

  /**
   * Expands dashboard template variables in the SQL before it leaves the browser.
   *
   * Note this only runs for dashboard/Explore queries. Alert rules have no
   * frontend, so nothing here executes for them -- which is exactly why the time
   * macros ($__timeFilter and friends) are implemented in the Go backend instead
   * of here.
   */
  applyTemplateVariables(query: QuixLakeQuery, scopedVars: ScopedVars): QuixLakeQuery {
    return {
      ...query,
      rawSql: query.rawSql ? getTemplateSrv().replace(query.rawSql, scopedVars) : query.rawSql,
    };
  }

  /**
   * Decides whether a target is worth sending.
   *
   * Skips empty SQL so a half-typed panel does not spam the lakehouse, and skips the
   * starter query while it still contains <angle_bracketed> placeholders. Without
   * that second check, DEFAULT_QUERY would fire on every newly created panel and
   * fail with "<table> does not exist" before the user has typed anything -- a red
   * banner as the first thing they see.
   */
  filterQuery(query: QuixLakeQuery): boolean {
    const sql = query.rawSql?.trim();
    if (!sql) {
      return false;
    }
    return !UNEDITED_PLACEHOLDER.test(sql);
  }

  /**
   * Populates a dashboard variable from partition metadata.
   *
   *   partition_values(rawdata, rotorID)
   *   partition_values(car_telemetry, driver_acronym, year=$year)
   *
   * Goes through the backend resource handler rather than fetching directly: the API
   * token is in secureJsonData and is never sent to the browser, so the frontend has
   * no way to authenticate against the lakehouse itself.
   *
   * Deliberately NOT implemented as a SELECT DISTINCT. Partition values are directory
   * names in the catalog manifest; the SQL equivalent opens every file in the table
   * and is killed by the ingress before it returns.
   */
  async metricFindQuery(query: string, options?: { scopedVars?: ScopedVars }): Promise<MetricFindValue[]> {
    // Interpolate first, so filters can reference other variables and chain
    // ($year -> $circuit -> $driver).
    const interpolated = getTemplateSrv().replace(query, options?.scopedVars);
    const parsed = parseVariableQuery(interpolated);

    const params: Record<string, string> = {
      table: parsed.table,
      column: parsed.column,
      ...parsed.filters,
    };

    const res = await this.getResource('partition-values', params);
    const values: string[] = res?.values ?? [];
    return values.map((v) => ({ text: v, value: v }));
  }
}
