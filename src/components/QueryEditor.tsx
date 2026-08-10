import { QueryEditorProps, SelectableValue } from '@grafana/data';
import { Alert, Button, InlineField, Input, RadioButtonGroup, Select, Stack, TextArea } from '@grafana/ui';
import React, { ChangeEvent, useState } from 'react';

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
  TimeMode,
} from '../types';
import { QueryBuilder } from './QueryBuilder';

type Props = QueryEditorProps<DataSource, QuixLakeQuery, QuixLakeDataSourceOptions>;

/**
 * How many of the column's units make up one millisecond.
 *
 * null for a native TIMESTAMP, which has no integer unit to scale -- the origin is
 * ignored there rather than converted into nonsense.
 */
function unitsPerMillisecond(format: TimeFormat): number | null {
  switch (format) {
    case 'epoch_s':
      return 1 / 1000;
    case 'epoch_ms':
      return 1;
    case 'epoch_us':
      return 1000;
    case 'epoch_ns':
      return 1_000_000;
    default:
      return null;
  }
}

// Must match QueryBuilder's LABEL_WIDTH so the Format / Time column / Time format
// rows below the builder share one label gutter. See the note there for why 18.
const LABEL_WIDTH = 18;

const EDITOR_MODES: Array<SelectableValue<EditorMode>> = [
  { label: 'Builder', value: 'builder' },
  { label: 'Code', value: 'code' },
];

const FORMAT_OPTIONS: Array<SelectableValue<QueryFormat>> = [
  { label: 'Time series', value: 'time_series' },
  { label: 'Table', value: 'table' },
];

