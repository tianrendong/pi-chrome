import assert from "node:assert/strict";
import policy from "../../extensions/chrome-profile-bridge/background-policy.cjs";

const { resolveChromeBackground } = policy;

const cases = [
  {
    name: "default background mode stays background",
    params: {},
    defaultBackground: true,
    locked: false,
    expectedForeground: false,
  },
  {
    name: "explicit foreground opt-in is preserved when unlocked",
    params: { background: false },
    defaultBackground: true,
    locked: false,
    expectedForeground: true,
  },
  {
    name: "explicit background opt-in is preserved when foreground is default",
    params: { background: true },
    defaultBackground: false,
    locked: false,
    expectedForeground: false,
  },
  {
    name: "legacy foreground=false remains background",
    params: { foreground: false },
    defaultBackground: false,
    locked: false,
    expectedForeground: false,
  },
  {
    name: "hard background lock overrides background=false",
    params: { background: false },
    defaultBackground: false,
    locked: true,
    expectedForeground: false,
  },
  {
    name: "hard background lock overrides legacy foreground=true",
    params: { foreground: true },
    defaultBackground: false,
    locked: true,
    expectedForeground: false,
  },
];

for (const testCase of cases) {
  const result = resolveChromeBackground(testCase.params, testCase.defaultBackground, testCase.locked);
  assert.equal(result.foreground, testCase.expectedForeground, testCase.name);
}

console.log(`${cases.length} passed, 0 failed`);
