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

  // The two properties that separate a working query from one the ingress kills.
  it('always bounds the scan and always caps the rows', () => {
    const sql = buildSQL(base());
    expect(sql).toContain('$__timeFilter(ts_ms)');
    expect(sql).toMatch(/LIMIT \d+/);
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
    const sql = buildSQL(base({ timeColumn: '', groupByTime: false, select: [{ column: 'speed', aggregate: 'none' }] }), 'table');
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
