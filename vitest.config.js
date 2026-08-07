import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // Leftover git worktrees under .claude/worktrees are full checkouts that
    // contain their own copies of every test file. Without this exclude,
    // vitest's default glob discovers and runs those stale copies alongside
    // the real ones, producing phantom failures from pre-fix code. Keep test
    // discovery pinned to the working tree.
    exclude: [...configDefaults.exclude, '**/.claude/**']
  }
})