const TIME_MODE_OPTIONS: Array<SelectableValue<TimeMode>> = [
  { label: 'Absolute', value: 'absolute' },
  { label: 'Relative to start', value: 'relative' },
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

  /**
   * Changing the epoch unit rescales the origin.
   *
   * The origin is stored in the time column's own units, because that is what the
   * backend subtracts from the stored value and adds to the range bounds. Leaving the
   * number alone when the unit changes silently reinterprets it: an origin detected as
   * 1785925833288 ms, read as seconds, is about 56,000 years out and the panel goes
   * blank with nothing on screen explaining why.
   */
  const onTimeFormatChange = (selected: SelectableValue<TimeFormat>) => {
    const nextFormat = selected.value ?? 'epoch_ms';
    const patch: Partial<QuixLakeQuery> = { timeFormat: nextFormat };

    const origin = query.timeOrigin;
    const prevFormat = query.timeFormat ?? 'epoch_ms';
    if (typeof origin === 'number' && origin !== 0 && prevFormat !== nextFormat) {
      const perMs = unitsPerMillisecond(prevFormat);
      const nextPerMs = unitsPerMillisecond(nextFormat);
      // Both null means one of them is a native TIMESTAMP, where the origin has no
      // integer meaning; leave the value untouched rather than invent a conversion.
      if (perMs !== null && nextPerMs !== null) {
        patch.timeOrigin = Math.round((origin / perMs) * nextPerMs);
      }
    }

    onChange({ ...query, ...patch });
    onRunQuery();
  };

  /**
   * Switching to relative anchors the run at now straight away.
   *
   * Doing it on the switch rather than making the user find a button is the whole
   * point: relative mode is otherwise useless on arrival, because the data has not
   * moved yet and the dashboard range has not either, so the panel just empties.
   * Anchoring the last sample on the current clock means an ordinary "Last 6 hours"
   * shows the run immediately.
   *
   * Both fields are written in one update. Setting the mode and then the origin in a
   * second onChange would race: the first write is still in flight while the async
   * lookup resolves, and the later one clobbers it.
   */
  const onTimeModeChange = async (selected: SelectableValue<TimeMode>) => {
    const next = selected.value ?? 'absolute';
    if (next !== 'relative') {
      onChange({ ...query, timeMode: next });
      onRunQuery();
      return;
    }

    const table = (builder.table ?? '').trim();
    const timeExpr = (builder.timeColumn ?? '').trim();
    if (!table || !timeExpr) {
      // Code mode, or an unfinished builder: no way to find the run's extent without
      // parsing SQL, so switch the mode and leave the origin to Detect or the field.
      onChange({ ...query, timeMode: next });
      onRunQuery();
      return;
    }

    setDetecting(true);
    try {
      const params: Record<string, string> = { table, expr: timeExpr };
      for (const f of builder.filters) {
        if (f.key && f.value) {
          params[f.key] = f.value;
        }
      }
      const res = await datasource.getResource('time-origin', params);
      const patch: Partial<QuixLakeQuery> = { timeMode: next };
      if (typeof res?.max === 'number') {
        patch.timeOrigin = res.max - nowInColumnUnits();
      }
      onChange({ ...query, ...patch });
    } catch (_e) {
      onChange({ ...query, timeMode: next });
    } finally {
      setDetecting(false);
      onRunQuery();
    }
  };

  const [detecting, setDetecting] = useState(false);

  /**
   * The current clock in the time column's own units.
   *
   * Getting this wrong is not subtle: an epoch-seconds column given a millisecond
   * value lands roughly 55,000 years out.
   */
  const nowInColumnUnits = (): number => {
    const perMs = unitsPerMillisecond(query.timeFormat ?? 'epoch_ms');
    return Math.round(Date.now() * (perMs ?? 1));
  };

  /**
   * Shifts the run so its LAST sample sits on the current clock.
   *
   * displayed = stored - origin, so origin = max - now puts max at now and the first
   * sample at now - (max - min). The run then falls just behind the present and shows
   * up in an ordinary "Last 6 hours" dashboard with no 1970 range to set up.
   *
   * Anchoring min instead would put the whole recording in the future, past the right
   * edge of every now-relative range -- which is why this needs max, and why it asks
   * the backend rather than using the clock alone.
   */
  const anchorRunAtNow = async () => {
    const table = (builder.table ?? '').trim();
    const timeExpr = (builder.timeColumn ?? '').trim();
    if (!table || !timeExpr) {
      return;
    }
    setDetecting(true);
    try {
      const params: Record<string, string> = { table, expr: timeExpr };
      for (const f of builder.filters) {
        if (f.key && f.value) {
          params[f.key] = f.value;
        }
      }
      const res = await datasource.getResource('time-origin', params);
      if (typeof res?.max === 'number') {
        onChange({ ...query, timeOrigin: res.max - nowInColumnUnits() });
        onRunQuery();
      }
    } finally {
      setDetecting(false);
    }
  };

  /**
   * Fills the origin from min() over the table.
   *
   * Only possible in builder mode: it needs the table and the time expression, and
   * raw SQL would have to be parsed to recover them. In Code mode the field is typed
   * in by hand.
   */
  const detectOrigin = async () => {
    const table = (builder.table ?? '').trim();
    const timeExpr = (builder.timeColumn ?? '').trim();
    if (!table || !timeExpr) {
      return;
    }
    setDetecting(true);
    try {
      const params: Record<string, string> = { table, expr: timeExpr };
      for (const f of builder.filters) {
        if (f.key && f.value) {
          params[f.key] = f.value;
        }
      }
      const res = await datasource.getResource('time-origin', params);
      if (typeof res?.origin === 'number') {
        onChange({ ...query, timeOrigin: res.origin });
        onRunQuery();
      }
    } finally {
      setDetecting(false);
    }
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

      <InlineField
        label="Time mode"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Absolute plots wall-clock time. Relative rebases so the run starts at zero, for recordings where the absolute date carries no meaning. Relative works by moving the data to the epoch -- Grafana has no duration axis -- so set the dashboard timezone to UTC and its range in elapsed terms, e.g. 1970-01-01 00:00:00 to 00:02:00. Zoom still works. Do not use it for alert rules: the data claims to be from 1970."
      >
        <Select
          inputId="query-editor-time-mode"
          options={TIME_MODE_OPTIONS}
          value={query.timeMode ?? 'absolute'}
          onChange={onTimeModeChange}
          width={28}
        />
      </InlineField>

      {(query.timeMode ?? 'absolute') === 'relative' && (
        <Alert severity="info" title="Relative mode shifts the data, so the dashboard range must match">
          Two anchors, and they need different ranges. <strong>Detect</strong> puts zero at the start of the run, and
          zero is the Unix epoch — so set the timezone to <strong>UTC</strong> and an absolute range from{' '}
          <strong>1970-01-01 00:00:00</strong>. <strong>End at now</strong> instead lands the last sample on the
          current clock, so an ordinary <strong>Last 6 hours</strong> works with no setup. Until the range matches the
          anchor the panel is empty, because the data has moved outside the visible window. Either way, do not put an
          alert rule on a relative panel — the timestamps are fabricated.
        </Alert>
      )}

      {(query.timeMode ?? 'absolute') === 'relative' && (
        <InlineField
          label="Zero at"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="The instant that becomes zero, in the time column's own units. Detect anchors zero at the start of the run, which needs a dashboard range beginning at 1970-01-01. End at now shifts the run so its last sample is the current time instead, so it shows in an ordinary Last 6 hours range. Both ignore the dashboard range when reading the data -- an origin that moved with the filter would make the window always restart at zero and zoom look broken."
        >
          <Stack direction="row" gap={0.5} alignItems="center">
            <Input
              id="query-editor-time-origin"
              type="number"
              value={query.timeOrigin ?? ''}
              placeholder="e.g. 1785925833288"
              width={28}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onChange({ ...query, timeOrigin: Number(e.target.value) || undefined })
              }
              onBlur={onRunQuery}
            />
            <Button variant="secondary" size="sm" disabled={detecting} onClick={detectOrigin}>
              {detecting ? 'Detecting…' : 'Detect'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={detecting}
              onClick={anchorRunAtNow}
              title="Shift the run so its last sample is now, making it visible in a Last 6 hours dashboard"
            >
              End at now
            </Button>
          </Stack>
        </InlineField>
      )}
    </Stack>
  );
}
