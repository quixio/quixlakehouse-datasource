import { SelectableValue } from '@grafana/data';
import { Button, IconButton, InlineField, InlineFieldRow, Input, Select, Stack, TextArea } from '@grafana/ui';
import React, { ChangeEvent, useCallback, useState } from 'react';

import { DataSource } from '../datasource';
import { AggregateFn, BuilderState, FilterOperator, QueryFormat } from '../types';

const LABEL_WIDTH = 14;

const AGGREGATE_OPTIONS: Array<SelectableValue<AggregateFn>> = [
  { label: 'mean', value: 'avg' },
  { label: 'min', value: 'min' },
  { label: 'max', value: 'max' },
  { label: 'sum', value: 'sum' },
  { label: 'count', value: 'count' },
  { label: 'none (raw)', value: 'none' },
];

const OPERATOR_OPTIONS: Array<SelectableValue<FilterOperator>> = ['=', '!=', '>', '<', '>=', '<='].map((o) => ({
  label: o,
  value: o as FilterOperator,
}));

const INTERVAL_OPTIONS: Array<SelectableValue<string>> = [
  { label: '$__interval (follows zoom)', value: '$__interval' },
  { label: '1s', value: '1s' },
  { label: '10s', value: '10s' },
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '1h', value: '1h' },
  { label: '1d', value: '1d' },
];

interface Props {
  builder: BuilderState;
  format: QueryFormat;
  datasource: DataSource;
  generatedSQL: string;
  onChange: (next: BuilderState) => void;
  onRunQuery: () => void;
}

/**
 * Visual query builder, modelled on Grafana's InfluxQL editor.
 *
 * The builder writes `rawSql` on every change (see QueryEditor) rather than
 * introducing a second query path. That is what keeps alert rules working: an alert
 * evaluates stored SQL with no browser in the loop, so a builder-only representation
 * would never run there.
 *
 * Two deliberate departures from the InfluxQL editor it imitates:
 *
 *  - No `fill()`. InfluxQL has it; DuckDB does not, and faking it needs a generated
 *    time spine joined to the result. A control that silently did nothing would be
 *    worse than its absence. Grafana's "Fill missing" transformation covers most of
 *    the need today.
 *  - WHERE values load from the catalog's partition metadata, not from a SELECT
 *    DISTINCT. That is the difference between a dropdown that fills in half a second
 *    and one that never returns.
 */
