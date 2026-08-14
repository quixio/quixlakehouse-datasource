import { BuilderState, DEFAULT_BUILDER } from '../types';
import { buildSQL, ident, literal } from './sql';

const base = (over: Partial<BuilderState> = {}): BuilderState => ({
  ...DEFAULT_BUILDER,
  table: 'car_telemetry',
  timeColumn: 'ts_ms',
  select: [{ column: 'speed', aggregate: 'avg' }],
  ...over,
});

describe('buildSQL', () => {
  it('buckets by $__interval so the row count follows zoom', () => {
    const sql = buildSQL(base());
    expect(sql).toContain('$__timeGroup(ts_ms, $__interval) AS time');
    expect(sql).toContain('GROUP BY 1');
    expect(sql).toContain('ORDER BY 1');
  });

  it('always bounds the scan by the dashboard range', () => {
    expect(buildSQL(base())).toContain('$__timeFilter(ts_ms)');
  });

  it('emits LIMIT when one is set', () => {
    expect(buildSQL(base({ limit: 500 }))).toContain('LIMIT 500');
  });

  // sc-74547. A default LIMIT truncates silently: a 60-second recording looked one
  // second long during testing because 1000 rows was the whole panel and nothing said
  // so. An unset limit must mean unlimited, not a hidden cap.
  it.each([
    ['undefined', undefined],
    ['zero', 0],
  ])('emits no LIMIT when the limit is %s', (_label, limit) => {
    expect(buildSQL(base({ limit: limit as number | undefined }))).not.toContain('LIMIT');
  });

  it('defaults to no limit', () => {
    expect(DEFAULT_BUILDER.limit).toBeUndefined();
  });

  it('aliases an aggregate to the bare column, so legends read "speed"', () => {
    expect(buildSQL(base())).toContain('avg(speed) AS speed');
  });

  it('passes the column through when the aggregate is none', () => {
    const sql = buildSQL(base({ select: [{ column: 'speed', aggregate: 'none' }], groupByTime: false }));
    expect(sql).toContain('speed');
    expect(sql).not.toContain('avg(');
    expect(sql).not.toContain('GROUP BY');
  });

  it('emits partition filters, which is what keeps the scan survivable', () => {
    const sql = buildSQL(
      base({
        filters: [
          { key: 'year', operator: '=', value: '2023' },
          { key: 'circuit', operator: '=', value: 'Monza' },
        ],
      })
    );
    expect(sql).toContain("year = '2023'");
    expect(sql).toContain("circuit = 'Monza'");
  });

  // Selecting a raw column while bucketing produced "value" bare next to GROUP BY 1,
  // which DuckDB rejects: the column must be grouped or aggregated.
  it('groups a raw column when bucketing, rather than emitting invalid SQL', () => {
    const sql = buildSQL(base({ select: [{ column: 'value', aggregate: 'none' }] }));
    expect(sql).toContain('GROUP BY 1, value');
  });

  it('groups by extra columns alongside the time bucket', () => {
    const sql = buildSQL(base({ groupByColumns: ['driver_acronym'] }));
    expect(sql).toContain('GROUP BY 1, driver_acronym');
  });

  // sc-74547. Grouping a column without selecting it is valid SQL, so nothing failed --
  // but the frame came back with only time and value, several rows sharing each
  // timestamp and nothing to tell them apart. Grafana cannot split that into series,
  // so it drew one line zig-zagging between the groups, with no per-series legend or
  // colour. The assertion above passed throughout, which is how this got shipped.
  it('SELECTS the split column too, so the frame has something to split series on', () => {
    const sql = buildSQL(base({ groupByColumns: ['signal'] }));
    expect(sql).toContain('GROUP BY 1, signal');
    // The dimension has to be a field in the frame, not just a grouping key.
    expect(sql).toMatch(/SELECT[\s\S]*\bsignal\b[\s\S]*FROM/);
  });

  it('puts the split column before the value columns, so the frame reads time, dimension, value', () => {
    const sql = buildSQL(base({ groupByColumns: ['signal'] }));
    const select = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM'));
    // Assert both are present first: indexOf returns -1 when absent, which would make
    // the ordering check pass on SQL that omits the column entirely.
    expect(select).toContain('signal');
    expect(select).toContain('avg(speed)');
    expect(select.indexOf('signal')).toBeLessThan(select.indexOf('avg(speed)'));
  });

  it('selects every split column when several are given', () => {
    const sql = buildSQL(base({ groupByColumns: ['signal', 'device'] }));
    const select = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM'));
    expect(select).toContain('signal');
    expect(select).toContain('device');
    expect(sql).toContain('GROUP BY 1, signal, device');
  });

  // Without bucketing there is no GROUP BY 1, but a split column is still a dimension
  // and still has to reach the frame.
  it('selects the split column when not bucketing by time', () => {
    const sql = buildSQL(base({ groupByTime: false, groupByColumns: ['signal'] }));
    const select = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM'));
    expect(select).toContain('signal');
  });

  it('does not select a split column twice when it is already a select field', () => {
    const sql = buildSQL(base({ select: [{ column: 'signal', aggregate: 'none' }], groupByColumns: ['signal'] }));
    const select = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM'));
    expect(select.match(/\bsignal\b/g)?.length).toBe(1);
  });

  it('orders descending when asked', () => {
    expect(buildSQL(base({ orderDescending: true }))).toContain('ORDER BY 1 DESC');
  });

  // Returning '' makes filterQuery skip the query, so a half-filled form leaves the
  // panel quiet instead of showing an error for something the user is still editing.
  it.each([
    ['no table', base({ table: '' })],
    ['no select column', base({ select: [{ column: '', aggregate: 'avg' }] })],
  ])('returns empty SQL when %s', (_label, state) => {
    expect(buildSQL(state)).toBe('');
  });

  it('still produces a time field for a time series without bucketing', () => {
    const sql = buildSQL(base({ groupByTime: false, select: [{ column: 'speed', aggregate: 'none' }] }), 'time_series');
    expect(sql).toContain('ts_ms AS time');
  });

  it('omits the time field for a table query with no time column', () => {
    const sql = buildSQL(
      base({ timeColumn: '', groupByTime: false, select: [{ column: 'speed', aggregate: 'none' }] }),
      'table'
    );
    expect(sql).not.toContain('AS time');
    expect(sql).not.toContain('$__timeFilter');
  });

  it('drops incomplete filters rather than emitting broken SQL', () => {
    const sql = buildSQL(base({ filters: [{ key: 'year', operator: '=', value: '' }] }));
    expect(sql).not.toContain('year =');
  });
});

