import { BuilderCondition, BuilderGroup, BuilderState } from '../types';
import { buildSQL } from './sql';
import { conditionKeys, conditionNode, groupNode, guaranteedFor, newGroup, prune, whereTree } from './where';

const c = (key: string, value: string, operator: BuilderCondition['operator'] = '='): BuilderCondition => ({
  key,
  operator,
  value,
});

const base: BuilderState = {
  table: 'can_signals',
  timeColumn: 'ts_ms',
  select: [{ column: 'value', aggregate: 'avg' }],
  filters: [],
  groupByTime: false,
  interval: '$__interval',
  groupByColumns: [],
  orderDescending: false,
};

const sqlFor = (where: BuilderGroup, timeColumn = 'ts_ms') => buildSQL({ ...base, timeColumn, where });
const whereClause = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => l.startsWith('WHERE') || l.startsWith('  AND'))
    .join('\n');

describe('whereTree migration', () => {
  it('wraps a legacy flat filter list in an AND group', () => {
    const tree = whereTree({ ...base, filters: [c('platform', 'FORD'), c('signal', 'rpm')] });
    expect(tree.conjunction).toBe('AND');
    expect(tree.children).toHaveLength(2);
    expect(conditionKeys(tree)).toEqual(['platform', 'signal']);
  });

  // A saved dashboard must not change meaning because the editor gained groups.
  it('generates the same SQL for a legacy panel as for its migrated tree', () => {
    const legacy = buildSQL({ ...base, filters: [c('platform', 'FORD'), c('signal', 'rpm')] });
    const migrated = sqlFor(newGroup('AND', [conditionNode(c('platform', 'FORD')), conditionNode(c('signal', 'rpm'))]));
    expect(migrated).toBe(legacy);
    expect(whereClause(legacy)).toBe("WHERE $__timeFilter(ts_ms)\n  AND platform = 'FORD'\n  AND signal = 'rpm'");
  });

  it('prefers where over filters when both are present', () => {
    const tree = whereTree({ ...base, filters: [c('ignored', 'x')], where: newGroup('OR', []) });
    expect(tree.conjunction).toBe('OR');
    expect(tree.children).toHaveLength(0);
  });
});

describe('generated brackets', () => {
  it('joins a group with OR', () => {
    const sql = sqlFor(newGroup('OR', [conditionNode(c('platform', 'A')), conditionNode(c('sender_node', 'B'))]));
    expect(whereClause(sql)).toBe("WHERE $__timeFilter(ts_ms)\n  AND (platform = 'A' OR sender_node = 'B')");
  });

  /**
   * The reason root-level OR is always bracketed once anything is ANDed with it.
   * `$__timeFilter(t) AND a OR b` binds as `($__timeFilter(t) AND a) OR b`, so the
   * right-hand branch loses its time bound and scans the whole table.
   */
  it('brackets an OR root so the time filter still bounds every branch', () => {
    const sql = sqlFor(newGroup('OR', [conditionNode(c('a', '1')), conditionNode(c('b', '2'))]));
    expect(sql).toContain("AND (a = '1' OR b = '2')");
    expect(sql).not.toContain("AND a = '1' OR");
  });

  it('needs no outer brackets when there is no time filter to AND with', () => {
    const sql = sqlFor(newGroup('OR', [conditionNode(c('a', '1')), conditionNode(c('b', '2'))]), '');
    expect(whereClause(sql)).toBe("WHERE a = '1' OR b = '2'");
  });

  it('builds (a AND b) OR (c AND d)', () => {
    const sql = sqlFor(
      newGroup('OR', [
        groupNode(newGroup('AND', [conditionNode(c('a', '1')), conditionNode(c('b', '2'))])),
        groupNode(newGroup('AND', [conditionNode(c('cc', '3')), conditionNode(c('d', '4'))])),
      ]),
      ''
    );
    expect(whereClause(sql)).toBe("WHERE (a = '1' AND b = '2') OR (cc = '3' AND d = '4')");
  });

  it('nests an OR group inside an AND root', () => {
    const sql = sqlFor(
      newGroup('AND', [
        conditionNode(c('platform', 'A')),
        groupNode(newGroup('OR', [conditionNode(c('signal', 'x')), conditionNode(c('signal', 'y'))])),
      ])
    );
    expect(whereClause(sql)).toBe(
      "WHERE $__timeFilter(ts_ms)\n  AND platform = 'A'\n  AND (signal = 'x' OR signal = 'y')"
    );
  });

  // Brackets round a single condition are legal but make generated SQL harder to read,
  // and people do read and edit this.
  it('omits brackets around a group with one condition', () => {
    const sql = sqlFor(newGroup('AND', [groupNode(newGroup('OR', [conditionNode(c('a', '1'))]))]));
    expect(whereClause(sql)).toBe("WHERE $__timeFilter(ts_ms)\n  AND a = '1'");
  });

  it('drops half-filled rows instead of emitting broken SQL', () => {
    const sql = sqlFor(
      newGroup('OR', [conditionNode(c('a', '1')), conditionNode(c('b', '')), conditionNode(c('', '2'))]),
      ''
    );
    expect(whereClause(sql)).toBe("WHERE a = '1'");
  });

  it('drops an entirely empty group', () => {
    const sql = sqlFor(newGroup('AND', [conditionNode(c('a', '1')), groupNode(newGroup('OR', []))]));
    expect(whereClause(sql)).toBe("WHERE $__timeFilter(ts_ms)\n  AND a = '1'");
  });

  it('escapes quotes in values', () => {
    const sql = sqlFor(newGroup('AND', [conditionNode(c('name', "O'Brien"))]), '');
    expect(whereClause(sql)).toBe("WHERE name = 'O''Brien'");
  });
});

