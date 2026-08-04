import { CoreApp, DataSourceInstanceSettings, ScopedVars } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';

import { DEFAULT_QUERY, QuixLakeDataSourceOptions, QuixLakeQuery } from './types';

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

  /** Skip empty targets so a half-typed panel does not spam the lakehouse. */
  filterQuery(query: QuixLakeQuery): boolean {
    return !!query.rawSql && query.rawSql.trim() !== '';
  }
}
