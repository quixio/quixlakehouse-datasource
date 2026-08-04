import { QueryEditorProps, SelectableValue } from '@grafana/data';
import { InlineField, Input, Select, TextArea } from '@grafana/ui';
import React, { ChangeEvent } from 'react';

import { DataSource } from '../datasource';
import { QueryFormat, QuixLakeDataSourceOptions, QuixLakeQuery, TimeFormat } from '../types';

type Props = QueryEditorProps<DataSource, QuixLakeQuery, QuixLakeDataSourceOptions>;

const LABEL_WIDTH = 16;

const FORMAT_OPTIONS: Array<SelectableValue<QueryFormat>> = [
  { label: 'Time series', value: 'time_series' },
  { label: 'Table', value: 'table' },
];

const TIME_FORMAT_OPTIONS: Array<SelectableValue<TimeFormat>> = [
  { label: 'Epoch milliseconds', value: 'epoch_ms' },
  { label: 'Epoch seconds', value: 'epoch_s' },
  { label: 'Epoch microseconds', value: 'epoch_us' },
  { label: 'Epoch nanoseconds', value: 'epoch_ns' },
  { label: 'Native TIMESTAMP', value: 'timestamp' },
];

/**
 * Raw-SQL query editor.
 *
 * Spike scope: a plain textarea -- no Monaco, no autocomplete, no Builder/Raw
 * toggle. Unstyled on purpose; FrontEndEsthetic owns visual design.
 *
 * "Time format" is not cosmetic. QuixLake tables usually store time as an INT64
 * epoch value (test_telemetry.timestamp is epoch milliseconds), and the backend
 * needs to know that both to expand $__timeFilter into an integer comparison rather
 * than a string one, and to convert the column into a real Grafana time field.
 */
export function QueryEditor({ query, onChange, onRunQuery }: Props) {
  const onRawSqlChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange({ ...query, rawSql: event.target.value });
  };

  const onTimeColumnChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, timeColumn: event.target.value });
  };

  const onFormatChange = (selected: SelectableValue<QueryFormat>) => {
    onChange({ ...query, format: selected.value ?? 'time_series' });
    onRunQuery();
  };

  const onTimeFormatChange = (selected: SelectableValue<TimeFormat>) => {
    onChange({ ...query, timeFormat: selected.value ?? 'epoch_ms' });
    onRunQuery();
  };

  return (
    <>
      <InlineField
        label="SQL"
        labelWidth={LABEL_WIDTH}
        grow
        interactive
        tooltip="DuckDB SQL. Macros: $__timeFilter(col), $__timeFrom(), $__timeTo(), $__timeGroup(col, 1m). Expanded in the backend, so they also work in alert rules."
      >
        <TextArea
          id="query-editor-raw-sql"
          rows={6}
          value={query.rawSql ?? ''}
          placeholder={
            'SELECT timestamp, speed_kmh FROM test_telemetry\nWHERE $__timeFilter(timestamp)\nORDER BY timestamp'
          }
          onChange={onRawSqlChange}
          onBlur={onRunQuery}
        />
      </InlineField>

      <InlineField
        label="Format"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Time series promotes a time column to the frame's time field."
      >
        <Select
          inputId="query-editor-format"
          options={FORMAT_OPTIONS}
          value={query.format ?? 'time_series'}
          onChange={onFormatChange}
          width={28}
        />
      </InlineField>

      <InlineField
        label="Time column"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Column to use as the time field. Leave empty to auto-detect a column named time/timestamp/ts/ts_ms/datetime/date/event_time."
      >
        <Input
          id="query-editor-time-column"
          value={query.timeColumn ?? ''}
          placeholder="timestamp (auto-detected if empty)"
          onChange={onTimeColumnChange}
          onBlur={onRunQuery}
          width={28}
        />
      </InlineField>

      <InlineField
        label="Time format"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="How the time column is stored. QuixLake time-series tables use epoch milliseconds."
      >
        <Select
          inputId="query-editor-time-format"
          options={TIME_FORMAT_OPTIONS}
          value={query.timeFormat ?? 'epoch_ms'}
          onChange={onTimeFormatChange}
          width={28}
        />
      </InlineField>
    </>
  );
}
