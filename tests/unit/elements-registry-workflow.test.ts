import { describe, expect, test } from 'bun:test'
import { verifyElementsPublicationSource, verifyElementsRegistrySource } from '../../scripts/verify-elements-registry-source'

const input = { repository: 'stacksjs/hq.support', sourceSha: 'a'.repeat(40), verifierSha: 'b'.repeat(40), runId: '123', version: '0.1.0-alpha.0' }
interface WorkflowStep {
  if?: string
  'continue-on-error'?: boolean
  uses?: string
  run?: string
  id?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface VerificationWorkflow {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } }
  permissions: Record<string, string>
  jobs: { verify: { if: string, env: Record<string, string>, steps: WorkflowStep[] } }
}
function sourceFixture() {
  return {
    run: { id: 123, head_sha: input.sourceSha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', repository: { id: 456, full_name: input.repository }, head_repository: { id: 456, full_name: input.repository } },
    artifacts: { total_count: 1, artifacts: [{ id: 789, name: `support-elements-${input.sourceSha}`, expired: false, size_in_bytes: 100, workflow_run: { id: 123, repository_id: 456, head_repository_id: 456, head_branch: 'main', head_sha: input.sourceSha } }] },
  }
}

describe('historical registry verification source boundary', () => {
  test('keeps historical artifact source separate from the current verifier revision', async () => {
    const fixture = sourceFixture(), requests: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname; requests.push(path)
      return Response.json(path.endsWith('/artifacts') ? fixture.artifacts : fixture.run)
    } })
    try {
      const proof = await verifyElementsRegistrySource(input, async path => (await fetch(new URL(path, server.url))).json())
      expect(proof).toEqual({ version: input.version, sourceSha: input.sourceSha, verifierSha: input.verifierSha, sourceCiRunId: '123', sourceCiUrl: 'https://github.com/stacksjs/hq.support/actions/runs/123', artifactId: 789, artifactName: `support-elements-${input.sourceSha}` })
      expect(requests).toEqual(['/actions/runs/123', '/actions/runs/123/artifacts'])
    }
    finally { server.stop(true) }
  })
  test('rejects malformed inputs before accessing GitHub', async () => {
    for (const change of [{ repository: 'other/fork' }, { sourceSha: 'main' }, { verifierSha: 'main' }, { runId: '1; publish' }, { runId: '9999999999999999999999' }, { version: '0.1.0' }]) {
      let reads = 0
      await expect(verifyElementsRegistrySource({ ...input, ...change }, async () => { reads++; return sourceFixture().run })).rejects.toThrow()
      expect(reads).toBe(0)
    }
  })
  test('rejects mismatched runs and artifact ownership without downloading bytes', async () => {
    const mutations: Array<(fixture: ReturnType<typeof sourceFixture>) => void> = [
      fixture => { fixture.run.id = 124 },
      fixture => { fixture.run.head_sha = input.verifierSha },
      fixture => { fixture.run.head_branch = 'other' },
      fixture => { fixture.run.event = 'workflow_dispatch' },
      fixture => { fixture.run.status = 'in_progress' },
      fixture => { fixture.run.conclusion = 'failure' },
      fixture => { fixture.run.path = '.github/workflows/other.yml' },
      fixture => { fixture.run.repository.full_name = 'other/fork' },
      fixture => { fixture.run.head_repository.full_name = 'other/fork' },
      fixture => { fixture.run.head_repository.id = 457 },
      fixture => { fixture.artifacts.total_count = 101 },
      fixture => { fixture.artifacts.artifacts = []; fixture.artifacts.total_count = 0 },
      fixture => { fixture.artifacts.artifacts.push(structuredClone(fixture.artifacts.artifacts[0]!)); fixture.artifacts.total_count = 2 },
      fixture => { fixture.artifacts.artifacts[0]!.expired = true },
      fixture => { fixture.artifacts.artifacts[0]!.id = 0 },
      fixture => { fixture.artifacts.artifacts[0]!.workflow_run.id = 124 },
      fixture => { fixture.artifacts.artifacts[0]!.workflow_run.repository_id = 457 },
      fixture => { fixture.artifacts.artifacts[0]!.workflow_run.head_repository_id = 457 },
      fixture => { fixture.artifacts.artifacts[0]!.workflow_run.head_branch = 'other' },
      fixture => { fixture.artifacts.artifacts[0]!.workflow_run.head_sha = input.verifierSha },
    ]
    for (const mutate of mutations) {
      const fixture = sourceFixture(); mutate(fixture)
      await expect(verifyElementsRegistrySource(input, async path => path.includes('/artifacts') ? fixture.artifacts : fixture.run)).rejects.toThrow()
    }
  })
})

