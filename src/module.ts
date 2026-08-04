import { DataSourcePlugin } from '@grafana/data';

import { ConfigEditor } from './components/ConfigEditor';
import { QueryEditor } from './components/QueryEditor';
import { DataSource } from './datasource';
import { QuixLakeDataSourceOptions, QuixLakeQuery } from './types';

export const plugin = new DataSourcePlugin<DataSource, QuixLakeQuery, QuixLakeDataSourceOptions>(DataSource)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
