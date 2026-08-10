import { parseVariableQuery, VariableQueryError } from './variables';

describe('parseVariableQuery', () => {
  it('parses table and column', () => {
    expect(parseVariableQuery('partition_values(rawdata, rotorID)')).toEqual({
      kind: 'partition_values',
      table: 'rawdata',
      column: 'rotorID',
      filters: {},
    });
  });

  it('parses ancestor filters, which is what makes chained variables work', () => {
    expect(parseVariableQuery('partition_values(car_telemetry, driver_acronym, year=2023, circuit=Monza)')).toEqual({
      kind: 'partition_values',
      table: 'car_telemetry',
      column: 'driver_acronym',
      filters: { year: '2023', circuit: 'Monza' },
    });
  });

  it('is insensitive to whitespace and function-name case', () => {
    expect(parseVariableQuery('  PARTITION_VALUES( rawdata ,  rotorID  )  ')).toMatchObject({
      table: 'rawdata',
      column: 'rotorID',
    });
  });

  // Users copy values out of SQL, where they are quoted. A literal quote would be
  // part of the URL parameter and match nothing.
  it('strips quotes copied over from SQL', () => {
    expect(parseVariableQuery("partition_values('rawdata', \"rotorID\", year='2026')")).toEqual({
      kind: 'partition_values',
      table: 'rawdata',
      column: 'rotorID',
      filters: { year: '2026' },
    });
  });

  it.each([
    ['', 'empty'],
    ['rawdata.rotorID', 'not a function call'],
    ['select_distinct(rawdata, rotorID)', 'unknown function'],
    ['partition_values(rawdata)', 'too few arguments'],
    ['partition_values(table=rawdata, rotorID)', 'key=value in a positional slot'],
    ['partition_values(rawdata, rotorID, year)', 'filter missing ='],
    ['partition_values(rawdata, rotorID, =2026)', 'filter missing key'],
  ])('rejects %p (%s)', (input) => {
    expect(() => parseVariableQuery(input)).toThrow(VariableQueryError);
  });

  // A dashboard variable that silently yields nothing is much harder to debug than
  // one that says why, so the message must name the offending input.
  it('names the offending input in the error', () => {
    expect(() => parseVariableQuery('nope(a, b)')).toThrow(/nope/);
  });
});
