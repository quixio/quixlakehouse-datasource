import { QueryEditorProps, SelectableValue } from '@grafana/data';
import { InlineField, Input, RadioButtonGroup, Select, Stack, TextArea } from '@grafana/ui';
import React, { ChangeEvent } from 'react';

import { buildSQL } from '../builder/sql';
import { DataSource } from '../datasource';
import {
  BuilderState,
  DEFAULT_BUILDER,
  DEFAULT_SQL,
  EditorMode,
  QueryFormat,
  QuixLakeDataSourceOptions,
  QuixLakeQuery,
  TimeFormat,
} from '../types';
import { QueryBuilder } from './QueryBuilder';

type Props = QueryEditorProps<DataSource, QuixLakeQuery, QuixLakeDataSourceOptions>;

const LABEL_WIDTH = 14;

const EDITOR_MODES: Array<SelectableValue<EditorMode>> = [
  { label: 'Builder', value: 'builder' },
  { label: 'Code', value: 'code' },
];

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
 * Query editor with a visual builder and a raw-SQL mode.
 *
 * The builder generates `rawSql`; the backend only ever executes that. Keeping one
 * query representation is what lets an alert rule evaluate a builder-authored query
 * with no frontend present.
 *
 * Builder -> Code is one-way, by design and stated in the UI. Parsing arbitrary
 * hand-edited DuckDB back into builder state is a real parser's job, and a partial
 * one would silently drop clauses it did not understand -- worse than refusing.
 * Grafana's own SQL editors make the same trade.
 *
 * "Time format" is not cosmetic: QuixLake stores time as an INT64 epoch, and the
 * backend needs to know that both to compare $__timeFilter against an integer rather
 * than a string, and to turn the column into a real Grafana time field.
 */
export function QueryEditor({ query, onChange, onRunQuery, datasource }: Props) {
  const mode: EditorMode = query.editorMode ?? (query.rawSql ? 'code' : 'builder');
  const builder: BuilderState = query.builder ?? DEFAULT_BUILDER;
  const format = query.format ?? 'time_series';

  const onModeChange = (next: EditorMode) => {
    if (next === 'code') {
      // Carry the generated SQL across so Code opens on what the builder produced,
      // rather than an empty box that discards the work.
      const generated = buildSQL(builder, format);
      onChange({ ...query, editorMode: next, rawSql: generated || query.rawSql });
      return;
    }
    onChange({ ...query, editorMode: next });
  };

  const onBuilderChange = (next: BuilderState) => {
    // Regenerate on every edit so rawSql is always the source of truth for execution.
    onChange({ ...query, builder: next, rawSql: buildSQL(next, format), editorMode: 'builder' });
  };

  const onRawSqlChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange({ ...query, rawSql: event.target.value });
  };

  const onTimeColumnChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, timeColumn: event.target.value });
  };

  const onFormatChange = (selected: SelectableValue<QueryFormat>) => {
    const nextFormat = selected.value ?? 'time_series';
    const patch: Partial<QuixLakeQuery> = { format: nextFormat };
    if (mode === 'builder') {
      patch.rawSql = buildSQL(builder, nextFormat);
    }
    onChange({ ...query, ...patch });
    onRunQuery();
  };

  const onTimeFormatChange = (selected: SelectableValue<TimeFormat>) => {
    onChange({ ...query, timeFormat: selected.value ?? 'epoch_ms' });
    onRunQuery();
  };

  return (
    <Stack direction="column" gap={0.5}>
      <Stack direction="row" justifyContent="flex-end">
        <RadioButtonGroup options={EDITOR_MODES} value={mode} size="sm" onChange={onModeChange} />
      </Stack>

      {mode === 'builder' ? (
        <QueryBuilder
          builder={builder}
          format={format}
          datasource={datasource}
          generatedSQL={buildSQL(builder, format)}
          onChange={onBuilderChange}
          onRunQuery={onRunQuery}
        />
      ) : (
        <InlineField
          label="SQL"
          labelWidth={LABEL_WIDTH}
          grow
          interactive
          tooltip="DuckDB SQL. Macros: $__timeFilter(col), $__timeFrom(), $__timeTo(), $__timeGroup(col, $__interval). Expanded in the backend, so they also work in alert rules."
        >
          <TextArea
            id="query-editor-raw-sql"
            rows={8}
            value={query.rawSql ?? ''}
            placeholder={DEFAULT_SQL}
            onChange={onRawSqlChange}
            onBlur={onRunQuery}
          />
        </InlineField>
      )}

      <InlineField
        label="Format"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Time series promotes a time column to the frame's time field."
      >
        <Select
          inputId="query-editor-format"
          options={FORMAT_OPTIONS}
          value={format}
          onChange={onFormatChange}
          width={28}
        />
      </InlineField>

      <InlineField
        label="Time column"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Column promoted to the frame's time field. Leave empty to auto-detect a column named time/timestamp/ts/ts_ms/datetime/date/event_time. Empty with no matching name yields a plain number, and the panel will not plot."
      >
        <Input
          id="query-editor-time-column"
          value={query.timeColumn ?? ''}
          placeholder="time (auto-detected if empty)"
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
    </Stack>
  );
}
