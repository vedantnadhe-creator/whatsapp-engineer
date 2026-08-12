// Guards the sheet <-> board Type round-trip. normalizeType() falls back to
// 'feature', so a type missing from sheet_schema.TYPES is silently downgraded on
// upload instead of failing loudly — that is how Epic rows used to lose their type.
import { TYPES, normalizeType, COLUMNS, TABS } from './sheet_schema.js';

// Mirrors TYPES in public-react/src/components/SprintBoard.jsx.
const BOARD_TYPES = ['epic', 'feature', 'task', 'bug', 'improvement'];

let failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

for (const type of BOARD_TYPES) {
    check(`sheet accepts board type "${type}"`, TYPES.includes(type), true);
    // Testers type loosely in the sheet, so casing/spacing must survive import.
    check(`normalizeType("${type}") round-trips`, normalizeType(type), type);
    check(`normalizeType("${type.toUpperCase()}") round-trips`, normalizeType(type.toUpperCase()), type);
}

check('unknown type falls back to feature', normalizeType('nonsense'), 'feature');
check('blank type falls back to feature', normalizeType(''), 'feature');

for (const tab of [TABS.FEATURES, TABS.SUBTASKS]) {
    const options = COLUMNS[tab].find((c) => c.key === 'type')?.options;
    check(`${tab} Type column offers every board type`, BOARD_TYPES.every((t) => options?.includes(t)), true);
}

console.log(failed === 0 ? '\n✅ sheet type schema OK' : `\n❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