/**
 * Removing a group's last condition used to leave `{conjunction, children: []}` in the
 * tree. On screen that is an orphaned `AND (` with no rows, no closing bracket, no way to
 * delete it — the remove-group control lives on the group's last row, which is the one
 * just deleted — and the + below it belongs to the OUTER group, so it adds a sibling
 * rather than filling the empty bracket. A bracket with nothing in it has no meaning, so
 * it is dropped rather than made editable.
 */
describe('prune', () => {
  it('drops a group left empty by removing its last condition', () => {
    const tree = newGroup('AND', [conditionNode(c('platform', 'A')), groupNode(newGroup('OR', []))]);
    const pruned = prune(tree);
    expect(pruned.children).toHaveLength(1);
    expect(pruned.children[0].kind).toBe('condition');
  });

  it('keeps a group that still has a condition, even an unfilled one', () => {
    const tree = newGroup('AND', [groupNode(newGroup('OR', [conditionNode(c('', ''))]))]);
    expect(prune(tree).children).toHaveLength(1);
  });

  it('drops a group whose only child is an empty group', () => {
    const tree = newGroup('AND', [
      conditionNode(c('a', '1')),
      groupNode(newGroup('OR', [groupNode(newGroup('AND', []))])),
    ]);
    const pruned = prune(tree);
    expect(pruned.children).toHaveLength(1);
    expect(pruned.children[0].kind).toBe('condition');
  });

  // The root has the empty-WHERE row as its own affordance, so it must survive.
  it('keeps an empty root', () => {
    expect(prune(newGroup('AND', [])).children).toEqual([]);
  });

  it('leaves a healthy tree untouched', () => {
    const tree = newGroup('AND', [
      conditionNode(c('a', '1')),
      groupNode(newGroup('OR', [conditionNode(c('b', '2')), conditionNode(c('cc', '3'))])),
    ]);
    expect(prune(tree)).toEqual(tree);
  });
});

describe('guaranteedFor', () => {
  const A = c('platform', 'A');
  const B = c('sender_node', 'B');
  const D = c('device', 'D');

  it('passes AND siblings', () => {
    const group = newGroup('AND', [conditionNode(A), conditionNode(B)]);
    expect(guaranteedFor(group, [], 0)).toEqual([B]);
    expect(guaranteedFor(group, [], 1)).toEqual([A]);
  });

  // Under OR neither branch is guaranteed, so narrowing by a sibling would hide values
  // that are perfectly valid for the row being edited.
  it('passes nothing from OR siblings', () => {
    const group = newGroup('OR', [conditionNode(A), conditionNode(B)]);
    expect(guaranteedFor(group, [], 0)).toEqual([]);
    expect(guaranteedFor(group, [], 1)).toEqual([]);
  });

  it('keeps ancestor guarantees while dropping OR siblings', () => {
    const group = newGroup('OR', [conditionNode(A), conditionNode(B)]);
    expect(guaranteedFor(group, [D], 0)).toEqual([D]);
  });

  // A lone child has nothing to disjoin, so OR and AND mean the same thing there and
  // throwing the guarantee away would needlessly widen the dropdown.
  it('treats a single-child OR group as definite', () => {
    const group = newGroup('OR', [conditionNode(A), conditionNode(B)]);
    const single = newGroup('OR', [conditionNode(A)]);
    expect(guaranteedFor(single, [D], 0)).toEqual([D]);
    expect(guaranteedFor(group, [], 0)).toEqual([]);
  });

  it('takes conditions from an all-AND sibling group', () => {
    const sibling = newGroup('AND', [conditionNode(B), conditionNode(D)]);
    const group = newGroup('AND', [conditionNode(A), groupNode(sibling)]);
    expect(guaranteedFor(group, [], 0)).toEqual([B, D]);
  });

  it('takes nothing from an OR sibling group', () => {
    const sibling = newGroup('OR', [conditionNode(B), conditionNode(D)]);
    const group = newGroup('AND', [conditionNode(A), groupNode(sibling)]);
    expect(guaranteedFor(group, [], 0)).toEqual([]);
  });

  it('ignores half-filled siblings', () => {
    const group = newGroup('AND', [conditionNode(A), conditionNode(c('device', ''))]);
    expect(guaranteedFor(group, [], 0)).toEqual([]);
  });
});
