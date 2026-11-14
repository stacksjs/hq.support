import { expect, test } from 'bun:test'
import { qualificationErrors } from '../../scripts/check-launch'

test('production refuses absent, mismatched and incomplete launch evidence', () => {
  const commit = 'a'.repeat(40)
  expect(qualificationErrors(null, commit)).not.toHaveLength(0)
  expect(qualificationErrors({ commit: 'b'.repeat(40), checks: [] }, commit)).toEqual(['Qualification must match the exact deployed commit.'])
  const errors = qualificationErrors({ commit, checks: [{ id: 'web-inbox', status: 'passed', evidence: 'ci/test-report', completedAt: '2026-01-01T00:00:00Z' }] }, commit)
  expect(errors).toContain('voice-ai: require exactly one result.')
  expect(errors.some(error => error.startsWith('web-inbox:'))).toBe(false)
})