export function QueryBuilder({ builder, format, datasource, generatedSQL, onChange, onRunQuery }: Props) {
  const set = useCallback(
    (patch: Partial<BuilderState>) => {
      onChange({ ...builder, ...patch });
    },
    [builder, onChange]
  );

  return (
    <Stack direction="column" gap={0.5}>
      <InlineFieldRow>
        <InlineField
          label="FROM"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Lakehouse table name, e.g. rawdata or car_telemetry."
        >
          <Input
            value={builder.table ?? ''}
            placeholder="select table"
            width={30}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ table: e.target.value })}
            onBlur={onRunQuery}
          />
        </InlineField>
        <InlineField
          label="TIME COLUMN"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Column holding the timestamp. Drives $__timeFilter and the time bucket. Usually epoch milliseconds in this lakehouse."
        >
          <Input
            value={builder.timeColumn ?? ''}
            placeholder="ts_ms"
            width={24}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ timeColumn: e.target.value })}
            onBlur={onRunQuery}
          />
        </InlineField>
      </InlineFieldRow>

      {/* SELECT */}
      {builder.select.map((sel, i) => (
        <InlineFieldRow key={`sel-${i}`}>
          <InlineField label={i === 0 ? 'SELECT' : ''} labelWidth={LABEL_WIDTH}>
            <Input
              value={sel.column}
              placeholder="field"
              width={30}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const next = [...builder.select];
                next[i] = { ...next[i], column: e.target.value };
                set({ select: next });
              }}
              onBlur={onRunQuery}
            />
          </InlineField>
          <InlineField>
            <Select
              options={AGGREGATE_OPTIONS}
              value={sel.aggregate}
              width={20}
              onChange={(v) => {
                const next = [...builder.select];
                next[i] = { ...next[i], aggregate: v.value ?? 'avg' };
                set({ select: next });
                onRunQuery();
              }}
            />
          </InlineField>
          <IconButton
            name="times"
            aria-label="remove field"
            onClick={() => {
              const next = builder.select.filter((_, j) => j !== i);
              set({ select: next.length > 0 ? next : [{ column: '', aggregate: 'avg' }] });
              onRunQuery();
            }}
          />
          {i === builder.select.length - 1 && (
            <IconButton
              name="plus"
              aria-label="add field"
              onClick={() => set({ select: [...builder.select, { column: '', aggregate: 'avg' }] })}
            />
          )}
        </InlineFieldRow>
      ))}

      {/* WHERE */}
      {builder.filters.map((f, i) => (
        <FilterRow
          key={`f-${i}`}
          index={i}
          filter={f}
          table={builder.table ?? ''}
          datasource={datasource}
          onChange={(next) => {
            const copy = [...builder.filters];
            copy[i] = next;
            set({ filters: copy });
          }}
          onRemove={() => {
            set({ filters: builder.filters.filter((_, j) => j !== i) });
            onRunQuery();
          }}
          onRunQuery={onRunQuery}
        />
      ))}
      <InlineFieldRow>
        <InlineField
          label={builder.filters.length === 0 ? 'WHERE' : ''}
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Partition filters. Add at least one: an unpartitioned scan is the usual reason a query never returns."
        >
          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            onClick={() => set({ filters: [...builder.filters, { key: '', operator: '=', value: '' }] })}
          >
            Add filter
          </Button>
        </InlineField>
      </InlineFieldRow>

      {/* GROUP BY */}
      <InlineFieldRow>
        <InlineField
          label="GROUP BY"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Bucket by time. $__interval follows the dashboard zoom, so the row count stays flat as you widen the range."
        >
          <Select
            options={[
              { label: 'time', value: 'time' },
              { label: 'none', value: 'none' },
            ]}
            value={builder.groupByTime ? 'time' : 'none'}
            width={16}
            onChange={(v) => {
              set({ groupByTime: v.value === 'time' });
              onRunQuery();
            }}
          />
        </InlineField>
        {builder.groupByTime && (
          <InlineField>
            <Select
              options={INTERVAL_OPTIONS}
              value={builder.interval}
              width={28}
              allowCustomValue
              onChange={(v) => {
                set({ interval: v.value ?? '$__interval' });
                onRunQuery();
              }}
            />
          </InlineField>
        )}
        <InlineField
          label="split by"
          interactive
          tooltip="Extra GROUP BY columns, comma separated. Each distinct value becomes its own series."
        >
          <Input
            value={builder.groupByColumns.join(', ')}
            placeholder="e.g. rotorID"
            width={26}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              set({
                groupByColumns: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s !== ''),
              })
            }
            onBlur={onRunQuery}
          />
        </InlineField>
      </InlineFieldRow>

      {/* ORDER BY / LIMIT */}
      <InlineFieldRow>
        <InlineField label="ORDER BY TIME" labelWidth={LABEL_WIDTH}>
          <Select
            options={[
              { label: 'ascending', value: false },
              { label: 'descending', value: true },
            ]}
            value={builder.orderDescending}
            width={20}
            onChange={(v) => {
              set({ orderDescending: !!v.value });
              onRunQuery();
            }}
          />
        </InlineField>
        <InlineField
          label="LIMIT"
          interactive
          tooltip="Always set. It is the backstop when every other bound has been edited away."
        >
          <Input
            type="number"
            value={builder.limit ?? ''}
            placeholder="1000"
            width={16}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ limit: Number(e.target.value) || undefined })}
            onBlur={onRunQuery}
          />
        </InlineField>
      </InlineFieldRow>

      <InlineField
        label="Generated SQL"
        labelWidth={LABEL_WIDTH}
        grow
        interactive
        tooltip="Read-only. Switch to Code to edit it by hand."
      >
        <TextArea readOnly rows={Math.min(10, Math.max(3, generatedSQL.split('\n').length))} value={generatedSQL} />
      </InlineField>

      {format === 'time_series' && !builder.timeColumn && (
        <InlineFieldRow>
          <InlineField label="" labelWidth={LABEL_WIDTH}>
            <span>A time series needs a time column, or the panel will not plot.</span>
          </InlineField>
        </InlineFieldRow>
      )}
    </Stack>
  );
}

interface FilterRowProps {
  index: number;
  filter: { key: string; operator: FilterOperator; value: string };
  table: string;
  datasource: DataSource;
  onChange: (next: { key: string; operator: FilterOperator; value: string }) => void;
  onRemove: () => void;
  onRunQuery: () => void;
}

/**
 * One WHERE clause. The value dropdown is populated from the catalog manifest when
 * the menu opens -- lazily, because a panel can carry several filters and eagerly
 * loading all of them would fire a request per row on every render.
 */
function FilterRow({ index, filter, table, datasource, onChange, onRemove, onRunQuery }: FilterRowProps) {
  const [options, setOptions] = useState<Array<SelectableValue<string>>>([]);
  const [loading, setLoading] = useState(false);

  const loadValues = async () => {
    if (!table || !filter.key) {
      return;
    }
    setLoading(true);
    try {
      const res = await datasource.getResource('partition-values', { table, column: filter.key });
      setOptions((res?.values ?? []).map((v: string) => ({ label: v, value: v })));
    } catch (_e) {
      // A column that is not a partition has no manifest entry. Leaving the list
      // empty with allowCustomValue still lets the user type a literal, which is the
      // right outcome for a non-partition column.
      setOptions([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <InlineFieldRow>
      <InlineField label={index === 0 ? 'WHERE' : ''} labelWidth={LABEL_WIDTH}>
        <Input
          value={filter.key}
          placeholder="partition column"
          width={22}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...filter, key: e.target.value })}
          onBlur={onRunQuery}
        />
      </InlineField>
      <InlineField>
        <Select
          options={OPERATOR_OPTIONS}
          value={filter.operator}
          width={10}
          onChange={(v) => {
            onChange({ ...filter, operator: v.value ?? '=' });
            onRunQuery();
          }}
        />
      </InlineField>
      <InlineField>
        <Select
          options={options}
          value={filter.value ? { label: filter.value, value: filter.value } : null}
          placeholder="value"
          width={30}
          allowCustomValue
          isLoading={loading}
          onOpenMenu={loadValues}
          onChange={(v) => {
            onChange({ ...filter, value: v?.value ?? '' });
            onRunQuery();
          }}
        />
      </InlineField>
      <IconButton name="times" aria-label="remove filter" onClick={onRemove} />
    </InlineFieldRow>
  );
}
