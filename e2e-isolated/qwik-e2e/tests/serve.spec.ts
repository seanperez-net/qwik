import { assert, test, beforeAll } from 'vitest';
import { ensureQwikProject } from '../../utils';

beforeAll(() => {
    ensureQwikProject()
})

test('dummy test', () => {
  assert.equal('a', 'a');
});