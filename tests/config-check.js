// Run: gjs -m tests/config-check.js  (exit 1 on the first failure)
// Header shortcut limit in helpers/config.js. Read-only: never saves.
import { ConfigStore, TAB_DEFS, clampPinnedMax } from '../src/helpers/config.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const cfg = obj => new ConfigStore({ contents: new TextEncoder().encode(JSON.stringify(obj)) });

eq([cfg({}).pinnedMax, cfg({ pinnedMax: 0 }).pinnedMax, cfg({ pinnedMax: 99 }).pinnedMax, cfg({ pinnedMax: null }).pinnedMax,
    cfg({ pinnedMax: '3' }).pinnedMax, cfg({ pinnedMax: 'x' }).pinnedMax, cfg({ pinnedMax: 6.6 }).pinnedMax],
[5, 1, 8, 5, 3, 5, 7], 'shortcut limit: default 5, clamped to 1–8');
eq([clampPinnedMax(undefined), clampPinnedMax(''), clampPinnedMax(true), clampPinnedMax(8)], [5, 5, 5, 8], 'clamp edge cases');
const eight = TAB_DEFS.map(t => t.id).filter(id => id !== 'home').slice(0, 8);
ok(eight.length === 8, 'eight tabs to pin');
eq(cfg({ pinnedTabs: eight, pinnedMax: 3 }).pinnedTabs, eight.slice(0, 3), 'limit 3 shows the first three');
eq(cfg({ pinnedTabs: eight, pinnedMax: 8 }).pinnedTabs, eight, 'limit 8 shows all eight (the stored list kept them)');
eq(cfg({ pinnedTabs: [...eight, 'home', 'nope'] }).pinnedTabs, eight.slice(0, 5), 'home and unknown ids dropped, default limit');
eq(cfg({}).pinnedTabs, ['media', 'tasks', 'calendar', 'weather', 'system'], 'default shortcuts unchanged');

print(`config-check: ${n} checks passed`);
