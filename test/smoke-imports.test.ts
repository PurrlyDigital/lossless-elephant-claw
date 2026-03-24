import { describe, expect, it } from 'vitest';
import plugin from '../index.ts';

describe('smoke imports', () => {
  it('loads plugin entrypoint', () => {
    expect(plugin).toBeTruthy();
    expect((plugin as { id?: string }).id).toBe('lossless-claw');
  });
});
