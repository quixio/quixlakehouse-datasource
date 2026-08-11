import { SelectableValue } from '@grafana/data';
import { Alert, IconButton, InlineField, InlineFieldRow, Input, Select, Stack, TextArea } from '@grafana/ui';
import React, { ChangeEvent, useCallback, useEffect, useState } from 'react';

import { DataSource } from '../datasource';
import { AggregateFn, BuilderState, FilterOperator, QueryFormat } from '../types';

// 18 × 8 px = 144 px, of which 128 px is content (the label has 8 px padding each
// side). Measured in the browser, the longest labels -- "Generated SQL", "TIME COLUMN"
// and "Time format" -- render at exactly 112 px. At LABEL_WIDTH=16 that left 112 px of
// content for 112 px of text: no margin at all, and because the label is
// `white-space: normal` it wrapped to two lines rather than overflowing. 18 leaves
// 16 px of slack. All rows share this constant so controls form one clean column.
const LABEL_WIDTH = 18;

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

// Mirrors timeColumnNameHints in pkg/plugin/timefmt.go, which the backend uses to
// auto-detect a time column when the query does not name one. Keeping the two in step
// means the column the editor suggests first is the one the backend would have picked.
const TIME_NAME_HINTS = new Set(['time', 'timestamp', 'ts', 'ts_ms', 'datetime', 'date', 'event_time']);

const GROUP_BY_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'time', value: 'time' },
  { label: 'none', value: 'none' },
];

