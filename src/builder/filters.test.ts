import { BuilderFilter } from '../types';
import { partitionValuesParams } from './filters';

// can_signals partition spec order.
const SPEC = ['platform', 'device', 'route', 'channel', 'sender_node', 'frame_name', 'signal'];

const f = (key: string, value: string, operator: BuilderFilter['operator'] = '='): BuilderFilter => ({
  key,
  operator,
  value,
});

describe('partitionValuesParams', () => {
  it('always sends the table and column', () => {
    expect(partitionValuesParams('can_signals', 'signal', [], SPEC)).toEqual({
      table: 'can_signals',
      column: 'signal',
    });
  });

  // The bug: a second filter offered every value of its column, so picking one that
  // cannot co-exist with the first returned no rows and no explanation.
  it('narrows by an ancestor filter that is already set', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('frame_name', 'ACCDATA')], SPEC);
    expect(params).toEqual({ table: 'can_signals', column: 'signal', frame_name: 'ACCDATA' });
  });

  it('sends every ancestor, not just the nearest', () => {
    const params = partitionValuesParams(
      'can_signals',
      'signal',
      [f('platform', 'FORD'), f('frame_name', 'ACCDATA')],
      SPEC
    );
    expect(params.platform).toBe('FORD');
    expect(params.frame_name).toBe('ACCDATA');
  });

  // A later column is not an ancestor, so the catalog cannot honour it as a narrowing.
  it('ignores a descendant filter', () => {
    const params = partitionValuesParams('can_signals', 'frame_name', [f('signal', 'AccBrkTot_A_Rq')], SPEC);
    expect(params.signal).toBeUndefined();
  });

  it('ignores a filter on the same column', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('signal', 'other')], SPEC);
    expect(params.signal).toBeUndefined();
  });

  // A partition is a directory; a range does not identify one.
  it.each([['!='], ['>'], ['<'], ['>='], ['<=']])('ignores the %s operator', (op) => {
    const params = partitionValuesParams(
      'can_signals',
      'signal',
      [f('frame_name', 'ACCDATA', op as BuilderFilter['operator'])],
      SPEC
    );
    expect(params.frame_name).toBeUndefined();
  });

  it('ignores a column that is not part of the partition spec', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('value', '42')], SPEC);
    expect(params.value).toBeUndefined();
  });

  it('ignores filters with no value yet', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('frame_name', '')], SPEC);
    expect(params.frame_name).toBeUndefined();
  });

  // Nothing may shadow the two reserved parameters, or the lookup silently asks about
  // a different table or column than the row displays.
  it.each([['table'], ['column']])('never lets a filter overwrite %s', (reserved) => {
    const params = partitionValuesParams('can_signals', 'signal', [f(reserved, 'hijacked')], [...SPEC, reserved]);
    expect(params.table).toBe('can_signals');
    expect(params.column).toBe('signal');
  });

  // With no spec loaded yet there are no known ancestors, so nothing is narrowed and
  // the caller falls back to the full list rather than sending a wrong constraint.
  it('narrows nothing when the partition spec is unknown', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('frame_name', 'ACCDATA')], []);
    expect(params).toEqual({ table: 'can_signals', column: 'signal' });
  });
});
