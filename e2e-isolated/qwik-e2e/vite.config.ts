import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths({ ignoreConfigErrors: true, root: '../../' })],
  test: {
    include: ['./tests/*.spec.?(c|m)[jt]s?(x)'],
  },
});
