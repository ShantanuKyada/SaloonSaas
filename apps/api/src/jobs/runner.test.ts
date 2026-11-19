import { describe, expect, it } from 'vitest';
import { pauseAfter } from './runner.js';

describe('pauseAfter', () => {
  it('waits the normal poll interval while things work', () => {
    expect(pauseAfter(0, 2000)).toBe(2000);
  });

  it('backs off exponentially after failed rounds, up to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => pauseAfter(n, 2000))).toEqual([4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
});
