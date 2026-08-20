import { defineConfig } from 'vitest/config'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import path from 'path'

// The integration suites share ONE scratch database, and some state is
// database-global (the effective-dated settings history, the default
// reminder sequence, pack declarations). Files must therefore run one at a
// time in a KNOWN order — fileParallelism alone serialises but leaves the
// order to a duration cache, which reshuffles between runs. This sequencer
// pins alphabetical path order, which the suites' cross-file contracts
// (documented in each file's header) rely on.
//
// Found the hard way: the previous `forks: { singleFork: true }` sat at the
// wrong config level for vitest 4 and was silently ignored — every suite ran
// in parallel from day one, and the first database-global fixture exposed it.
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId))
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,
    sequence: { sequencer: AlphabeticalSequencer },
  },
})