// can_signals stores the instant across two columns: ts_ms is the segment start and
// is constant within a segment, t_rel the offset into it. Filtering bare ts_ms can
// only include or exclude whole 60-second segments, so zoom cannot cut inside one.
describe('composite time expressions', () => {
  const timeExpr = 'ts_ms + CAST(t_rel * 1000 AS BIGINT)';

  it('does not quote an expression as an identifier', () => {
    const sql = buildSQL(base({ timeColumn: timeExpr }));
    expect(sql).toContain(`$__timeGroup(${timeExpr}, $__interval) AS time`);
    expect(sql).not.toContain(`"${timeExpr}"`);
  });

  it('filters on the same expression, so zoom can cut inside a segment', () => {
    expect(buildSQL(base({ timeColumn: timeExpr }))).toContain(`$__timeFilter(${timeExpr})`);
  });

  it('accepts an expression as a value field and gives it a usable alias', () => {
    const sql = buildSQL(base({ select: [{ column: 'value * 100', aggregate: 'avg' }] }));
    expect(sql).toContain('avg(value * 100) AS value');
  });

  it('still quotes an awkward plain column name', () => {
    expect(buildSQL(base({ timeColumn: 'rotorID', groupByTime: false }))).toContain('"rotorID" AS time');
  });
});

describe('identifier quoting', () => {
  // DuckDB folds unquoted identifiers to lower case, and these columns really exist
  // in the lakehouse: rawdata has rotorID and __index_level_0__.
  it.each([
    ['speed', 'speed'],
    ['ts_ms', 'ts_ms'],
    ['rotorID', '"rotorID"'],
    ['__index_level_0__', '__index_level_0__'],
    ['weird col', '"weird col"'],
    ['has"quote', '"has""quote"'],
  ])('ident(%p) -> %p', (input, want) => {
    expect(ident(input)).toBe(want);
  });

  it('escapes quotes in string literals', () => {
    expect(literal("O'Brien")).toBe("'O''Brien'");
  });
});
