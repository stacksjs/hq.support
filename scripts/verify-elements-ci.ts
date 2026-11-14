import assert from 'node:assert/strict'
export function assertElementsCiRun(run: any, repository: string, sha: string) {
  assert.equal(repository, 'stacksjs/hq.support'); assert.match(sha, /^[a-f0-9]{40}$/)
  assert.equal(run.head_sha, sha); assert.equal(run.head_branch, 'main'); assert.equal(run.event, 'push'); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.path, '.github/workflows/ci.yml')
  assert.equal(run.repository?.full_name, repository); assert.equal(run.head_repository?.full_name, repository)
}
if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY || '', sha = process.env.GITHUB_SHA || '', runId = process.env.SUPPORT_ELEMENTS_CI_RUN || '', token = process.env.GITHUB_TOKEN || ''
  assert.equal(repository, 'stacksjs/hq.support'); assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  assert.match(sha, /^[a-f0-9]{40}$/); assert.match(runId, /^\d+$/); assert.ok(token, 'A read-only Actions token is required for the same-SHA CI gate')
  async function read(path: string) {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error' })
    assert.ok(response.ok, `GitHub CI gate returned HTTP ${response.status}`)
    return await response.json() as any
  }
  const run = await read(`/actions/runs/${runId}`)
  assertElementsCiRun(run, repository, sha)
  const artifacts = await read(`/actions/runs/${runId}/artifacts?per_page=100`)
  assert.ok(artifacts.artifacts.some((artifact: any) => artifact.name === `support-elements-${sha}` && !artifact.expired), 'Green same-SHA CI must upload the exact component publication candidate')
  console.info(`Verified successful main CI run ${runId} at ${sha}`)
}