const ORDER_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'ascending', value: 'asc' },
  { label: 'descending', value: 'desc' },
];

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

  const [tables, setTables] = useState<Array<SelectableValue<string>>>([]);
  const [loadingTables, setLoadingTables] = useState(false);

  // Lazily, on menu open: a panel does not need the catalog listing until someone
  // actually goes looking for a table.
  const loadTables = async () => {
    setLoadingTables(true);
    try {
      const res = await datasource.getResource('tables');
      setTables((res?.tables ?? []).map((t: string) => ({ label: t, value: t })));
    } catch (_e) {
      setTables([]);
    } finally {
      setLoadingTables(false);
    }
  };

  /**
   * Partition columns for the selected table, fetched as soon as the table is known
   * rather than when a dropdown is opened.
   *
   * Eager here, unlike tables and values, because these drive what the WHERE row can
   * offer. Loading them lazily means clicking "+" produces an empty box the user has
   * to know to click before it reveals anything -- filling in a blind text field is
   * exactly the failure this replaces. They are also cheap: one call per table, and
   * a handful of strings.
   */
  const table = builder.table ?? '';
  // Stored WITH the table it belongs to, so switching tables cannot show the previous
  // table's columns while the new request is in flight -- and so the effect never has
  // to clear state synchronously, which triggers a cascading render.
  const [loaded, setLoaded] = useState<{ table: string; columns: string[] }>({ table: '', columns: [] });
  const partitionColumns = loaded.table === table ? loaded.columns : [];

  useEffect(() => {
    if (!table) {
      return;
    }
    let cancelled = false;
    datasource
      .getResource('partition-info', { table })
      .then((res) => {
        if (!cancelled) {
          setLoaded({ table, columns: res?.columns ?? [] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ table, columns: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [table, datasource]);

  /** The next partition column not already filtered on, so "+" lands on something useful. */
  const nextUnusedColumn = (): string => {
    const used = new Set(builder.filters.map((f) => f.key));
    return partitionColumns.find((c) => !used.has(c)) ?? '';
  };

  // Table schema, loaded with the table for the same reason as the partition columns:
  // SELECT and TIME COLUMN should offer real columns rather than a blank box. The
  // backend already strips __index_level_0__ and __key from this list.
  const [schema, setSchema] = useState<{ table: string; columns: Array<{ name: string; type: string }> }>({
    table: '',
    columns: [],
  });
  const columnsForTable = schema.table === table ? schema.columns : [];

  useEffect(() => {
    if (!table) {
      return;
    }
    let cancelled = false;
    datasource
      .getResource('schema', { table })
      .then((res) => {
        if (!cancelled) {
          setSchema({ table, columns: res?.columns ?? [] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSchema({ table, columns: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [table, datasource]);

  // Type is appended to the label rather than passed as `description`. A description
  // renders on a second line, which turned a 17-column table into a menu tall enough
  // to open upward over the panel and show only about five entries. One line each
  // keeps the whole list scannable, and typing a type still filters.
  const columnOptions: Array<SelectableValue<string>> = columnsForTable.map((c) => ({
    label: `${c.name}  ·  ${c.type}`,
    value: c.name,
  }));

  // A time column has to be an epoch integer or a real timestamp. Offering strings
  // here produces a panel that silently will not plot.
  //
  // Ordered, not just filtered, because type alone cannot identify a timestamp:
  // can_signals.t_rel is a DOUBLE holding seconds *relative* to a segment, so using
  // it as a time column yields a chart sitting at 1970-01-01. Conventionally named
  // columns come first, then other integers, then floats -- which puts ts_ms above
  // t_rel where it belongs. The list is filtered, not truncated, and custom values
  // are still allowed, so an unconventionally named epoch column stays reachable.
  const timeColumnOptions = columnsForTable
    .filter((c) => /^(long|int|bigint|double|float|timestamp|date)/i.test(c.type))
    .map((c) => ({
      label: `${c.name}  ·  ${c.type}`,
      value: c.name,
      rank: TIME_NAME_HINTS.has(c.name.toLowerCase())
        ? 0
        : /^(timestamp|date)/i.test(c.type)
          ? 1
          : /^(long|int|bigint)/i.test(c.type)
            ? 2
            : 3,
    }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ label, value }) => ({ label, value }));

  return (
    <Stack direction="column" gap={0.5}>
      <InlineFieldRow>
        <InlineField
          label="FROM"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Lakehouse table. Loaded from the catalog when the menu opens."
        >
          <Select
            options={tables}
            value={builder.table ? { label: builder.table, value: builder.table } : null}
            placeholder="select table"
            width={30}
            allowCustomValue
            isLoading={loadingTables}
            onOpenMenu={loadTables}
            onChange={(v) => {
              // Clear the partition filters: they name columns of the previous table
              // and would silently become predicates that match nothing.
              set({ table: v?.value ?? '', filters: [] });
              onRunQuery();
            }}
          />
        </InlineField>
        <InlineField
          label="TIME COLUMN"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Column holding the timestamp, usually epoch milliseconds. Drives $__timeFilter and the time bucket. An expression is allowed: where the instant is split across two columns, e.g. a per-segment start plus an offset, use ts_ms + CAST(t_rel * 1000 AS BIGINT). Filtering the same expression is what lets zoom cut inside a segment."
        >
          <Select
            options={timeColumnOptions}
            value={builder.timeColumn ? { label: builder.timeColumn, value: builder.timeColumn } : null}
            placeholder="ts_ms"
            width={24}
            allowCustomValue
            onChange={(v) => {
              set({ timeColumn: v?.value ?? '' });
              onRunQuery();
            }}
          />
        </InlineField>
      </InlineFieldRow>

      {/* SELECT */}
      {builder.select.map((sel, i) => (
        <InlineFieldRow key={`sel-${i}`}>
          {/* Empty label on rows after the first is intentional: it indents the control
              to align with the first row, visually grouping all SELECT fields together.
              This is the same pattern Grafana's InfluxQL editor uses. */}
          <InlineField label={i === 0 ? 'SELECT' : ''} labelWidth={LABEL_WIDTH}>
            <Select
              options={columnOptions}
              value={sel.column ? { label: sel.column, value: sel.column } : null}
              placeholder="field"
              width={30}
              allowCustomValue
              onChange={(v) => {
                const next = [...builder.select];
                next[i] = { ...next[i], column: v?.value ?? '' };
                set({ select: next });
                onRunQuery();
              }}
            />
          </InlineField>
          <InlineField>
            <Select
              options={AGGREGATE_OPTIONS}
              value={AGGREGATE_OPTIONS.find((o) => o.value === sel.aggregate)}
              width={20}
              onChange={(v) => {
                const next = [...builder.select];
                next[i] = { ...next[i], aggregate: v.value ?? 'avg' };
                set({ select: next });
                onRunQuery();
              }}
            />
          </InlineField>
          {/* Stack gives the × / + chips an explicit 4 px gap (gap={0.5} = 0.5 × 8 px)
              and centres them vertically against the adjacent input. */}
          <Stack direction="row" gap={0.5} alignItems="center">
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
          </Stack>
        </InlineFieldRow>
      ))}

      {/* WHERE */}
      {builder.filters.map((f, i) => (
        <FilterRow
          key={`f-${i}`}
          index={i}
          isLast={i === builder.filters.length - 1}
          onAdd={() => set({ filters: [...builder.filters, { key: nextUnusedColumn(), operator: '=', value: '' }] })}
          filter={f}
          table={table}
          partitionColumns={partitionColumns}
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
      {/* Only shown when there are no filters yet. Once one exists the + lives on the
          last row, which avoids a second row whose only content is an empty 144px
          label box and an orphaned tooltip icon. */}
      {builder.filters.length === 0 && (
        <InlineFieldRow>
          <InlineField
            label="WHERE"
            labelWidth={LABEL_WIDTH}
            interactive
            tooltip={
              partitionColumns.length > 0
                ? `Add at least one: an unpartitioned scan is the usual reason a query never returns. ${table} is partitioned by ${partitionColumns.join(', ')}.`
                : 'Partition filters. Add at least one: an unpartitioned scan is the usual reason a query never returns.'
            }
          >
            <IconButton
              name="plus"
              aria-label="add filter"
              onClick={() =>
                set({ filters: [...builder.filters, { key: nextUnusedColumn(), operator: '=', value: '' }] })
              }
            />
          </InlineField>
        </InlineFieldRow>
      )}

      {/* GROUP BY */}
      <InlineFieldRow>
        <InlineField
          label="GROUP BY"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Bucket by time. $__interval follows the dashboard zoom, so the row count stays flat as you widen the range."
        >
          <Select
            options={GROUP_BY_OPTIONS}
            value={GROUP_BY_OPTIONS.find((o) => o.value === (builder.groupByTime ? 'time' : 'none'))}
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
              // A SelectableValue, not a bare string. With allowCustomValue set, a
              // raw value that does not match an option is treated as "nothing
              // selected", so the control showed a stale label and the change never
              // reached builder.interval -- the same defect ORDER BY had with a
              // boolean value.
              value={
                INTERVAL_OPTIONS.find((o) => o.value === builder.interval) ?? {
                  label: builder.interval,
                  value: builder.interval,
                }
              }
              width={28}
              allowCustomValue
              onChange={(v) => {
                set({ interval: v?.value ?? '$__interval' });
                onRunQuery();
              }}
            />
          </InlineField>
        )}
        <InlineField
          label="split by"
          labelWidth={LABEL_WIDTH}
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
          {/* String values, not booleans: Select matches an option by value, and a
              `false` value is indistinguishable from "nothing selected", so the
              control rendered as an empty "Choose" even though the default was
              ascending and the generated SQL was correct. */}
          <Select
            options={ORDER_OPTIONS}
            value={builder.orderDescending ? 'desc' : 'asc'}
            width={20}
            onChange={(v) => {
              set({ orderDescending: v.value === 'desc' });
              onRunQuery();
            }}
          />
        </InlineField>
        <InlineField
          label="LIMIT"
          labelWidth={LABEL_WIDTH}
          interactive
          tooltip="Row cap. Leave empty for no limit. Note that nothing else bounds the result: maxDataPoints is not pushed down, so an unbounded query on a large table can be cut off by the ingress rather than returning an error."
        >
          {/* Placeholder reads "no limit", not a number. A greyed-out "1000" looked like
              a value that was already applied, when in fact an empty field emits no
              LIMIT clause at all. */}
          <Input
            type="number"
            value={builder.limit ?? ''}
            placeholder="no limit"
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

      {/* Only warn once the form has been started. Showing this on an empty builder
          scolds the user for not having typed anything yet. Alert gives the message
          the correct Grafana warning colour and accessible role="alert" — a bare
          <span> is invisible to screen readers and blends into body text. */}
      {format === 'time_series' && !!builder.table && !builder.timeColumn && (
        <Alert severity="warning" title="A time series needs a time column, or the panel will not plot." />
      )}
    </Stack>
  );
}

interface FilterRowProps {
  index: number;
  /** The last row carries the + chip, so there is no separate add row to label. */
  isLast: boolean;
  onAdd: () => void;
  filter: { key: string; operator: FilterOperator; value: string };
  table: string;
  /** Preloaded by the parent when the table changes, so this row opens ready. */
  partitionColumns: string[];
  datasource: DataSource;
  onChange: (next: { key: string; operator: FilterOperator; value: string }) => void;
  onRemove: () => void;
  onRunQuery: () => void;
}

/**
 * One WHERE clause.
 *
 * Columns arrive preloaded from the parent. Values stay lazy: a table can have
 * thousands of partition values (rawdata has 1007 rotorIDs), and a panel can carry
 * several filters, so fetching them all up front would be a burst of large requests
 * for lists the user may never open.
 */
function FilterRow({
  index,
  isLast,
  onAdd,
  filter,
  table,
  partitionColumns,
  datasource,
  onChange,
  onRemove,
  onRunQuery,
}: FilterRowProps) {
  const [options, setOptions] = useState<Array<SelectableValue<string>>>([]);
  const [loading, setLoading] = useState(false);
  const columns: Array<SelectableValue<string>> = partitionColumns.map((c) => ({ label: c, value: c }));

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
        {/* allowCustomValue: partition columns are the ones worth filtering on, but
            filtering on an ordinary column is still legal and sometimes wanted. */}
        <Select
          options={columns}
          value={filter.key ? { label: filter.key, value: filter.key } : null}
          placeholder="partition column"
          width={22}
          allowCustomValue
          onChange={(v) => {
            // Clear the value: it belonged to the previous column and would silently
            // become a filter that matches nothing.
            onChange({ ...filter, key: v?.value ?? '', value: '' });
            setOptions([]);
          }}
        />
      </InlineField>
      <InlineField>
        <Select
          options={OPERATOR_OPTIONS}
          value={OPERATOR_OPTIONS.find((o) => o.value === filter.operator)}
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
      {/* Same Stack wrapper as SELECT chips: 4 px gap, vertically centred. */}
      <Stack direction="row" gap={0.5} alignItems="center">
        <IconButton name="times" aria-label="remove filter" onClick={onRemove} />
        {/* The + lives on the last row, next to its x, the same shape SELECT uses.
            Without it there is no way to add a second filter once the first exists --
            which is exactly what a previous edit accidentally removed. */}
        {isLast && <IconButton name="plus" aria-label="add filter" onClick={onAdd} />}
      </Stack>
    </InlineFieldRow>
  );
}