describe('reviewed publication source', () => {
  const archiveSha256 = 'c'.repeat(64)
  const comparePath = `/compare/${input.sourceSha}...${input.verifierSha}?per_page=1`
  const ancestor = { status: 'ahead', base_commit: { sha: input.sourceSha }, merge_base_commit: { sha: input.sourceSha } }

  test('accepts a reviewed main ancestor and returns only its owned artifact', async () => {
    const fixture = sourceFixture(), paths: string[] = []
    const proof = await verifyElementsPublicationSource({ ...input, archiveSha256 }, async path => {
      paths.push(path)
      if (path === comparePath) return ancestor
      return path.includes('/artifacts') ? fixture.artifacts : fixture.run
    })
    expect(paths).toEqual(['/actions/runs/123', '/actions/runs/123/artifacts?per_page=100', comparePath])
    expect(proof.artifactId).toBe(789)
  })

  test('rejects unpinned, diverged or unrelated historical artifacts', async () => {
    for (const digest of [undefined, '', 'not-an-archive-digest'])
      await expect(verifyElementsPublicationSource({ ...input, archiveSha256: digest }, async () => { throw new Error('Unexpected GitHub request') })).rejects.toThrow('requires the reviewed archive SHA-256')
    for (const comparison of [{ ...ancestor, status: 'diverged' }, { ...ancestor, merge_base_commit: { sha: input.verifierSha } }]) {
      const fixture = sourceFixture()
      await expect(verifyElementsPublicationSource({ ...input, archiveSha256 }, async path => path === comparePath ? comparison : path.includes('/artifacts') ? fixture.artifacts : fixture.run)).rejects.toThrow()
    }
  })

  test('accepts the current main candidate without a separate archive pin', async () => {
    const fixture = sourceFixture()
    const proof = await verifyElementsPublicationSource({ ...input, verifierSha: input.sourceSha }, async path => {
      expect(path).not.toContain('/compare/')
      return path.includes('/artifacts') ? fixture.artifacts : fixture.run
    })
    expect(proof.sourceSha).toBe(proof.verifierSha)
  })
})

test('read-only workflow wires the current verifier to the verified historical candidate', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../../.github/workflows/verify-elements-registry.yml', import.meta.url)).text()) as VerificationWorkflow
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['source_sha', 'ci_run_id', 'version'])
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
  const job = workflow.jobs.verify
  expect(Object.keys(workflow.jobs)).toEqual(['verify'])
  expect(job.if).toBe("github.repository == 'stacksjs/hq.support' && github.ref == 'refs/heads/main'")
  expect(job.env).toEqual({ SUPPORT_ELEMENTS_CI_RUN: '${{ inputs.ci_run_id }}', SUPPORT_ELEMENTS_VERSION: '${{ inputs.version }}', SUPPORT_ELEMENTS_SOURCE_SHA: '${{ inputs.source_sha }}', CHROME_PATH: '/usr/bin/google-chrome' })
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  expect(checkout?.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false })
  const download = job.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
  expect(download?.with).toEqual({ 'artifact-ids': '${{ steps.source.outputs.artifact_id }}', path: 'storage/framework/runtime/support-elements-release', 'run-id': '${{ inputs.ci_run_id }}', 'github-token': '${{ github.token }}' })
  const commands = job.steps.filter(step => step.run).map(step => step.run)
  expect(commands).toEqual(['bun install --frozen-lockfile', 'bun --no-env-file scripts/verify-elements-registry-source.ts', 'bun --no-env-file scripts/support-elements-release.ts registry', 'bun --no-env-file scripts/qualify-support-browser.ts --skip-build'])
  const source = job.steps.find(step => step.id === 'source')
  expect(source?.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}' })
  expect(job.steps.find(step => step.run?.includes('qualify-support-browser.ts'))?.env).toEqual({ SUPPORT_BROWSER_ASSETS: 'storage/framework/runtime/support-elements-release/hosted' })
  expect(job.steps.filter(step => step.env?.GITHUB_TOKEN)).toHaveLength(1)
  expect(JSON.stringify(workflow)).not.toContain('secrets.')
  expect(JSON.stringify(workflow)).not.toContain('NPM_TOKEN')
})


test('production requires public npm verification of the same main artifact before loading deploy credentials', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../../.github/workflows/deploy.yml', import.meta.url)).text()) as { jobs: { production: { steps: WorkflowStep[] } } }
  const { steps } = workflow.jobs.production
  const artifact = steps.findIndex(step => step.uses?.startsWith('actions/download-artifact@'))
  const registry = steps.findIndex(step => step.run === 'bun --no-env-file scripts/support-elements-release.ts registry')
  const build = steps.findIndex(step => step.run?.includes('scripts/support-elements-release.ts stage-site'))
  const loadKey = steps.findIndex(step => step.env?.DEPLOY_SSH_KEY)
  const deploy = steps.findIndex(step => step.run?.includes('./buddy deploy --prod --yes'))

  expect(artifact).toBeGreaterThanOrEqual(0)
  expect(registry).toBeGreaterThan(artifact)
  expect(build).toBeGreaterThan(registry)
  expect(loadKey).toBeGreaterThan(build)
  expect(deploy).toBeGreaterThan(loadKey)
  expect(steps[registry]?.env).toEqual({ SUPPORT_ELEMENTS_VERSION: '${{ steps.widget.outputs.version }}', CHROME_PATH: '/usr/bin/google-chrome' })
  expect(steps[registry]?.if).toBeUndefined()
  expect(steps[registry]?.['continue-on-error']).toBeUndefined()
})
