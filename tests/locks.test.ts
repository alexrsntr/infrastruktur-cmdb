import { describe, expect, it } from 'vitest';
import { LOCKS } from '../server/lib/locks';

describe('advisory locks', () => {
  it('gives every background job its own lock id', () => {
    const ids = Object.values(LOCKS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
